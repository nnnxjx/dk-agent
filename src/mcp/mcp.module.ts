import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpAgentGrant } from '../entities/mcp-agent-grant.entity';
import { McpServer } from '../entities/mcp-server.entity';
import { McpTool } from '../entities/mcp-tool.entity';
import { McpAuthorizationService } from './mcp-authorization.service';
import { McpAgentGrantController } from './mcp-agent-grant.controller';
import { McpConnectionManager } from './mcp-connection.manager';
import { McpController, McpToolController } from './mcp.controller';
import { McpCredentialsService } from './mcp-credentials.service';
import { McpHealthService } from './mcp-health.service';
import { McpService } from './mcp.service';
import { McpSessionPool } from './mcp-session.pool';
import { McpToolProvider } from './mcp-tool.provider';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer, McpTool, McpAgentGrant])],
  controllers: [McpController, McpToolController, McpAgentGrantController],
  providers: [
    McpSessionPool,
    McpConnectionManager,
    McpCredentialsService,
    McpHealthService,
    McpService,
    McpAuthorizationService,
    McpToolProvider,
  ],
  exports: [
    McpSessionPool,
    McpConnectionManager,
    McpCredentialsService,
    McpHealthService,
    McpService,
    McpAuthorizationService,
    McpToolProvider,
  ],
})
export class McpModule {}
