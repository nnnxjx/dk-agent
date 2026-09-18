/**
 * 阶段 0 产物：MCP 连接配置类型（纯 HTTP 版）
 * 只描述 Streamable HTTP，不包含 stdio。
 */
export interface McpHttpConnectionConfig {
  /** 远端 MCP Server 的 Streamable HTTP 地址，例如 https://mcp.example.com/mcp */
  url: string;
  /** 随请求发送的鉴权头，key 仅允许白名单，value 在落库时必须加密 */
  headers?: Record<string, string>;
  /** 通用超时（毫秒），兼容旧调用方；与 connectionTimeoutMs 同时存在时以后者为准 */
  timeoutMs?: number;
  /** 连接建立超时（毫秒），默认 10000 */
  connectionTimeoutMs?: number;
  /** 单次工具调用超时（毫秒），默认 60000 */
  toolCallTimeoutMs?: number;
  /** MCP Client 上报名称，便于服务端识别 */
  clientName?: string;
  /** MCP Client 上报版本 */
  clientVersion?: string;
}

/** 别名：保持与 McpConnectionManager / McpUtils / 测试脚本一致 */
export type McpConnectionConfig = McpHttpConnectionConfig;

export interface McpToolInfo {
  name: string;
  description?: string;
  /** 远端原始 inputSchema，原样透传；解析/执行归阶段 2 工具适配层负责 */
  inputSchema?: Record<string, unknown>;
}

export interface McpConnectionResult {
  tools: McpToolInfo[];
  durationMs: number;
  /** listTools 分页是否被截断（达到 maxTools 上限） */
  truncated?: boolean;
}

/** callTool 归一化后的调用结果（文本 + 元信息） */
export interface McpToolCallResult {
  text: string;
  isError: boolean;
  truncated: boolean;
  blockCount: number;
  structuredContent?: Record<string, unknown>;
}

/** 阶段 0 约定的 MCP 日志上下文，不含敏感字段 */
export interface McpLogContext {
  tenantId?: string;
  serverId?: string;
  toolName?: string;
  runId?: string;
  durationMs?: number;
}
