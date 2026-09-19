/** 阶段 0-1 产物：MCP 功能开关与默认配额/超时，后续阶段接入 configuration.ts */
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
  /** 单次 listTools 拉取上限：防超大清单污染内存/prompt，超出则 truncated=true */
  maxToolsPerList: 200,
  /** 工具描述进入 prompt 前的上限，超出截断并标注 */
  maxToolDescriptionChars: 2000,
  /** 单个工具 inputSchema JSON 序列化后的上限，超出则拒绝注册该工具 */
  maxToolSchemaBytes: 32_768,
  /** 工具名分段仅允许字母数字下划线，其余字符归一化为下划线 */
  toolNamePattern: /^[A-Za-z0-9_]+$/,
} as const;
