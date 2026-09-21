import { McpService } from './mcp.service';

/** 构造最小 McpService：只测租户隔离与版本递增，不连真实远端 */
function createService(overrides?: {
  findOne?: (where: unknown) => Promise<unknown>;
  saveServer?: (
    server: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}) {
  const store = new Map<string, Record<string, unknown>>();
  const serverRepo = {
    create: (data: Record<string, unknown>) => ({
      id: 'server-1',
      configVersion: 1,
      ...data,
    }),
    save: async (server: Record<string, unknown>) => {
      const next = {
        ...(overrides?.saveServer
          ? await overrides.saveServer(server)
          : server),
      };
      store.set(String(next.id), next);
      return next;
    },
    find: () => Promise.resolve(Array.from(store.values())),

    findOne: async (opts: { where: { id: string; tenantId: string } }) => {
      if (overrides?.findOne) return overrides.findOne(opts.where);
      const row = store.get(opts.where.id) ?? null;
      // 模拟 TypeORM where { id, tenantId }：租户不一致返回 null，验证隔离逻辑
      if (row && (row as { tenantId: string }).tenantId !== opts.where.tenantId)
        return null;
      return row;
    },
  };
  const toolRepo = {
    // eslint-disable-next-line @typescript-eslint/require-await
    count: async () => 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    find: async () => [],
    // eslint-disable-next-line @typescript-eslint/require-await
    findOne: async () => null,
    // eslint-disable-next-line @typescript-eslint/require-await
    save: async (tool: unknown) => tool,
  };
  const service = new McpService(
    serverRepo as never,
    toolRepo as never,
    {
      transaction: async (fn: (m: unknown) => Promise<unknown>) => fn({}),
    } as never,
    {
      // eslint-disable-next-line @typescript-eslint/require-await
      testConnection: async () => ({ tools: [], durationMs: 1 }),
      // eslint-disable-next-line @typescript-eslint/require-await
      invalidateServer: async () => 0,
    } as never,
    {
      encryptObject: () => null,
      decryptObject: () => undefined,
      maskHeaders: () => ({ configured: false, keys: [] }),
      getKeyVersion: () => 1,
    } as never,
  );
  return { service, store };
}

describe('McpService tenant isolation (stage 3)', () => {
  it('rejects cross-tenant access', async () => {
    const { service, store } = createService();
    store.set('server-1', {
      id: 'server-1',
      tenantId: 'tenant-a',
      alias: 'demo',
      url: 'http://localhost:3100/mcp',
    });
    await expect(service.getServer('tenant-b', 'server-1')).rejects.toThrow();
  });

  it('bumps configVersion when url changes', async () => {
    const { service, store } = createService();
    store.set('server-1', {
      id: 'server-1',
      tenantId: 'tenant-a',
      alias: 'demo',
      url: 'http://localhost:3100/mcp',
      configVersion: 1,
      enabled: true,
    });
    const view = await service.updateServer('tenant-a', 'server-1', {
      url: 'http://localhost:3101/mcp',
    });
    expect(view.configVersion).toBe(2);
    expect(store.get('server-1')?.configVersion).toBe(2);
  });

  it('keeps configVersion when only name changes', async () => {
    const { service, store } = createService();
    store.set('server-1', {
      id: 'server-1',
      tenantId: 'tenant-a',
      alias: 'demo',
      url: 'http://localhost:3100/mcp',
      name: 'old',
      configVersion: 5,
      enabled: true,
    });
    const view = await service.updateServer('tenant-a', 'server-1', {
      name: 'new',
    });
    expect(view.configVersion).toBe(5);
  });

  it('rejects invalid alias', async () => {
    const { service } = createService();
    await expect(
      service.createServer('tenant-a', {
        name: 'x',
        alias: 'Bad Alias!',
        url: 'http://localhost:3100/mcp',
      }),
    ).rejects.toThrow();
  });
});
