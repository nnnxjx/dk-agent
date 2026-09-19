import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_CONSTANTS } from './mcp.constants';
import { McpError } from './errors/mcp.errors';
import { McpConnectionConfig } from './interfaces/mcp-config.interface';
import { normalizeMcpHeaders, normalizeMcpUrl } from './mcp-connection.utils';

/**
 * 阶段 1：Streamable HTTP 传输工厂（纯 HTTP）
 * 每次调用都新建 Client + Transport；已 connect 的 transport 绝不复用。
 */
export interface McpClientSession {
  client: Client;
  /** 必须调用，用于释放底层 HTTP/SSE 连接 */
  close: () => Promise<void>;
}

export function createStreamableHttpTransport(
  config: McpConnectionConfig,
): StreamableHTTPClientTransport {
  const parsedUrl = normalizeMcpUrl(config.url);
  const headers = normalizeMcpHeaders(config.headers);
  return new StreamableHTTPClientTransport(parsedUrl, {
    ...(headers ? { requestInit: { headers } } : {}),
  });
}

export function createMcpClient(config: McpConnectionConfig): Client {
  // 校验前置，避免创建无用 Client
  normalizeMcpUrl(config.url);
  normalizeMcpHeaders(config.headers);
  return new Client(
    {
      name: config.clientName ?? MCP_CONSTANTS.defaultClientName,
      version: config.clientVersion ?? MCP_CONSTANTS.defaultClientVersion,
    },
    { capabilities: {} },
  );
}

export async function connectMcpClient(
  config: McpConnectionConfig,
  timeoutMs: number,
): Promise<McpClientSession> {
  const client = createMcpClient(config);
  // 关键约束：每次连接都新建 transport，已启动的 transport 不可复用
  const transport = createStreamableHttpTransport(config);
  let connected = false;
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'MCP connect');
    connected = true;
    return {
      client,
      close: () => closeMcpClient(client),
    };
  } catch (error) {
    // connect 失败也要尽力释放，避免残留 socket；是否泄漏由调用方计数器判定
    await closeMcpClient(client).catch(() => undefined);
    throw toTransportError(error, connected);
  }
}

export async function closeMcpClient(client: Client): Promise<void> {
  await client.close().catch(() => undefined);
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new McpError(`${label} timed out after ${ms}ms`, 'MCP_TIMEOUT')),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toTransportError(error: unknown, connected: boolean): McpError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return new McpError(message, 'MCP_UNAUTHORIZED', error);
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return new McpError(message, 'MCP_FORBIDDEN', error);
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new McpError(message, 'MCP_TIMEOUT', error);
  }
  return new McpError(
    message,
    connected ? 'MCP_INITIALIZE_FAILED' : 'MCP_CONNECTION_FAILED',
    error,
  );
}
