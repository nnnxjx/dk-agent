import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { McpService } from './mcp.service';
import { McpHealthService } from './mcp-health.service';
import { JwtAuthGuard, TenantGuard } from '../auth/guards';
import { TenantId } from '../common/decorators/tenant.decorator';

const HeadersSchema = z.record(z.string(), z.string()).optional();

const CreateServerSchema = z.object({
  name: z.string().min(1).max(100),
  alias: z.string().min(2).max(48),
  url: z.string().url().max(2000),
  headers: HeadersSchema,
  connectionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  toolCallTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

const UpdateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  connectionTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .nullable()
    .optional(),
  toolCallTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .nullable()
    .optional(),
});

const SetToolEnabledSchema = z.object({
  enabled: z.boolean(),
});

/**
 * 阶段 3-4：MCP 管理接口（纯 HTTP）
 * - 全部接口要求 JWT + 租户隔离；所有查询强制带 tenantId
 * - 返回脱敏视图，不回显 headers 明文；错误不泄露凭据与完整 query
 */
@Controller('mcp/servers')
@UseGuards(JwtAuthGuard, TenantGuard)
export class McpController {
  constructor(
    private readonly mcpService: McpService,
    private readonly healthService: McpHealthService,
  ) {}

  @Post()
  create(@Body() body: unknown, @TenantId() tenantId: string) {
    return this.mcpService.createServer(
      tenantId,
      CreateServerSchema.parse(body),
    );
  }

  @Get()
  list(@TenantId() tenantId: string) {
    return this.mcpService.listServers(tenantId);
  }

  @Get('tools')
  tools(@TenantId() tenantId: string) {
    return this.mcpService.listTools(tenantId);
  }

  @Get(':id')
  get(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.getServer(tenantId, id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @TenantId() tenantId: string,
  ) {
    return this.mcpService.updateServer(
      tenantId,
      id,
      UpdateServerSchema.parse(body),
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.deleteServer(tenantId, id);
  }

  @Post(':id/test')
  test(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.testServer(tenantId, id);
  }

  @Post(':id/refresh-tools')
  refresh(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.refreshTools(tenantId, id);
  }

  @Post(':id/enable')
  enable(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.setEnabled(tenantId, id, true);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.setEnabled(tenantId, id, false);
  }

  @Get(':id/tools')
  toolsByServerId(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.listTools(tenantId, id);
  }

  /**
   * 阶段 4：探活单个 Server（复用池连接，轻量 listTools）
   * 成功回 healthy；连续失败达阈值才标 unhealthy 并失效连接
   */
  @Post(':id/health')
  health(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.mcpService.probeHealth(tenantId, id);
  }
}

@Controller('mcp/tools')
@UseGuards(JwtAuthGuard, TenantGuard)
export class McpToolController {
  constructor(private readonly mcpService: McpService) {}

  @Patch(':id')
  setEnabled(
    @Param('id') id: string,
    @Body() body: unknown,
    @TenantId() tenantId: string,
  ) {
    return this.mcpService.setToolEnabled(
      tenantId,
      id,
      SetToolEnabledSchema.parse(body).enabled,
    );
  }
}
