/** 阶段 0 产物：MCP 功能开关与默认超时，后续阶段接入 configuration.ts */
export const MCP_CONSTANTS = {
  /** 总开关：关闭后不创建任何 MCP 连接，不影响内置工具 */
  enabledEnv: 'MCP_ENABLED',
  /** HTTP 远程连接开关 */
  httpEnabledEnv: 'MCP_HTTP_ENABLED',
  defaultClientName: 'nest-agent-mcp-client',
  defaultClientVersion: '0.0.1',
  defaultConnectionTimeoutMs: 10_000,
  defaultToolCallTimeoutMs: 60_000,
  /** 允许随请求发送的鉴权头白名单 */
  allowedHeaderNames: ['authorization', 'x-api-key'],
} as const;
