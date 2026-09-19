# 阶段 2：MCP 工具适配到 ToolRegistry（纯 HTTP）

## 1. 目标

让现有 Supervisor 和 DAG 只通过统一工具注册接口使用 MCP 工具，不改 Agent 协议与 AG-UI 事件链路。

## 2. 交付

- `src/mcp/mcp-tool.adapter.ts`
  - `buildMcpQualifiedName(serverAlias, toolName)`：`mcp__<alias>__<tool>`，分段小写归一化
  - `adaptMcpToolToLangChain`：远端工具 -> `DynamicStructuredTool`
  - `adaptMcpServerTools`：批量适配，单工具失败跳过并记录原因
- `src/tools/tool-registry.ts`
  - 内置工具与 MCP 工具分区存放：`builtinTools` / `mcpTools`
  - `registerMcpTool`：必须 `mcp__` 前缀；冲突拒绝覆盖并告警
  - `unregisterMcpToolsByAlias`：按 Server 别名前缀移除（刷新/禁用用）
  - `getAvailableTools(context)`：统一入口，阶段 6 在此加授权过滤
- 单测：`mcp-tool.adapter.spec.ts`、`tool-registry.mcp.spec.ts`
- 联调：`scripts/mcp/test-tool-adapter.ts`

## 3. 关键约束（已验证）

1. 远端 `inputSchema` 仅做形状校验与大小上限（32KB），不做 zod 转换与代码生成。
2. `DynamicStructuredTool` 的 JSON Schema 走 `@cfworker/json-schema` 校验：
   传 JSON 字符串会被判 schema 不匹配。因此 DAG `tool` 节点如需调 MCP 工具，
   应传对象而非 `JSON.stringify` 后的字符串；当前 `DagEngine` 的 tool 节点仍是
   `tool.invoke(JSON.stringify(...))`，阶段 6 授权时再统一收口该语义。
3. 工具执行失败返回错误文本，不抛到图外，避免整图中断。
4. 描述超 2000 字符截断并标注；返回文本沿用阶段 1 截断标记。

## 4. 数据流

```text
testConnection -> McpToolInfo[]（含 inputSchema）
  -> adaptMcpServerTools -> DynamicStructuredTool[]（mcp__alias__tool）
  -> ToolRegistry.registerMcpTools（防覆盖）
  -> Supervisor: getByNames / DAG: getAll / getAvailableTools
  -> tool.invoke(对象参数) -> manager.callTool -> normalizer.text
  -> on_tool_end -> TOOL_CALL_RESULT（现有 AG-UI 链路不变）
```

## 5. 验证

```bash
npx jest src/mcp src/tools --runInBand
npx tsc --noEmit -p tsconfig.json
npx ts-node --transpile-only scripts/mcp/test-http-server.ts
MCP_TEST_URL=http://localhost:3100/mcp npx ts-node --transpile-only scripts/mcp/test-tool-adapter.ts
```

预期：发现 `echo/fail/big`，适配为 `mcp__demo__echo/fail/big`，
直调返回 `echo: hello-adapter`，泄漏为 0。

## 6. 给阶段 3 的接口

- 阶段 3 落库的是 `McpToolInfo + connection(url/headers/超时)`，适配层保持无状态
- 刷新工具 = `testConnection` 重拉 -> `unregisterMcpToolsByAlias` -> 重新 `adapt + register`
- 阶段 6 在 `getAvailableTools` 内加租户/Server/工具/策略四层过滤
