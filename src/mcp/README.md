# MCP 模块（阶段 0：基线确认）

本目录当前只做阶段 0 目标：确认工具链路、锁定 SDK 版本、沉淀最小连接能力。

## 工具调用链路（现状）

```text
AgentService.execute()
├── workflowId 为空 -> executeSupervisor()
│   ├── ToolRegistry.getByNames(['web_search']) 取内置 web_search
│   ├── createRagRetrievalTool(ragService, tenantId) 动态创建 rag_retrieval
│   ├── SupervisorFactory.createSupervisorGraph(llm, agentDefs)
│   └── processStreamEvents() 把 streamEvents 转成 AG-UI 事件
└── workflowId 非空 -> executeDag()
    ├── WorkflowService.findById(workflowId, tenantId)
    ├── toolsMap = ToolRegistry.getAll()
    ├── DagEngine.compile(nodes, edges, { llm, tools, onEvent })
    └── processStreamEvents() 同上
```

关键结论：

- Supervisor 和 DAG 都不直接感知 MCP，只从 `ToolRegistry` 取 `StructuredToolInterface`。
- 阶段 2 只需扩展 `ToolRegistry.getAvailableTools(context)`，Agent 侧无需改协议。
- AG-UI 的工具事件由 `processStreamEvents` 从 `streamEvents` 派生：
  `TOOL_CALL_START -> TOOL_CALL_ARGS -> TOOL_CALL_END -> TOOL_CALL_RESULT`。
- MCP 工具只要包装成标准 LangChain 工具，就能自动进入现有事件流。

## SDK 版本

- 包：`@modelcontextprotocol/sdk`
- 已锁定：`1.30.0`（见根 `package.json`）
- 客户端入口：`@modelcontextprotocol/sdk/client/index.js` 的 `Client`
- HTTP 传输：`@modelcontextprotocol/sdk/client/streamableHttp.js` 的 `StreamableHTTPClientTransport`
- Node 版本：`v22.22.0`，pnpm `10.34.1`

只用 Streamable HTTP，不引入 stdio，不启动子进程。
当前 `tsconfig` 为 `nodenext`，MCP SDK 为纯 ESM 包，因此客户端与测试脚本
统一用 `.js` 后缀显式导入（如 `.../index.js`），避免 CommonJS `require` 误判。

## 本目录文件

- `interfaces/mcp-config.interface.ts`：HTTP 连接配置与连接结果类型
- `errors/mcp.errors.ts`：错误归一化（`McpError` / `McpConnectionError` / `McpToolCallError`）
- `mcp.constants.ts`：开关名、默认超时、鉴权头白名单
- `mcp-connection.utils.ts`：URL 校验、请求头白名单、日志脱敏、超时解析
- `mcp-connection.manager.ts`：一次性连接管理（testConnection/callTool，用完即 close）
- `mcp.connection.spec.ts`：阶段 0 基线单测（URL/请求头校验，不触碰内置工具）
- `mcp.module.ts`：仅导出 `McpConnectionManager`，尚未接入 `AppModule`

## 本地测试 MCP Server

阶段 0 用已安装 SDK 自带的 `McpServer + StreamableHTTPServerTransport`
起一个最小 HTTP 服务，验证 `connect -> listTools -> callTool -> close`。

- 服务脚本：`scripts/mcp/test-http-server.ts`
- 客户端脚本：`scripts/mcp/test-http-connection.ts`
- 说明见 `docs/mcp/阶段0-本地联调.md`

## 日志字段约定

- `tenantId`、`serverId`、`toolName`、`runId`、`durationMs`
- 禁止记录完整 URL query、Authorization、API Key
- 错误只记脱敏摘要（见 `mcp-connection.utils.ts` 的 `toMcpErrorSummary`）
