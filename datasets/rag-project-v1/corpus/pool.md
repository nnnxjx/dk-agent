# 阶段 4：连接缓存、健康检查和生命周期管理（纯 HTTP）

## 1. 目标

从“每次调用临时连接”升级为可控的运行时连接管理。

## 2. 策略

- 缓存键：`tenantId + serverId + configVersion`，配置变更后旧连接自动失效
- 同键复用一个 Client；并发 acquire 共用 in-flight 建连，不重复建连
- 借用计数 refCount，release 只归还不关闭；idle 超 TTL 后台 sweep 关闭
- test/refresh/探活用一次性连接，不走池
- 池化 callTool 失败即失效该 Server 连接，下次重建，不重试本次调用
- 禁用/删除/更新配置时 `invalidateServer` 即刻失效
- `enableShutdownHooks` 后 `onModuleDestroy` 关闭全部连接与定时器

## 3. 交付

- `src/mcp/mcp-session.pool.ts`：acquire/release、in-flight 锁、idle sweep、invalidate、closeAll
- `src/mcp/mcp-connection.manager.ts`：`callTool(config, name, args, pooled?)`
  传 pooled 走池，不传走一次性；`acquireSession/releaseSession/invalidateServer` 透出
- `src/mcp/mcp-health.service.ts`：池内轻量 `listTools` 探活，连续 3 次失败标 unhealthy 并失效
- `src/mcp/mcp.controller.ts`：新增 `POST /mcp/servers/:id/health`
- `src/mcp/mcp.service.ts`：`probeHealth`（禁用直接返回 disabled；无健康服务时退化 test）
- `src/common/config/configuration.ts`：`mcp.enabled/httpEnabled/connectionTimeoutMs/toolCallTimeoutMs/idleTtlMs`
- `src/main.ts`：`enableShutdownHooks`
- 联调：`scripts/mcp/test-session-pool.ts`

## 4. 状态机

```text
pending -> connecting -> healthy
healthy -> unhealthy（探活连续失败达阈值）
unhealthy -> reconnecting -> healthy（下次调用重建）
healthy -> disabled（禁用即失效）
healthy -> closed（idle 回收/关闭应用）
```

## 5. 验证

```bash
npx jest src/mcp src/tools --runInBand
npx tsc --noEmit -p tsconfig.json
npx ts-node --transpile-only scripts/mcp/test-http-server.ts
MCP_TEST_URL=http://localhost:3100/mcp npx ts-node --transpile-only scripts/mcp/test-session-pool.ts
```

预期：并发 acquire 只建连 1 次；池化调用复用；探活 healthy；
失效后重建；一次性 test 不污染池；关闭后 size=0、leaked=0。

## 6. 给阶段 5/6 的接口

- Agent 运行时调用：`callTool(config, name, args, { tenantId, serverId, configVersion })`
- 管理侧：`POST :id/health` 探活；`refresh-tools` 仍走一次性连接
- 阶段 6 授权在 `ToolRegistry.getAvailableTools` 加过滤，调用时带 pooled 上下文即可复用连接
