# 阶段 3：持久化配置与管理 API（纯 HTTP）

## 1. 目标

支持租户管理员通过 API 管理 MCP Server，不再依赖代码配置。

## 2. 数据模型

- `mcp_servers`（`src/entities/mcp-server.entity.ts`）
  - `tenantId + alias` 唯一；`alias` 即工具命名空间，仅 `^[a-z0-9_]{2,48}$`
  - `url` 明文存，`headers` 经 `McpCredentialsService` AES-256-GCM 加密后存 `headers_encrypted`
  - `enabled/status/lastConnectedAt/lastCheckedAt/lastError/configVersion`
- `mcp_tools`（`src/entities/mcp-tool.entity.ts`）
  - `serverId + name` 唯一；`qualifiedName = mcp__alias__tool`
  - `inputSchema/schemaHash/enabled/stale/lastSeenAt`
- `synchronize` 非生产自动建表；生产走迁移（本阶段未新增 migration 文件，沿用现有建表策略）

## 3. 接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/mcp/servers` | 创建 |
| `GET` | `/mcp/servers` | 当前租户列表（含 toolCount） |
| `GET` | `/mcp/servers/:id` | 详情（脱敏） |
| `PUT` | `/mcp/servers/:id` | 更新；URL/headers/超时变更递增 configVersion |
| `DELETE` | `/mcp/servers/:id` | 删除配置与工具快照 |
| `POST` | `/mcp/servers/:id/test` | 一次性连接测试，用完 close |
| `POST` | `/mcp/servers/:id/refresh-tools` | 事务刷新：upsert + 缺失标 stale |
| `POST` | `/mcp/servers/:id/enable` | 启用 |
| `POST` | `/mcp/servers/:id/disable` | 禁用 |
| `GET` | `/mcp/servers/:id/tools` | 工具清单 |
| `PATCH` | `/mcp/tools/:id` | 启用/禁用单个工具 |

全部 `JwtAuthGuard + TenantGuard`，所有查询强制带 `tenantId`。

## 4. 安全

- 密钥只来自 `MCP_CREDENTIALS_KEY`（64 hex）；生产未设置直接拒绝加解密
- 落库格式 `v<version>:<iv>:<tag>:<cipher>`，篡改直接抛错
- 前端只看到 `{ configured, keys }`，不回显值；日志与错误只记脱敏摘要
- URL 复用阶段 1 校验：非本地强制 https；headers 复用白名单

## 5. 验证

```bash
npx jest src/mcp --runInBand
npx tsc --noEmit -p tsconfig.json
npx eslint "src/mcp/**/*.ts" "src/entities/mcp-*.entity.ts"
```

覆盖：加解密往返、篡改拒绝、脱敏不泄露、跨租户拒绝、URL 变更递增版本、
仅改名不递增、alias 非法拒绝。

## 6. 给阶段 4 的接口

- `configVersion` 已在更新时递增，阶段 4 按 `tenantId + serverId + configVersion` 做缓存键
- `deleteServer` 处已留注释：阶段 4 缓存落地后在此失效对应连接
- `refreshTools` 返回 `{ added, updated, stale, total, truncated }`，前端可直接展示
