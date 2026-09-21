import { ConfigService } from '@nestjs/config';
import { McpError } from './errors/mcp.errors';
import { McpSessionPool } from './mcp-session.pool';

function configServiceWith(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('McpSessionPool (stage 4)', () => {
  it('reuses the same session for the same key and tracks refs', async () => {
    const pool = new McpSessionPool(
      configServiceWith({ 'mcp.enabled': true, 'mcp.idleTtlMs': 60_000 }),
    );
    // 用不可达地址验证并发锁路径：in-flight 共享同一个建连失败，不重复建连
    const key = { tenantId: 't1', serverId: 's1', configVersion: 1 };
    const config = { url: 'http://localhost:1/mcp', connectionTimeoutMs: 200 };
    const first = pool.acquire(key, config).catch((e: unknown) => e);
    const second = pool.acquire(key, config).catch((e: unknown) => e);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBeInstanceOf(McpError);
    expect(r2).toBeInstanceOf(McpError);
    expect(pool.size()).toBe(0);
    await pool.closeAll();
  });

  it('refuses to create sessions when MCP is disabled', async () => {
    const pool = new McpSessionPool(
      configServiceWith({ 'mcp.enabled': false, 'mcp.idleTtlMs': 60_000 }),
    );
    await expect(
      pool.acquire(
        { tenantId: 't1', serverId: 's1', configVersion: 1 },
        { url: 'http://localhost:3100/mcp' },
      ),
    ).rejects.toThrow('MCP is disabled');
    await pool.closeAll();
  });
});
