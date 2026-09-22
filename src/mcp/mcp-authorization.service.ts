import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServer } from '../entities/mcp-server.entity';
import { McpTool } from '../entities/mcp-tool.entity';
import { McpAgentGrant } from '../entities/mcp-agent-grant.entity';

export interface McpAuthContext {
  tenantId: string;
  agentName?: string;
  workflowId?: string;
  runId?: string;
}

export interface McpAllowedTool {
  serverId: string;
  serverAlias: string;
  configVersion: number;
  toolId: string;
  name: string;
  qualifiedName: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

/**
 * 阶段 6：MCP 授权（纯 HTTP，无缓存）
 * 检查顺序：租户有效 -> Server 已启用且非 disabled/unhealthy -> Tool 已启用且非 stale -> Agent 已授权
 * - 内置工具不受本服务约束（始终允许）
 * - 调用入口必须二次校验：即使 Agent 伪造工具名，没有 grant 或状态非法一律拒绝
 */
@Injectable()
export class McpAuthorizationService {
  private readonly logger = new Logger(McpAuthorizationService.name);

  constructor(
    @InjectRepository(McpServer)
    private readonly serverRepo: Repository<McpServer>,
    @InjectRepository(McpTool)
    private readonly toolRepo: Repository<McpTool>,
    @InjectRepository(McpAgentGrant)
    private readonly grantRepo: Repository<McpAgentGrant>,
  ) {}

  /** 全量替换某 Agent 的授权清单（白名单语义） */
  async setAgentGrants(
    tenantId: string,
    agentName: string,
    qualifiedNames: string[],
  ): Promise<{ granted: number }> {
    const names = Array.from(
      new Set(qualifiedNames.map((n) => n.trim()).filter(Boolean)),
    );
    for (const name of names) {
      if (!name.startsWith('mcp__'))
        throw new Error(`Grant "${name}" must start with "mcp__"`);
    }
    const existing = await this.grantRepo.find({
      where: { tenantId, agentName },
    });
    const existingSet = new Set(existing.map((g) => g.qualifiedName));
    const wantedSet = new Set(names);
    const toRemove = existing.filter((g) => !wantedSet.has(g.qualifiedName));
    const toAdd = names.filter((n) => !existingSet.has(n));
    if (toRemove.length > 0) await this.grantRepo.remove(toRemove);
    if (toAdd.length > 0) {
      await this.grantRepo.save(
        toAdd.map((qualifiedName) =>
          this.grantRepo.create({ tenantId, agentName, qualifiedName }),
        ),
      );
    }
    this.logger.log(
      `MCP grants set: tenant=${tenantId} agent=${agentName} granted=${names.length}`,
    );
    return { granted: names.length };
  }

  async listAgentGrants(
    tenantId: string,
    agentName: string,
  ): Promise<string[]> {
    const rows = await this.grantRepo.find({
      where: { tenantId, agentName },
      order: { qualifiedName: 'ASC' },
    });
    return rows.map((r) => r.qualifiedName);
  }

  /**
   * 单个工具调用入口校验（防伪造工具名）。
   * 返回 { allowed, reason }，调用方拒绝时向 Agent 返回 reason 文本，不抛到图外。
   */
  async checkToolCall(
    ctx: McpAuthContext,
    qualifiedName: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!qualifiedName.startsWith('mcp__')) return { allowed: true };
    const grant = ctx.agentName
      ? await this.grantRepo.findOne({
          where: {
            tenantId: ctx.tenantId,
            agentName: ctx.agentName,
            qualifiedName,
          },
        })
      : null;
    if (ctx.agentName && !grant) {
      return {
        allowed: false,
        reason: `MCP tool "${qualifiedName}" is not granted to agent "${ctx.agentName}"`,
      };
    }
    const tool = await this.toolRepo.findOne({ where: { qualifiedName } });
    if (!tool)
      return {
        allowed: false,
        reason: `MCP tool "${qualifiedName}" does not exist`,
      };
    const server = await this.serverRepo.findOne({
      where: { id: tool.serverId, tenantId: ctx.tenantId },
    });
    if (!server)
      return {
        allowed: false,
        reason: `MCP tool "${qualifiedName}" is not in tenant "${ctx.tenantId}"`,
      };
    if (!server.enabled || server.status === 'disabled')
      return {
        allowed: false,
        reason: `MCP server "${server.alias}" is disabled`,
      };
    if (server.status === 'unhealthy')
      return {
        allowed: false,
        reason: `MCP server "${server.alias}" is unhealthy`,
      };
    if (!tool.enabled)
      return {
        allowed: false,
        reason: `MCP tool "${qualifiedName}" is disabled`,
      };
    if (tool.stale)
      return {
        allowed: false,
        reason: `MCP tool "${qualifiedName}" is stale (removed upstream)`,
      };
    return { allowed: true };
  }

  /** 列出某租户某 Agent 可用的 MCP 工具（列表装配用，与 checkToolCall 同一规则） */
  async listAllowedTools(ctx: McpAuthContext): Promise<McpAllowedTool[]> {
    if (!ctx.agentName) return [];
    const grants = await this.grantRepo.find({
      where: { tenantId: ctx.tenantId, agentName: ctx.agentName },
    });
    if (grants.length === 0) return [];
    const qualifiedNames = grants.map((g) => g.qualifiedName);
    const tools: McpAllowedTool[] = [];
    // 分批查询避免超长 IN 列表
    for (let i = 0; i < qualifiedNames.length; i += 100) {
      const batch = qualifiedNames.slice(i, i + 100);
      const rows = await this.toolRepo
        .createQueryBuilder('tool')
        .innerJoin(McpServer, 'server', 'server.id = tool.serverId')
        .where('tool.qualifiedName IN (:...names)', { names: batch })
        .andWhere('server.tenantId = :tenantId', { tenantId: ctx.tenantId })
        .andWhere('server.enabled = :enabled', { enabled: true })
        .andWhere('server.status NOT IN (:...bad)', {
          bad: ['disabled', 'unhealthy'],
        })
        .andWhere('tool.enabled = :toolEnabled', { toolEnabled: true })
        .andWhere('tool.stale = :stale', { stale: false })
        .select([
          'tool.id AS id',
          'tool.serverId AS serverId',
          'tool.name AS name',
          'tool.qualifiedName AS qualifiedName',
          'tool.description AS description',
          'tool.inputSchema AS inputSchema',
          'server.alias AS alias',
          'server.configVersion AS configVersion',
        ])
        .getRawMany<{
          id: string;
          serverId: string;
          name: string;
          qualifiedName: string;
          description: string | null;
          inputSchema: string | Record<string, unknown> | null;
          alias: string;
          configVersion: number;
        }>();
      for (const row of rows) {
        tools.push({
          serverId: row.serverId,
          serverAlias: row.alias,
          configVersion: Number(row.configVersion),
          toolId: row.id,
          name: row.name,
          qualifiedName: row.qualifiedName,
          description: row.description,
          inputSchema:
            typeof row.inputSchema === 'string'
              ? (JSON.parse(row.inputSchema) as Record<string, unknown>)
              : row.inputSchema,
        });
      }
    }
    return tools;
  }

  /** Server/工具变更时清理幽灵授权 */
  async cleanupGrantsForServer(
    tenantId: string,
    serverAlias: string,
  ): Promise<number> {
    const prefix = `mcp__${serverAlias}__`;
    const rows = await this.grantRepo
      .createQueryBuilder('g')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.qualifiedName LIKE :prefix', { prefix: `${prefix}%` })
      .getMany();
    if (rows.length > 0) await this.grantRepo.remove(rows);
    return rows.length;
  }

  async cleanupGrantsForTool(
    tenantId: string,
    qualifiedName: string,
  ): Promise<number> {
    const rows = await this.grantRepo.find({
      where: { tenantId, qualifiedName },
    });
    if (rows.length > 0) await this.grantRepo.remove(rows);
    return rows.length;
  }
}
