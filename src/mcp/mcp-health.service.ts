import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServer } from '../entities/mcp-server.entity';
import { McpConnectionConfig } from './interfaces/mcp-config.interface';
import {
  sanitizeMcpConfigForLog,
  toMcpErrorSummary,
} from './mcp-connection.utils';
import { McpSessionPool, McpSessionKey } from './mcp-session.pool';
import { withTimeout } from './mcp-transport.factory';

export interface McpHealthSummary {
  checked: number;
  healthy: number;
  unhealthy: number;
  evicted: number;
}

export interface McpHealthProbe {
  tenantId: string;
  serverId: string;
  configVersion: number;
  config: McpConnectionConfig;
}

/**
 * 阶段 4：MCP 健康检查（纯 HTTP）
 * - 调用方传入完整 connection config（含解密后的 headers），本服务不读凭据
 * - 对池内会话做轻量 listTools 探活：成功 markHealthy，失败 markFailure
 * - 连续失败达阈值则关闭会话并标 DB unhealthy；成功回 healthy
 * - 状态机：pending -> connecting -> healthy <-> unhealthy -> reconnecting -> healthy
 */
@Injectable()
export class McpHealthService {
  private readonly logger = new Logger(McpHealthService.name);
  /** 连续失败阈值：达到后关闭会话，下次调用重建 */
  private readonly failureThreshold = 3;

  constructor(
    @InjectRepository(McpServer)
    private readonly serverRepo: Repository<McpServer>,
    private readonly pool: McpSessionPool,
  ) {}

  /** 探活单个 Server：复用池连接，不新建长连接 */
  async probe(probe: McpHealthProbe): Promise<'healthy' | 'unhealthy'> {
    const key: McpSessionKey = {
      tenantId: probe.tenantId,
      serverId: probe.serverId,
      configVersion: probe.configVersion,
    };
    const pooled = await this.pool.acquire(key, probe.config);
    try {
      await withTimeout(
        pooled.client.listTools(),
        10_000,
        'MCP health listTools',
      );
      this.pool.markHealthy(pooled);
      await this.updateStatus(probe, 'healthy', null);
      return 'healthy';
    } catch (error) {
      const failures = this.pool.markFailure(pooled);
      const summary = toMcpErrorSummary(error);
      this.logger.warn(
        `MCP health probe failed (${failures}x) server=${probe.serverId}: ${summary} config=${JSON.stringify(sanitizeMcpConfigForLog(probe.config))}`,
      );
      if (failures >= this.failureThreshold) {
        await this.pool.invalidateServer(probe.tenantId, probe.serverId);
        await this.updateStatus(probe, 'unhealthy', summary);
      }
      return 'unhealthy';
    } finally {
      this.pool.release(pooled);
    }
  }

  /** 批量探活：逐个执行，失败不中断整体，返回汇总 */
  async probeAll(probes: McpHealthProbe[]): Promise<McpHealthSummary> {
    let healthy = 0;
    let unhealthy = 0;
    for (const probe of probes) {
      const result = await this.probe(probe).catch(() => 'unhealthy' as const);
      if (result === 'healthy') healthy += 1;
      else unhealthy += 1;
    }
    return {
      checked: probes.length,
      healthy,
      unhealthy,
      evicted: this.pool.size(),
    };
  }

  private async updateStatus(
    probe: McpHealthProbe,
    status: McpServer['status'],
    lastError: string | null,
  ) {
    await this.serverRepo.update(
      { id: probe.serverId, tenantId: probe.tenantId },
      { status, lastError, lastCheckedAt: new Date() },
    );
  }
}
