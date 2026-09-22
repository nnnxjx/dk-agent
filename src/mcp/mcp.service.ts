import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { McpServer } from '../entities/mcp-server.entity';
import { McpTool } from '../entities/mcp-tool.entity';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpCredentialsService } from './mcp-credentials.service';
import { McpAuthorizationService } from './mcp-authorization.service';
import { McpHealthService } from './mcp-health.service';
import { buildMcpQualifiedName } from './mcp-tool.adapter';
import { McpConnectionConfig } from './interfaces/mcp-config.interface';
import {
  normalizeMcpHeaders,
  normalizeMcpUrl,
  toMcpErrorSummary,
} from './mcp-connection.utils';

export interface CreateMcpServerInput {
  name: string;
  alias: string;
  url: string;
  headers?: Record<string, string>;
  connectionTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export interface UpdateMcpServerInput {
  name?: string;
  url?: string;
  /** 全量替换 headers；传空对象表示清空；不传表示保持不变 */
  headers?: Record<string, string>;
  connectionTimeoutMs?: number | null;
  toolCallTimeoutMs?: number | null;
}

export interface McpServerView {
  id: string;
  tenantId: string;
  name: string;
  alias: string;
  url: string;
  headers: { configured: boolean; keys: string[] };
  connectionTimeoutMs: number | null;
  toolCallTimeoutMs: number | null;
  enabled: boolean;
  status: McpServer['status'];
  lastConnectedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  configVersion: number;
  toolCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ALIAS_PATTERN = /^[a-z0-9_]{2,48}$/;

/**
 * 阶段 3：MCP Server 持久化与管理（纯 HTTP）
 * - 所有查询强制带 tenantId；更新配置递增 configVersion 让旧配置失效
 * - test/refresh 使用一次性连接，用完即 close；阶段 3 不做连接缓存
 * - 返回给前端的永远是脱敏视图，不回显 headers 明文
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    @InjectRepository(McpServer)
    private readonly serverRepo: Repository<McpServer>,
    @InjectRepository(McpTool)
    private readonly toolRepo: Repository<McpTool>,
    private readonly dataSource: DataSource,
    private readonly connectionManager: McpConnectionManager,
    private readonly credentials: McpCredentialsService,
    private readonly healthService?: McpHealthService,
    private readonly authorization?: McpAuthorizationService,
  ) {}

  async createServer(
    tenantId: string,
    input: CreateMcpServerInput,
  ): Promise<McpServerView> {
    const alias = this.normalizeAlias(input.alias);
    normalizeMcpUrl(input.url);
    const headers = normalizeMcpHeaders(input.headers);
    const server = this.serverRepo.create({
      tenantId,
      name: input.name.trim(),
      alias,
      url: input.url.trim(),
      headersEncrypted: this.credentials.encryptObject(headers),
      credentialsKeyVersion: this.credentials.getKeyVersion(),
      connectionTimeoutMs: input.connectionTimeoutMs ?? null,
      toolCallTimeoutMs: input.toolCallTimeoutMs ?? null,
      enabled: true,
      status: 'pending',
    });
    const saved = await this.serverRepo.save(server);
    let { added, updated, stale, total, truncated } = await this.refreshTools(tenantId, saved.id);
    this.logger.log(`MCP server created: tenant=${tenantId} alias=${alias}`);
    return this.toView(saved, total);
  }

  async listServers(tenantId: string): Promise<McpServerView[]> {
    const servers = await this.serverRepo.find({
      where: { tenantId },
      order: { createdAt: 'ASC' },
    });
    const counts = await this.countToolsByServer(servers.map((s) => s.id));
    return servers.map((s) => this.toView(s, counts.get(s.id) ?? 0));
  }

  async getServer(tenantId: string, id: string): Promise<McpServerView> {
    const server = await this.requireServer(tenantId, id);
    const toolCount = await this.toolRepo.count({
      where: { serverId: server.id },
    });
    return this.toView(server, toolCount);
  }

  async updateServer(
    tenantId: string,
    id: string,
    input: UpdateMcpServerInput,
  ): Promise<McpServerView> {
    const server = await this.requireServer(tenantId, id);
    let versionBumped = false;
    if (input.name !== undefined) server.name = input.name.trim();
    if (input.url !== undefined && input.url.trim() !== server.url) {
      normalizeMcpUrl(input.url);
      server.url = input.url.trim();
      versionBumped = true;
    }
    if (input.headers !== undefined) {
      const headers = normalizeMcpHeaders(input.headers);
      server.headersEncrypted = this.credentials.encryptObject(headers);
      server.credentialsKeyVersion = this.credentials.getKeyVersion();
      versionBumped = true;
    }
    if (
      input.connectionTimeoutMs !== undefined &&
      input.connectionTimeoutMs !== server.connectionTimeoutMs
    ) {
      server.connectionTimeoutMs = input.connectionTimeoutMs;
      versionBumped = true;
    }
    if (
      input.toolCallTimeoutMs !== undefined &&
      input.toolCallTimeoutMs !== server.toolCallTimeoutMs
    ) {
      server.toolCallTimeoutMs = input.toolCallTimeoutMs;
      versionBumped = true;
    }
    if (versionBumped) {
      // 配置变更即失效旧连接（阶段 3 无缓存，靠版本号让阶段 4 的缓存失效）
      server.configVersion += 1;
      server.status = server.enabled ? 'pending' : 'disabled';
    }
    const saved = await this.serverRepo.save(server);
    const toolCount = await this.toolRepo.count({
      where: { serverId: saved.id },
    });
    if (versionBumped) {
      // 旧配置版本即刻失效，下次调用按新 version 重建
      await this.connectionManager
        .invalidateServer(tenantId, saved.id)
        .catch(() => undefined);
    }
    return this.toView(saved, toolCount);
  }

  async deleteServer(
    tenantId: string,
    id: string,
  ): Promise<{ success: boolean }> {
    const server = await this.requireServer(tenantId, id);
    // 先失效池连接，再删配置与工具快照，避免旧连接继续调用已删地址
    await this.connectionManager
      .invalidateServer(tenantId, server.id)
      .catch(() => undefined);
    // 阶段 6：级联清理该 Server 命名空间下的幽灵授权
    await this.authorization?.cleanupGrantsForServer(tenantId, server.alias).catch(() => undefined);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(McpTool, { serverId: server.id });
      await manager.delete(McpServer, { id: server.id, tenantId });
    });
    this.logger.log(
      `MCP server deleted: tenant=${tenantId} alias=${server.alias}`,
    );
    return { success: true };
  }

  async setEnabled(
    tenantId: string,
    id: string,
    enabled: boolean,
  ): Promise<McpServerView> {
    const server = await this.requireServer(tenantId, id);
    server.enabled = enabled;
    server.status = enabled ? 'pending' : 'disabled';
    if (!enabled) {
      // 禁用即刻失效池连接，已借出的用完归还后由 sweep 回收
      await this.connectionManager
        .invalidateServer(tenantId, server.id)
        .catch(() => undefined);
    }
    const saved = await this.serverRepo.save(server);
    const toolCount = await this.toolRepo.count({
      where: { serverId: saved.id },
    });
    return this.toView(saved, toolCount);
  }

  /** 测试连接：一次性连接，用完即 close；成功更新 healthy，失败更新 unhealthy（脱敏错误） */
  async testServer(tenantId: string, id: string) {
    const server = await this.requireServer(tenantId, id);
    const config = this.toConnectionConfig(server);
    try {
      const result = await this.connectionManager.testConnection(config);
      server.status = server.enabled ? 'healthy' : 'disabled';
      server.lastConnectedAt = new Date();
      server.lastCheckedAt = new Date();
      server.lastError = null;
      await this.serverRepo.save(server);
      return {
        tools: result.tools.map((t) => t.name),
        durationMs: result.durationMs,
        truncated: result.truncated,
      };
    } catch (error) {
      server.status = server.enabled ? 'unhealthy' : 'disabled';
      server.lastCheckedAt = new Date();
      server.lastError = toMcpErrorSummary(error);
      await this.serverRepo.save(server);
      throw error;
    }
  }

  /** 刷新工具清单：事务内 upsert + 远端缺失标记 stale，不物理删除 */
  async refreshTools(tenantId: string, id: string) {
    const server = await this.requireServer(tenantId, id);
    const config = this.toConnectionConfig(server);
    const discovered = await this.connectionManager.testConnection(config);
    const now = new Date();
    let added = 0;
    let updated = 0;
    let stale = 0;

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.find(McpTool, {
        where: { serverId: server.id },
      });
      const byName = new Map(existing.map((t) => [t.name, t]));//数据库中的工具列表
      const seen = new Set<string>();//mcp最新工具列表

      for (const remote of discovered.tools) {
        seen.add(remote.name);
        const qualifiedName = buildMcpQualifiedName(server.alias, remote.name);
        const schemaHash = remote.inputSchema
          ? createHash('sha256')
              .update(JSON.stringify(remote.inputSchema))
              .digest('hex')
          : null;
        const current = byName.get(remote.name);//查看当前的mcp的每一个工具是否还在本地的列表中可以找到
        if (!current) {
          await manager.save(
            manager.create(McpTool, {
              serverId: server.id,
              name: remote.name,
              qualifiedName,
              description: remote.description ?? null,
              inputSchema: remote.inputSchema ?? null,
              enabled: true,
              schemaHash,
              stale: false,
              lastSeenAt: now,
            }),
          );
          added += 1;
        } else {
          const changed =
            current.qualifiedName !== qualifiedName ||
            (current.description ?? null) !== (remote.description ?? null) ||
            (current.schemaHash ?? null) !== schemaHash;
          current.qualifiedName = qualifiedName;
          current.description = remote.description ?? null;
          current.inputSchema = remote.inputSchema ?? null;
          current.schemaHash = schemaHash;
          current.stale = false;
          current.lastSeenAt = now;
          await manager.save(current);
          if (changed) updated += 1;
        }
      }

      for (const local of existing) {
        if (!seen.has(local.name) && !local.stale) {
          local.stale = true;
          await manager.save(local);
          stale += 1;
        }
      }

      server.status = server.enabled ? 'healthy' : 'disabled';
      server.lastConnectedAt = now;
      server.lastCheckedAt = now;
      server.lastError = null;
      await manager.save(server);
    });

    return {
      added,
      updated,
      stale,
      total: discovered.tools.length,
      truncated: discovered.truncated,
    };
  }

  async listTools(tenantId: string, serverId: string) {
    await this.requireServer(tenantId, serverId);
    return this.toolRepo.find({ where: { serverId }, order: { name: 'ASC' } });
  }

  /**
   * 阶段 4：探活（复用池连接）
   * - 健康服务未注入（单测）时退化为一次性 testServer
   * - 禁用的 Server 直接返回 disabled，不建连
   */
  async probeHealth(tenantId: string, id: string) {
    const server = await this.requireServer(tenantId, id);
    if (!server.enabled) {
      return { status: 'disabled' as const, evictedPool: 0 };
    }
    if (!this.healthService) {
      const result = await this.testServer(tenantId, id);
      return { status: 'healthy' as const, durationMs: result.durationMs };
    }
    const status = await this.healthService.probe({
      tenantId,
      serverId: server.id,
      configVersion: server.configVersion,
      config: this.toConnectionConfig(server),
    });
    const view = await this.getServer(tenantId, id);
    return { status, server: view };
  }

  /**
   * 阶段 6：按请求装配授权工具时读取连接上下文（含解密后的 headers）。
   * 只供后端内部调用，绝不向前端返回。
   */
  async getConnectionContext(tenantId: string, serverId: string): Promise<McpConnectionConfig> {
    const server = await this.requireServer(tenantId, serverId);
    if (!server.enabled) throw new Error(`MCP server "${server.alias}" is disabled`);
    return this.toConnectionConfig(server);
  }

  async getServerEntity(tenantId: string, serverId: string) {
    return this.requireServer(tenantId, serverId);
  }

  async setToolEnabled(tenantId: string, toolId: string, enabled: boolean) {
    const tool = await this.toolRepo.findOne({ where: { id: toolId } });
    if (!tool) throw new NotFoundException(`MCP tool ${toolId} not found`);
    await this.requireServer(tenantId, tool.serverId);
    tool.enabled = enabled;
    return this.toolRepo.save(tool);
  }

  private async requireServer(
    tenantId: string,
    id: string,
  ): Promise<McpServer> {
    const server = await this.serverRepo.findOne({ where: { id, tenantId } });
    if (!server) throw new NotFoundException(`MCP server ${id} not found`);
    return server;
  }

  private toConnectionConfig(server: McpServer): McpConnectionConfig {
    return {
      url: server.url,
      headers: this.credentials.decryptObject(server.headersEncrypted),
      connectionTimeoutMs: server.connectionTimeoutMs ?? undefined,
      toolCallTimeoutMs: server.toolCallTimeoutMs ?? undefined,
    };
  }

  private normalizeAlias(alias: string): string {
    const normalized = alias.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(normalized)) {
      throw new Error('MCP server alias must match /^[a-z0-9_]{2,48}$/');
    }
    return normalized;
  }

  private toView(server: McpServer, toolCount: number): McpServerView {
    // 脱敏：只告诉前端是否配了哪些 header key，不回显值
    const headers = this.credentials.decryptObject(server.headersEncrypted);
    return {
      id: server.id,
      tenantId: server.tenantId,
      name: server.name,
      alias: server.alias,
      url: server.url,
      headers: this.credentials.maskHeaders(headers),
      connectionTimeoutMs: server.connectionTimeoutMs,
      toolCallTimeoutMs: server.toolCallTimeoutMs,
      enabled: server.enabled,
      status: server.status,
      lastConnectedAt: server.lastConnectedAt,
      lastCheckedAt: server.lastCheckedAt,
      lastError: server.lastError,
      configVersion: server.configVersion,
      toolCount,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }

  private async countToolsByServer(
    serverIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (serverIds.length === 0) return counts;
    const rows = await this.toolRepo
      .createQueryBuilder('tool')
      .select('tool.serverId', 'serverId')
      .addSelect('COUNT(*)', 'count')
      .where('tool.serverId IN (:...serverIds)', { serverIds })
      .groupBy('tool.serverId')
      .getRawMany<{ serverId: string; count: string }>();
    for (const row of rows) counts.set(row.serverId, Number(row.count));
    return counts;
  }
}
