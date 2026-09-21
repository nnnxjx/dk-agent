import { ConfigService } from '@nestjs/config';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpSessionPool } from './mcp-session.pool';

function configServiceWith(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('McpConnectionManager pooled callTool (stage 4)', () => {
  it('reuses pooled session and releases refs', async () => {
    const pool = new McpSessionPool(
      configServiceWith({ 'mcp.enabled': true, 'mcp.idleTtlMs': 60_000 }),
    );
    const fakeClient = {
      // eslint-disable-next-line @typescript-eslint/require-await
      callTool: jest.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
      })),
      // eslint-disable-next-line @typescript-eslint/require-await
      close: jest.fn(async () => undefined),
    };
    const spy = jest.spyOn(pool, 'acquire').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/require-await
      async (key) =>
        ({
          key,
          session: {
            client: fakeClient,
            // eslint-disable-next-line @typescript-eslint/require-await
            close: async () => undefined,
          },
          client: fakeClient,
          status: 'healthy',
          refCount: 1,
          lastUsedAt: Date.now(),
          createdAt: Date.now(),
          failures: 0,
        }) as never,
    );
    const release = jest.spyOn(pool, 'release');
    const manager = new McpConnectionManager(pool);

    const result = await manager.callTool(
      { url: 'http://localhost:3100/mcp' },
      'echo',
      { text: 'hi' },
      { tenantId: 't1', serverId: 's1', configVersion: 1 },
    );
    expect(result.text).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await pool.closeAll();
  });

  it('falls back to one-shot when pool is missing', async () => {
    const manager = new McpConnectionManager(undefined);
    await expect(
      manager.callTool(
        { url: 'http://localhost:1/mcp', connectionTimeoutMs: 200 },
        'echo',
        {},
        { tenantId: 't1', serverId: 's1', configVersion: 1 },
      ),
    ).rejects.toThrow();
  });
});
