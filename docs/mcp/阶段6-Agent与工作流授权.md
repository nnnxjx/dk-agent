# 阶段 6：Agent 与工作流授权（MCP 工具白名单）

## 模型

- 新表 `mcp_agent_grants`（`tenantId + agentName + qualifiedName` 唯一）
- 白名单语义：只有落在 grant 里的 `mcp__*` 工具才会进入该 Agent 的工具列表；未建 grant 的 Agent 默认无 MCP 工具
- 内置工具（`web_search`、`rag_retrieval`）不受授权约束

## 检查顺序（列表装配与调用入口同一规则）

1. 租户有效（`tool.serverId` 归属当前租户的 Server）
2. Server 已启用且状态非 `disabled`/`unhealthy`
3. Tool 已启用且非 `stale`
4. Agent 已授权（grant 存在）

## 调用链

- Supervisor：`AgentService.executeSupervisor` 按 `tenantId + agentName` 装配授权 MCP 工具；失败降级为空，不影响内置工具
- DAG：`executeDag` 按各 agent 节点名装配并入 `toolsMap`；未授权工具天然不可见
- `tool` 节点直调伪造的 `mcp__` 名：`DagEngine` 拒绝执行并写入 `denied` 文本
- 适配工具调用前：`McpAuthorizationService.checkToolCall` 二次校验，拒绝返回文本，不抛到图外
- 执行走阶段 4 连接池（`tenantId/serverId/configVersion`），`test/refresh/探活` 仍一次性连接

## 接口

- `GET /mcp/agents/:agentName/grants`：查看授权清单
- `PUT /mcp/agents/:agentName/grants { qualifiedNames }`：全量替换；空数组收回全部
- 前端 `mcpApi.agentGrants/setAgentGrants` 已封装，页面授权编辑器待后续迭代

## 数据维护

- 删除 Server 级联清理该命名空间的幽灵授权；禁用即刻失效池连接
- `refresh` 标 `stale` 的工具自动失去授权（检查第 3 步拦截）

## 验证

- `npx jest src/mcp src/tools --runInBand`：10 套件 43 用例通过
- 新增 `mcp-authorization.service.spec.ts` 8 用例：默认拒绝、伪造拒绝、禁用 Server/工具拒绝、完全授权放行、内置豁免、替换语义、清单装配
- `npx tsc --noEmit`：通过
