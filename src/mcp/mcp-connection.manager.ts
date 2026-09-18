import { Injectable, Logger } from '@nestjs/common';
import { MCP_CONSTANTS } from './mcp.constants';
import { McpConnectionError, McpError, McpToolCallError } from './errors/mcp.errors';
import {
  McpConnectionConfig,
  McpConnectionResult,
  McpToolCallResult,
} from './interfaces/mcp-config.interface';
import {
  normalizeMcpUrl,
  resolveMcpTimeoutMs,
  sanitizeMcpConfigForLog,
  toMcpErrorSummary,
} from './mcp-connection.utils';
import { normalizeMcpCallResult } from './mcp-result.normalizer';
import { connectMcpClient, withTimeout } from './mcp-transport.factory';

/**
 * 阶段 1：单 Server 连接适配层（纯 HTTP，不做缓存、不接数据库）
 * 每次调用新建 Client + Transport，用完即 close；已启动的 transport 不复用。
 */
@Injectable()
export class McpConnectionManager {
  private readonly logger = new Logger(McpConnectionManager.name);
  /** 未正常关闭的连接计数：close 抛错或流程异常时 +1，用于测试与监控 */
  private leakedConnections = 0;

  getLeakedConnections(): number {
    return this.leakedConnections;
  }

  async testConnection(config: McpConnectionConfig): Promise<McpConnectionResult> {
    const startedAt = Date.now();
    this.logger.log(`Testing MCP connection: ${JSON.stringify(sanitizeMcpConfigForLog(config))}`);

    const timeoutMs = resolveMcpTimeoutMs(config, MCP_CONSTANTS.defaultConnectionTimeoutMs);
    const maxTools = MCP_CONSTANTS.maxToolsPerList;
    const session = await this.connect(config, timeoutMs);
    try {
      // SDK 的 listTools 已自动处理分页；此处用 cursor 循环兜底并设上限，避免超大清单
      const tools: McpConnectionResult['tools'] = [];
      let cursor: string | undefined;
      let truncated = false;
      do {
        const page = await withTimeout(
          session.client.listTools(cursor ? { cursor } : undefined),
          timeoutMs,
          'MCP listTools',
        );
        for (const tool of (page as { tools: McpConnectionResult['tools'] }).tools ?? []) {
          if (tools.length >= maxTools) {
            truncated = true;
            break;
          }
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          });
        }
        if (truncated) break;
        cursor = page.nextCursor;
      } while (cursor);

      return { tools, durationMs: Date.now() - startedAt, truncated };
    } catch (error) {
      throw this.toConnectionError(error);
    } finally {
      await this.closeSession(session, 'test');
    }
  }

  /**
   * 调用远端工具并返回归一化文本。
   * 兼容旧签名：此前返回 string，现返回 McpToolCallResult（仍可通过 .text 取文本）。
   */
  async callTool(
    config: McpConnectionConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    this.logger.log(`Calling MCP tool "${toolName}": ${JSON.stringify(sanitizeMcpConfigForLog(config))}`);
    // 先做 URL 格式校验，避免无效配置走到建连
    normalizeMcpUrl(config.url);
    const connectTimeoutMs = resolveMcpTimeoutMs(config, MCP_CONSTANTS.defaultConnectionTimeoutMs);
    const callTimeoutMs =
      config.toolCallTimeoutMs ?? config.timeoutMs ?? MCP_CONSTANTS.defaultToolCallTimeoutMs;
    const session = await this.connect(config, connectTimeoutMs);
    try {
      const result = await withTimeout(
        session.client.callTool({ name: toolName, arguments: args }),
        callTimeoutMs,
        'MCP callTool',
      );
      const normalized = normalizeMcpCallResult(result.content, {
        isError: (result as { isError?: boolean }).isError,
        structuredContent: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
      });
      if (normalized.isError) {
        throw new McpToolCallError(`MCP tool "${toolName}" returned isError: ${normalized.text}`, toolName, {
          truncated: normalized.truncated,
          blockCount: normalized.blockCount,
        });
      }
      return normalized;
    } catch (error) {
      if (error instanceof McpToolCallError) throw error;
      if (error instanceof McpError) {
        throw new McpToolCallError(toMcpErrorSummary(error), toolName, { code: error.code });
      }
      throw new McpToolCallError(toMcpErrorSummary(error), toolName);
    } finally {
      await this.closeSession(session, 'tool');
    }
  }

  /** 建连失败归一化：连接失败与初始化失败分开，401/403/超时显式映射 */
  private async connect(config: McpConnectionConfig, timeoutMs: number) {
    try {
      return await connectMcpClient(config, timeoutMs);
    } catch (error) {
      throw this.toConnectionError(error);
    }
  }

  private async closeSession(session: { close: () => Promise<void> }, kind: 'test' | 'tool'): Promise<void> {
    try {
      await session.close();
    } catch (error: unknown) {
      // close 失败计为疑似泄漏：连接可能残留，由监控/测试发现
      this.leakedConnections += 1;
      this.logger.warn(
        `Failed to close MCP ${kind} connection (leaked=${this.leakedConnections}): ${toMcpErrorSummary(error)}`,
      );
    }
  }

  private toConnectionError(error: unknown): McpConnectionError {
    const summary = toMcpErrorSummary(error);
    const lower = summary.toLowerCase();
    if (lower.includes('401') || lower.includes('unauthorized')) {
      return new McpConnectionError(`MCP unauthorized: ${summary}`, { kind: 'unauthorized' });
    }
    if (lower.includes('403') || lower.includes('forbidden')) {
      return new McpConnectionError(`MCP forbidden: ${summary}`, { kind: 'forbidden' });
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return new McpConnectionError(`MCP timeout: ${summary}`, { kind: 'timeout' });
    }
    if (error instanceof McpError && error.code === 'MCP_INITIALIZE_FAILED') {
      return new McpConnectionError(`MCP initialize failed: ${summary}`, { kind: 'initialize' });
    }
    return new McpConnectionError(summary, { kind: 'connection' });
  }
}
