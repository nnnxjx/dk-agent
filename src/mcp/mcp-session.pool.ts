import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from './errors/mcp.errors';
import { McpConnectionConfig } from './interfaces/mcp-config.interface';
import { toMcpErrorSummary } from './mcp-connection.utils';
import { connectMcpClient, McpClientSession } from './mcp-transport.factory';

export type McpSessionStatus =
  'connecting' | 'healthy' | 'reconnecting' | 'closed';

/** 缓存键：同一租户 + 同一 Server + 同一配置版本复用连接，版本变化即失效 */
export interface McpSessionKey {
  tenantId: string;
  serverId: string;
  configVersion: number;
}

export interface McpPooledSession {
  key: McpSessionKey;
  session: McpClientSession;
  client: Client;
  status: McpSessionStatus;
  refCount: number;
  lastUsedAt: number;
  createdAt: number;
  failures: number;
}

interface AcquireOptions {
  /** 允许的最大并发引用数，默认不限制（阶段 4 单连接复用，不断开只计数） */
  maxRefs?: number;
}

function keyOf(key: McpSessionKey): string {
  return `${key.tenantId}::${key.serverId}::v${key.configVersion}`;
}

/**
 * 阶段 4：MCP 连接池（纯 HTTP）
 * - 同一缓存键复用一个 Client；并发 acquire 共用 in-flight 建连，不重复建连
 * - 借用计数 refCount，release 归还；idle 超过 TTL 后后台关闭
 * - Server 禁用/配置变更/删除时调用 invalidate 让旧连接失效
 * - 阶段 4 不跨租户共享 Client；transport 仍是每次建连新建
 */
@Injectable()
export class McpSessionPool implements OnModuleDestroy {
  private readonly logger = new Logger(McpSessionPool.name);
  private readonly sessions = new Map<string, McpPooledSession>();
  private readonly inflight = new Map<string, Promise<McpPooledSession>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {
    const idleTtlMs = this.getIdleTtlMs();
    // 后台定期回收空闲连接；unref 避免阻塞进程退出
    this.sweepTimer = setInterval(
      () => {
        this.sweepIdle().catch((error: unknown) => {
          this.logger.warn(
            `MCP session sweep failed: ${toMcpErrorSummary(error)}`,
          );
        });
      },
      Math.min(Math.max(idleTtlMs, 10_000), 60_000),
    );
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.closeAll();
  }

  isEnabled(): boolean {
    return this.configService.get<boolean>('mcp.enabled') !== false;
  }

  getIdleTtlMs(): number {
    return this.configService.get<number>('mcp.idleTtlMs') ?? 120_000;
  }

  size(): number {
    return this.sessions.size;
  }

  /** 借用连接：命中复用，未命中建连；并发同键共用同一个建连 Promise */
  async acquire(
    key: McpSessionKey,
    config: McpConnectionConfig,
    options?: AcquireOptions,
  ): Promise<McpPooledSession> {
    if (!this.isEnabled()) {
      throw new McpError(
        'MCP is disabled by MCP_ENABLED=false',
        'MCP_CONNECTION_FAILED',
      );
    }
    const cacheKey = keyOf(key);
    const existing = this.sessions.get(cacheKey);
    if (existing && existing.status !== 'closed') {
      if (
        options?.maxRefs !== undefined &&
        existing.refCount >= options.maxRefs
      ) {
        throw new McpError(
          `MCP session busy for ${cacheKey} (refs=${existing.refCount})`,
          'MCP_CONNECTION_FAILED',
        );
      }
      existing.refCount += 1;
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing?.status === 'closed') this.sessions.delete(cacheKey);

    const pending = this.inflight.get(cacheKey);
    if (pending) {
      const shared = await pending;
      shared.refCount += 1;
      shared.lastUsedAt = Date.now();
      return shared;
    }

    const connecting = this.createSession(key, config).catch(
      (error: unknown) => {
        this.inflight.delete(cacheKey);
        throw error;
      },
    );
    this.inflight.set(cacheKey, connecting);
    const pooled = await connecting;
    this.inflight.delete(cacheKey);
    // 首个借用者计 1，后续 acquire 命中复用
    pooled.refCount = 1;
    pooled.lastUsedAt = Date.now();
    this.sessions.set(cacheKey, pooled);
    return pooled;
  }

  /** 归还借用：仅计数，不关闭；idle 回收由后台 sweep 负责 */
  release(pooled: McpPooledSession): void {
    pooled.refCount = Math.max(0, pooled.refCount - 1);
    pooled.lastUsedAt = Date.now();
  }

  /** 让指定 Server 的全部版本失效：禁用/删除/刷新失败时调用 */
  async invalidateServer(tenantId: string, serverId: string): Promise<number> {
    let removed = 0;
    for (const [cacheKey, pooled] of Array.from(this.sessions.entries())) {
      if (
        pooled.key.tenantId === tenantId &&
        pooled.key.serverId === serverId
      ) {
        this.sessions.delete(cacheKey);
        removed += 1;
        await this.closePooled(pooled, 'invalidate').catch(() => undefined);
      }
    }
    return removed;
  }

  /** 让旧配置版本失效：更新 URL/headers/超时后调用 */
  async invalidateStaleVersions(
    tenantId: string,
    serverId: string,
    currentVersion: number,
  ): Promise<number> {
    let removed = 0;
    for (const [cacheKey, pooled] of Array.from(this.sessions.entries())) {
      if (
        pooled.key.tenantId === tenantId &&
        pooled.key.serverId === serverId &&
        pooled.key.configVersion !== currentVersion
      ) {
        this.sessions.delete(cacheKey);
        removed += 1;
        await this.closePooled(pooled, 'stale-version').catch(() => undefined);
      }
    }
    return removed;
  }

  async closeAll(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    this.inflight.clear();
    await Promise.all(
      all.map((pooled) =>
        this.closePooled(pooled, 'shutdown').catch(() => undefined),
      ),
    );
  }

  /** 标记异常：调用失败时 +1，供健康检查判定 unhealthy；有限重连由调用方新建 transport 完成 */
  markFailure(pooled: McpPooledSession): number {
    pooled.failures += 1;
    pooled.status = 'reconnecting';
    return pooled.failures;
  }

  markHealthy(pooled: McpPooledSession): void {
    pooled.failures = 0;
    pooled.status = 'healthy';
  }

  private async createSession(
    key: McpSessionKey,
    config: McpConnectionConfig,
  ): Promise<McpPooledSession> {
    const timeoutMs = config.connectionTimeoutMs ?? config.timeoutMs ?? 10_000;
    const session = await connectMcpClient(config, timeoutMs);
    return {
      key,
      session,
      client: session.client,
      status: 'healthy',
      refCount: 0,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      failures: 0,
    };
  }

  private async sweepIdle(): Promise<void> {
    const ttl = this.getIdleTtlMs();
    const now = Date.now();
    for (const [cacheKey, pooled] of Array.from(this.sessions.entries())) {
      // 有借用者时不回收；无借用且超时才关闭
      if (pooled.refCount > 0) continue;
      if (now - pooled.lastUsedAt < ttl) continue;
      this.sessions.delete(cacheKey);
      this.logger.log(`Closing idle MCP session ${cacheKey}`);
      await this.closePooled(pooled, 'idle').catch(() => undefined);
    }
  }

  private async closePooled(
    pooled: McpPooledSession,
    reason: string,
  ): Promise<void> {
    pooled.status = 'closed';
    try {
      await pooled.session.close();
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to close MCP session (${reason}): ${toMcpErrorSummary(error)}`,
      );
    }
  }
}
