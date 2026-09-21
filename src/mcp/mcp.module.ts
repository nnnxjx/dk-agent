import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from '../entities/mcp-server.entity';
import { McpTool } from '../entities/mcp-tool.entity';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpController, McpToolController } from './mcp.controller';
import { McpCredentialsService } from './mcp-credentials.service';
import { McpHealthService } from './mcp-health.service';
import { McpService } from './mcp.service';
import { McpSessionPool } from './mcp-session.pool';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer, McpTool])],
  controllers: [McpController, McpToolController],
  providers: [
    McpSessionPool,
    McpConnectionManager,
    McpCredentialsService,
    McpHealthService,
    McpService,
  ],
  exports: [
    McpSessionPool,
    McpConnectionManager,
    McpCredentialsService,
    McpHealthService,
    McpService,
  ],
})
export class McpModule {}
