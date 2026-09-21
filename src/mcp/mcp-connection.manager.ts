import { Injectable, Logger } from '@nestjs/common';
import { MCP_CONSTANTS } from './mcp.constants';
import {
  McpConnectionError,
  McpError,
  McpToolCallError,
} from './errors/mcp.errors';
import {
  McpConnectionConfig,
  McpConnectionResult,
  McpPooledCallContext,
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
import {
  McpPooledSession,
  McpSessionKey,
  McpSessionPool,
} from './mcp-session.pool';

/**
 * 阶段 4：连接管理（纯 HTTP，池化复用）
 * - 需复用的调用方走 acquireSession/releaseSession，缓存键 tenantId + serverId + configVersion
 * - testConnection/callTool 保持一次性语义（内部直连、用完关闭），供 test/refresh/探活使用
 */
@Injectable()
export class McpConnectionManager {
  private readonly logger = new Logger(McpConnectionManager.name);
  /** 未正常关闭的连接计数：close 抛错或流程异常时 +1，用于测试与监控 */
  private leakedConnections = 0;

  constructor(private readonly pool?: McpSessionPool) {}

  getLeakedConnections(): number {
    return this.leakedConnections;
  }

  /**
   * 借用池化连接：命中复用，未命中建连；调用方必须在 finally 中 release。
   * key 必须带 configVersion，配置变更后旧连接自动失效。
   */
  async acquireSession(
    key: McpSessionKey,
    config: McpConnectionConfig,
  ): Promise<McpPooledSession> {
    if (!this.pool)
      throw new McpError(
        'MCP session pool is not initialized',
        'MCP_CONNECTION_FAILED',
      );
    return this.pool.acquire(key, config);
  }

  releaseSession(session: McpPooledSession): void {
    this.pool?.release(session);
  }

  /** 配置变更/禁用/删除后失效旧连接 */
  async invalidateServer(tenantId: string, serverId: string): Promise<number> {
    return this.pool?.invalidateServer(tenantId, serverId) ?? 0;
  }

  async testConnection(
    config: McpConnectionConfig,
  ): Promise<McpConnectionResult> {
    const startedAt = Date.now();
    this.logger.log(
      `Testing MCP connection: ${JSON.stringify(sanitizeMcpConfigForLog(config))}`,
    );

    const timeoutMs = resolveMcpTimeoutMs(
      config,
      MCP_CONSTANTS.defaultConnectionTimeoutMs,
    );
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
        for (const tool of (page as { tools: McpConnectionResult['tools'] })
          .tools ?? []) {
          if (tools.length >= maxTools) {
            truncated = true;
            break;
          }
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
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
   * 调用远端工具并返回归一化结果。
   * - 默认走池化复用（需传 pooled 上下文，缓存键 tenantId + serverId + configVersion）
   * - 不传 pooled 或 usePool=false 时走一次性连接（test/refresh/探活/单测用）
   * - 池化调用失败超过 1 次即失效该连接，下次重建，不无限重试
   */
  async callTool(
    config: McpConnectionConfig,
    toolName: string,
    args: Record<string, unknown>,
    pooled?: McpPooledCallContext,
  ): Promise<McpToolCallResult> {
    this.logger.log(
      `Calling MCP tool "${toolName}": ${JSON.stringify(sanitizeMcpConfigForLog(config))}`,
    );
    // 先做 URL 格式校验，避免无效配置走到建连
    normalizeMcpUrl(config.url);
    const callTimeoutMs =
      config.toolCallTimeoutMs ??
      config.timeoutMs ??
      MCP_CONSTANTS.defaultToolCallTimeoutMs;
    if (!pooled || pooled.usePool === false || !this.pool) {
      return this.callToolOnce(config, toolName, args, callTimeoutMs);
    }
    const key = {
      tenantId: pooled.tenantId,
      serverId: pooled.serverId,
      configVersion: pooled.configVersion,
    };
    const session = await this.pool.acquire(key, config);
    try {
      const result = await withTimeout(
        session.client.callTool({ name: toolName, arguments: args }),
        callTimeoutMs,
        'MCP callTool',
      );
      const normalized = normalizeMcpCallResult(result.content, {
        isError: (result as { isError?: boolean }).isError,
        structuredContent: (
          result as { structuredContent?: Record<string, unknown> }
        ).structuredContent,
      });
      if (normalized.isError) {
        throw new McpToolCallError(
          `MCP tool "${toolName}" returned isError: ${normalized.text}`,
          toolName,
          {
            truncated: normalized.truncated,
            blockCount: normalized.blockCount,
          },
        );
      }
      this.pool.markHealthy(session);
      return normalized;
    } catch (error) {
      // 池化失败只失效一次：连接可能已断，下次调用重建；不重试本次调用
      const failures = this.pool.markFailure(session);
      if (failures >= 1) {
        await this.pool
          .invalidateServer(pooled.tenantId, pooled.serverId)
          .catch(() => undefined);
      }
      throw this.toToolError(error, toolName);
    } finally {
      this.pool.release(session);
    }
  }

  /** 一次性调用：每次新建连接、用完关闭；test/refresh/探活走此路径 */
  private async callToolOnce(
    config: McpConnectionConfig,
    toolName: string,
    args: Record<string, unknown>,
    callTimeoutMs: number,
  ): Promise<McpToolCallResult> {
    const connectTimeoutMs = resolveMcpTimeoutMs(
      config,
      MCP_CONSTANTS.defaultConnectionTimeoutMs,
    );
    const session = await this.connect(config, connectTimeoutMs);
    try {
      const result = await withTimeout(
        session.client.callTool({ name: toolName, arguments: args }),
        callTimeoutMs,
        'MCP callTool',
      );
      const normalized = normalizeMcpCallResult(result.content, {
        isError: (result as { isError?: boolean }).isError,
        structuredContent: (
          result as { structuredContent?: Record<string, unknown> }
        ).structuredContent,
      });
      if (normalized.isError) {
        throw new McpToolCallError(
          `MCP tool "${toolName}" returned isError: ${normalized.text}`,
          toolName,
          {
            truncated: normalized.truncated,
            blockCount: normalized.blockCount,
          },
        );
      }
      return normalized;
    } catch (error) {
      throw this.toToolError(error, toolName);
    } finally {
      await this.closeSession(session, 'tool');
    }
  }

  private toToolError(error: unknown, toolName: string): McpToolCallError {
    if (error instanceof McpToolCallError) return error;
    if (error instanceof McpError) {
      return new McpToolCallError(toMcpErrorSummary(error), toolName, {
        code: error.code,
      });
    }
    return new McpToolCallError(toMcpErrorSummary(error), toolName);
  }

  /** 建连失败归一化：连接失败与初始化失败分开，401/403/超时显式映射 */
  private async connect(config: McpConnectionConfig, timeoutMs: number) {
    try {
      return await connectMcpClient(config, timeoutMs);
    } catch (error) {
      throw this.toConnectionError(error);
    }
  }

  private async closeSession(
    session: { close: () => Promise<void> },
    kind: 'test' | 'tool',
  ): Promise<void> {
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
      return new McpConnectionError(`MCP unauthorized: ${summary}`, {
        kind: 'unauthorized',
      });
    }
    if (lower.includes('403') || lower.includes('forbidden')) {
      return new McpConnectionError(`MCP forbidden: ${summary}`, {
        kind: 'forbidden',
      });
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return new McpConnectionError(`MCP timeout: ${summary}`, {
        kind: 'timeout',
      });
    }
    if (error instanceof McpError && error.code === 'MCP_INITIALIZE_FAILED') {
      return new McpConnectionError(`MCP initialize failed: ${summary}`, {
        kind: 'initialize',
      });
    }
    return new McpConnectionError(summary, { kind: 'connection' });
  }
}
