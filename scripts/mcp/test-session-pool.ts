/* 阶段 4 联调：池化复用 + 并发单建连 + 失效 + 健康探活 */
import { ConfigService } from '@nestjs/config';
import { McpConnectionManager } from '../../src/mcp/mcp-connection.manager';
import { McpHealthService } from '../../src/mcp/mcp-health.service';
import { McpSessionPool } from '../../src/mcp/mcp-session.pool';

async function main() {
  const url = process.env.MCP_TEST_URL ?? 'http://localhost:3100/mcp';
  const configService = {
    get: (key: string) =>
      ({ 'mcp.enabled': true, 'mcp.idleTtlMs': 30_000 })[key],
  } as unknown as ConfigService;
  const pool = new McpSessionPool(configService);
  const manager = new McpConnectionManager(pool);
  const key = { tenantId: 't1', serverId: 's1', configVersion: 1 };
  const config = { url };

  // 1. 并发借用只建连一次：3 个并发 acquire 命中同一个 in-flight
  const [a, b, c] = await Promise.all([
    manager.acquireSession(key, config),
    manager.acquireSession(key, config),
    manager.acquireSession(key, config),
  ]);
  console.log(
    `Pool size after concurrent acquire: ${pool.size()} refs=${a.refCount}`,
  );
  if (pool.size() !== 1)
    throw new Error('concurrent acquire created more than 1 session');
  manager.releaseSession(a);
  manager.releaseSession(b);
  manager.releaseSession(c);

  // 2. 池化 callTool 复用连接
  const first = await manager.callTool(config, 'echo', { text: 'pool-1' }, key);
  const second = await manager.callTool(
    config,
    'echo',
    { text: 'pool-2' },
    key,
  );
  console.log(
    `Pooled calls: ${first.text} / ${second.text} size=${pool.size()}`,
  );
  if (pool.size() !== 1)
    throw new Error('pooled callTool did not reuse session');

  // 3. 健康探活（轻量 listTools，不新建长连接）
  const health = new McpHealthService(
    // eslint-disable-next-line @typescript-eslint/require-await
    { update: async () => undefined } as never,
    pool,
  );
  const status = await health.probe({
    tenantId: 't1',
    serverId: 's1',
    configVersion: 1,
    config,
  });
  console.log(`Health: ${status} size=${pool.size()}`);

  // 4. 失效后重建：invalidate 删除旧连接，下次调用重建
  const evicted = await manager.invalidateServer('t1', 's1');
  console.log(`Invalidated: ${evicted} size=${pool.size()}`);
  const rebuilt = await manager.callTool(
    config,
    'echo',
    { text: 'after-invalidate' },
    key,
  );
  console.log(`Rebuilt call: ${rebuilt.text} size=${pool.size()}`);

  // 5. 一次性语义保留：testConnection 不走池
  const once = await manager.testConnection(config);
  console.log(
    `One-shot test: ${once.tools.map((t) => t.name).join(',')} size=${pool.size()}`,
  );

  await pool.closeAll();
  console.log(
    `Closed all, size=${pool.size()} leaked=${manager.getLeakedConnections()}`,
  );
  console.log('Stage 4 pool check passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
