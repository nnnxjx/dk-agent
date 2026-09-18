/** 阶段 0 产物：MCP 错误归一化，后续阶段按需扩展细分类型 */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'MCP_CONNECTION_FAILED'
      | 'MCP_INITIALIZE_FAILED'
      | 'MCP_LIST_TOOLS_FAILED'
      | 'MCP_CALL_TOOL_FAILED'
      | 'MCP_TIMEOUT'
      | 'MCP_UNAUTHORIZED'
      | 'MCP_FORBIDDEN'
      | 'MCP_INVALID_CONFIG',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** 连接失败（testConnection 使用） */
export class McpConnectionError extends McpError {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, 'MCP_CONNECTION_FAILED', details);
    this.name = 'McpConnectionError';
  }
}

/** 工具调用失败（callTool 使用） */
export class McpToolCallError extends McpError {
  constructor(
    message: string,
    readonly toolName: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, 'MCP_CALL_TOOL_FAILED', { toolName, ...details });
    this.name = 'McpToolCallError';
  }
}

/** 从未知异常中提取可记录的摘要，调用方负责脱敏后再落日志 */
export function toMcpErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
