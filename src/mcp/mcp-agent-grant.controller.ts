import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { McpAuthorizationService } from './mcp-authorization.service';
import { JwtAuthGuard, TenantGuard } from '../auth/guards';
import { TenantId } from '../common/decorators/tenant.decorator';

const SetGrantsSchema = z.object({
  qualifiedNames: z.array(z.string().min(1).max(200)).max(500),
});

/**
 * 阶段 6：Agent ↔ MCP 工具授权（白名单语义）
 * - 全量替换：PUT /mcp/agents/:agentName/grants { qualifiedNames: [...] }
 * - 传空数组表示收回该 Agent 全部 MCP 工具
 */
@Controller('mcp/agents')
@UseGuards(JwtAuthGuard, TenantGuard)
export class McpAgentGrantController {
  constructor(private readonly auth: McpAuthorizationService) {}

  @Get(':agentName/grants')
  list(@Param('agentName') agentName: string, @TenantId() tenantId: string) {
    return this.auth
      .listAgentGrants(tenantId, agentName)
      .then((granted) => ({ agentName, granted }));
  }

  @Put(':agentName/grants')
  set(
    @Param('agentName') agentName: string,
    @Body() body: unknown,
    @TenantId() tenantId: string,
  ) {
    const dto = SetGrantsSchema.parse(body);
    return this.auth
      .setAgentGrants(tenantId, agentName, dto.qualifiedNames)
      .then((r) => ({ agentName, ...r }));
  }
}
