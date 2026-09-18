# MCP 模块（阶段 1：单 Server 连接适配层）

纯 HTTP，不接数据库、不进 ToolRegistry、不做连接缓存。

## 文件

- `interfaces/mcp-config.interface.ts`：连接配置、`McpToolInfo`（含 `inputSchema`）、`McpToolCallResult`
- `errors/mcp.errors.ts`：`McpError / McpConnectionError / McpToolCallError`
- `mcp.constants.ts`：开关、超时、`maxToolsPerList=200`
- `mcp-connection.utils.ts`：URL/请求头校验、日志脱敏
- `mcp-transport.factory.ts`：每次新建 Client + Transport，建连超时，失败释放
- `mcp-result.normalizer.ts`：多内容块归一化、截断标记、structuredContent 透传
- `mcp-connection.manager.ts`：`testConnection`（分页）、`callTool`（归一化+isError抛错）、泄漏计数
- `mcp.module.ts`：仅导出 Manager，未接入 AppModule

## 单测

```bash
npx jest src/mcp --runInBand
```

覆盖：URL/请求头校验、transport 每次新建、非法配置前置拒绝、
多内容块归一化、isError、超长截断、structuredContent 回退。

## 联调

```bash
npx ts-node --transpile-only scripts/mcp/test-http-server.ts
MCP_TEST_URL=http://localhost:3100/mcp npx ts-node --transpile-only scripts/mcp/test-http-connection.ts
```

测试服务提供 `echo / fail(isError) / big(超长)`，客户端验证正常调用、
截断、isError 抛错、工具不存在抛错、泄漏计数为 0。

## 给阶段 2 的接口

- `testConnection` 返回工具清单（含 `inputSchema`）与 `truncated`
- `callTool` 返回 `{ text, isError, truncated, blockCount, structuredContent }`
- 日志只记脱敏后的 URL，不记 Authorization/API Key
