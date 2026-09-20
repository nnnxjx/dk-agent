import { McpConnectionConfig } from './interfaces/mcp-config.interface';
import { MCP_CONSTANTS } from './mcp.constants';
import { McpError } from './errors/mcp.errors';

export const MCP_ALLOWED_HEADER_KEYS = ['authorization', 'x-api-key'];

export function normalizeMcpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpError(`Invalid MCP server url: ${url}`, 'MCP_INVALID_CONFIG');
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new McpError(
      'MCP server url must use https in non-local environments',
      'MCP_INVALID_CONFIG',
    );
  }
  return parsed;
}

export function sanitizeMcpConfigForLog(config: McpConnectionConfig): {
  url: string;
  hasHeaders: boolean;
  timeoutMs?: number;
} {
  const parsed = new URL(config.url);
  parsed.search = '';
  return {
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    hasHeaders: Boolean(
      config.headers && Object.keys(config.headers).length > 0,
    ),
    timeoutMs: config.connectionTimeoutMs ?? config.timeoutMs,
  };
}

export function normalizeMcpHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    if (
      !(MCP_CONSTANTS.allowedHeaderNames as readonly string[]).includes(
        key.toLowerCase(),
      )
    ) {
      throw new McpError(`Disallowed MCP header: ${key}`, 'MCP_INVALID_CONFIG');
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function toMcpErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

export function resolveMcpTimeoutMs(
  config: McpConnectionConfig,
  fallback: number,
): number {
  return config.connectionTimeoutMs ?? config.timeoutMs ?? fallback;
}
