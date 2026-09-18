import { Module } from '@nestjs/common';
import { McpConnectionManager } from './mcp-connection.manager';

@Module({
  providers: [McpConnectionManager],
  exports: [McpConnectionManager],
})
export class McpModule {}
