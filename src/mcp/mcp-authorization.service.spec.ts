import { McpAuthorizationService } from './mcp-authorization.service';

interface Row {
  [k: string]: unknown;
}

/* eslint-disable @typescript-eslint/require-await */
function fakeRepo(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  return {
    rows,
    find: jest.fn(async (opts?: { where?: Row }) => {
      if (!opts?.where) return [...rows];
      return rows.filter((r) =>
        Object.entries(opts.where as Row).every(([k, v]) => r[k] === v),
      );
    }),
    findOne: jest.fn(async (opts: { where: Row }) => {
      return (
        rows.find((r) =>
          Object.entries(opts.where).every(([k, v]) => r[k] === v),
        ) ?? null
      );
    }),
    create: jest.fn((data: Row) => ({ ...data })),
    save: jest.fn(async (data: Row | Row[]) => {
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        const idx = rows.findIndex(
          (r) =>
            r.tenantId === item.tenantId &&
            r.agentName === item.agentName &&
            r.qualifiedName === item.qualifiedName,
        );
        if (idx >= 0) rows[idx] = { ...rows[idx], ...item };
        else rows.push({ ...item });
      }
      return data;
    }),
    remove: jest.fn(async (data: Row | Row[]) => {
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        const idx = rows.indexOf(item);
        if (idx >= 0) rows.splice(idx, 1);
      }
      return data;
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        innerJoin: jest.fn(() => qb),
        select: jest.fn(() => qb),
        getMany: jest.fn(async () => []),
        getRawMany: jest.fn(async () => []),
      };
      return qb;
    }),
  };
}

const TENANT = 'tenant-a';

function serviceWith(opts: {
  servers?: Row[];
  tools?: Row[];
  grants?: Row[];
  allowedRows?: Row[];
}) {
  const serverRepo = fakeRepo(opts.servers);
  const toolRepo = fakeRepo(opts.tools);
  const grantRepo = fakeRepo(opts.grants);
  if (opts.allowedRows) {
    (toolRepo.createQueryBuilder as jest.Mock).mockImplementation(() => {
      const qb: Record<string, jest.Mock> = {
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        innerJoin: jest.fn(() => qb),
        select: jest.fn(() => qb),
        getMany: jest.fn(async () => []),
        getRawMany: jest.fn(async () => opts.allowedRows),
      };
      return qb;
    });
  }
  const service = new McpAuthorizationService(
    serverRepo as never,
    toolRepo as never,
    grantRepo as never,
  );
  return { service, serverRepo, toolRepo, grantRepo };
}

describe('McpAuthorizationService (stage 6)', () => {
  it('denies ungranted tools (default deny)', async () => {
    const { service } = serviceWith({
      servers: [
        {
          id: 's1',
          tenantId: TENANT,
          alias: 'demo',
          enabled: true,
          status: 'healthy',
        },
      ],
      tools: [
        {
          id: 't1',
          serverId: 's1',
          qualifiedName: 'mcp__demo__echo',
          enabled: true,
          stale: false,
        },
      ],
      grants: [],
    });
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'mcp__demo__echo',
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies forged tool names (not in tenant)', async () => {
    const { service } = serviceWith({
      servers: [],
      tools: [],
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__evil__tool',
        },
      ],
    });
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'mcp__evil__tool',
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies tools on disabled servers', async () => {
    const { service } = serviceWith({
      servers: [
        {
          id: 's1',
          tenantId: TENANT,
          alias: 'demo',
          enabled: false,
          status: 'disabled',
        },
      ],
      tools: [
        {
          id: 't1',
          serverId: 's1',
          qualifiedName: 'mcp__demo__echo',
          enabled: true,
          stale: false,
        },
      ],
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__demo__echo',
        },
      ],
    });
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'mcp__demo__echo',
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies disabled or stale tools', async () => {
    const { service } = serviceWith({
      servers: [
        {
          id: 's1',
          tenantId: TENANT,
          alias: 'demo',
          enabled: true,
          status: 'healthy',
        },
      ],
      tools: [
        {
          id: 't1',
          serverId: 's1',
          qualifiedName: 'mcp__demo__echo',
          enabled: false,
          stale: false,
        },
      ],
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__demo__echo',
        },
      ],
    });
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'mcp__demo__echo',
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('allows fully authorized tools', async () => {
    const { service } = serviceWith({
      servers: [
        {
          id: 's1',
          tenantId: TENANT,
          alias: 'demo',
          enabled: true,
          status: 'healthy',
        },
      ],
      tools: [
        {
          id: 't1',
          serverId: 's1',
          qualifiedName: 'mcp__demo__echo',
          enabled: true,
          stale: false,
        },
      ],
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__demo__echo',
        },
      ],
    });
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'mcp__demo__echo',
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('never blocks builtin tools', async () => {
    const { service } = serviceWith({});
    await expect(
      service.checkToolCall(
        { tenantId: TENANT, agentName: 'researcher' },
        'web_search',
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('setAgentGrants replaces the allowlist', async () => {
    const { service, grantRepo } = serviceWith({
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__demo__old',
        },
      ],
    });
    await service.setAgentGrants(TENANT, 'researcher', ['mcp__demo__echo']);
    await expect(
      service.listAgentGrants(TENANT, 'researcher'),
    ).resolves.toEqual(['mcp__demo__echo']);
    expect(
      grantRepo.rows.some((r) => r.qualifiedName === 'mcp__demo__old'),
    ).toBe(false);
  });

  it('listAllowedTools returns only joined rows', async () => {
    const { service } = serviceWith({
      grants: [
        {
          tenantId: TENANT,
          agentName: 'researcher',
          qualifiedName: 'mcp__demo__echo',
        },
      ],
      allowedRows: [
        {
          id: 't1',
          serverId: 's1',
          name: 'echo',
          qualifiedName: 'mcp__demo__echo',
          description: 'Echo',
          inputSchema: null,
          alias: 'demo',
          configVersion: 3,
        },
      ],
    });
    await expect(
      service.listAllowedTools({ tenantId: TENANT, agentName: 'researcher' }),
    ).resolves.toEqual([
      {
        serverId: 's1',
        serverAlias: 'demo',
        configVersion: 3,
        toolId: 't1',
        name: 'echo',
        qualifiedName: 'mcp__demo__echo',
        description: 'Echo',
        inputSchema: null,
      },
    ]);
  });
});
