import { Injectable, Logger } from '@nestjs/common';
import { StructuredToolInterface } from '@langchain/core/tools';
import {
  McpAuthorizationService,
  McpAuthContext,
} from './mcp-authorization.service';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpService } from './mcp.service';
import { adaptMcpToolToLangChain } from './mcp-tool.adapter';

/**
 * 阶段 6：按请求装配授权 MCP 工具（无状态、无缓存）
 * - 每次 Run 按 tenantId + agentName 拉取授权清单并适配为 LangChain 工具
 * - 适配后的工具自带 pooled 上下文（tenantId/serverId/configVersion），复用阶段 4 连接池
 * - 调用前二次校验授权与 Server/工具状态，拒绝时返回文本，不抛到图外
 */
@Injectable()
export class McpToolProvider {
  private readonly logger = new Logger(McpToolProvider.name);

  constructor(
    private readonly auth: McpAuthorizationService,
    private readonly mcpService: McpService,
    private readonly connectionManager: McpConnectionManager,
  ) {}

  async buildAuthorizedTools(
    ctx: McpAuthContext,
  ): Promise<StructuredToolInterface[]> {
    if (!ctx.agentName) return [];
    const allowed = await this.auth.listAllowedTools(ctx);
    const tools: StructuredToolInterface[] = [];
    for (const item of allowed) {
      try {
        const connection = await this.mcpService.getConnectionContext(
          ctx.tenantId,
          item.serverId,
        );
        const pooled = {
          tenantId: ctx.tenantId,
          serverId: item.serverId,
          configVersion: item.configVersion,
        };
        const tool = adaptMcpToolToLangChain(
          item.serverAlias,
          connection,
          {
            name: item.name,
            description: item.description ?? undefined,
            inputSchema: item.inputSchema ?? undefined,
          },
          {
            callTool: (config, toolName, args) =>
              this.connectionManager.callTool(config, toolName, args, pooled),
          },
          {
            guard: async () => {
              const check = await this.auth.checkToolCall(
                ctx,
                item.qualifiedName,
              );
              if (!check.allowed)
                throw new Error(check.reason ?? 'MCP tool not allowed');
            },
          },
        );
        tools.push(tool);
      } catch (error) {
        this.logger.warn(
          `Skip MCP tool "${item.qualifiedName}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return tools;
  }
}
