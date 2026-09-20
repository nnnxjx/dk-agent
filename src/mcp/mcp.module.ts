import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from '../entities/mcp-server.entity';
import { McpTool } from '../entities/mcp-tool.entity';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpController, McpToolController } from './mcp.controller';
import { McpCredentialsService } from './mcp-credentials.service';
import { McpService } from './mcp.service';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer, McpTool])],
  controllers: [McpController, McpToolController],
  providers: [McpConnectionManager, McpCredentialsService, McpService],
  exports: [McpConnectionManager, McpCredentialsService, McpService],
})
export class McpModule {}
