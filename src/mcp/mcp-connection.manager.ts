import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_CONSTANTS } from './mcp.constants';
import {
  McpConnectionError,
  McpError,
  McpToolCallError,
} from './errors/mcp.errors';
import {
  McpConnectionConfig,
  McpConnectionResult,
} from './interfaces/mcp-config.interface';
import {
  normalizeMcpHeaders,
  normalizeMcpUrl,
  resolveMcpTimeoutMs,
  sanitizeMcpConfigForLog,
  toMcpErrorSummary,
} from './mcp-connection.utils';

/**
 * 阶段 0：一次性 HTTP 连接管理（纯 HTTP，不做缓存、不接数据库）
 * 每次调用新建 Client + Transport，用完即 close；已启动的 transport 不复用。
 */
@Injectable()
export class McpConnectionManager {
  private readonly logger = new Logger(McpConnectionManager.name);

  async testConnection(
    config: McpConnectionConfig,
  ): Promise<McpConnectionResult> {
    const startedAt = Date.now();
    this.logger.log(
      `Testing MCP connection: ${JSON.stringify(sanitizeMcpConfigForLog(config))}`,
    );

    const parsedUrl = normalizeMcpUrl(config.url);
    const headers = normalizeMcpHeaders(config.headers);
    const timeoutMs = resolveMcpTimeoutMs(
      config,
      MCP_CONSTANTS.defaultConnectionTimeoutMs,
    );
    const client = new Client({
      name: MCP_CONSTANTS.defaultClientName,
      version: MCP_CONSTANTS.defaultClientVersion,
    });
    const transport = new StreamableHTTPClientTransport(parsedUrl, {
      ...(headers ? { requestInit: { headers } } : {}),
    });

    try {
      await this.withTimeout(
        client.connect(transport),
        timeoutMs,
        'MCP connect',
      );
      const { tools } = await this.withTimeout(
        client.listTools(),
        timeoutMs,
        'MCP listTools',
      );
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw this.toConnectionError(error);
    } finally {
      await client.close().catch((error: unknown) => {
        this.logger.warn(
          `Failed to close MCP test connection: ${toMcpErrorSummary(error)}`,
        );
      });
    }
  }

  async callTool(
    config: McpConnectionConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    this.logger.log(
      `Calling MCP tool "${toolName}": ${JSON.stringify(sanitizeMcpConfigForLog(config))}`,
    );
    const parsedUrl = normalizeMcpUrl(config.url);
    const headers = normalizeMcpHeaders(config.headers);
    const timeoutMs = resolveMcpTimeoutMs(
      config,
      MCP_CONSTANTS.defaultToolCallTimeoutMs,
    );
    const client = new Client({
      name: MCP_CONSTANTS.defaultClientName,
      version: MCP_CONSTANTS.defaultClientVersion,
    });
    const transport = new StreamableHTTPClientTransport(parsedUrl, {
      ...(headers ? { requestInit: { headers } } : {}),
    });

    try {
      await this.withTimeout(
        client.connect(transport),
        timeoutMs,
        'MCP connect',
      );
      const result = await this.withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        timeoutMs,
        'MCP callTool',
      );
      const text = (result.content as Array<{ type?: string; text?: string }>)
        .filter(
          (block) => block?.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text as string)
        .join('\n');
      return text || JSON.stringify(result.content);
    } catch (error) {
      if (error instanceof McpError) {
        throw new McpToolCallError(toMcpErrorSummary(error), toolName, {
          code: error.code,
        });
      }
      throw new McpToolCallError(toMcpErrorSummary(error), toolName);
    } finally {
      await client.close().catch((error: unknown) => {
        this.logger.warn(
          `Failed to close MCP tool connection: ${toMcpErrorSummary(error)}`,
        );
      });
    }
  }

  private toConnectionError(error: unknown): McpConnectionError {
    const summary = toMcpErrorSummary(error);
    const lower = summary.toLowerCase();
    if (lower.includes('401') || lower.includes('unauthorized')) {
      return new McpConnectionError(`MCP unauthorized: ${summary}`);
    }
    if (lower.includes('403') || lower.includes('forbidden')) {
      return new McpConnectionError(`MCP forbidden: ${summary}`);
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return new McpConnectionError(`MCP timeout: ${summary}`);
    }
    return new McpConnectionError(summary);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new McpError(`${label} timed out after ${ms}ms`, 'MCP_TIMEOUT'),
          ),
        ms,
      );
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
