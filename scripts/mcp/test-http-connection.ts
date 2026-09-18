import { McpConnectionManager } from '../../src/mcp/mcp-connection.manager';

async function main() {
  const manager = new McpConnectionManager();
  const url = 'http://localhost:3100/mcp';

  const connection = await manager.testConnection({ url });
  console.log(`Connected in ${connection.durationMs}ms`);
  console.log(`Tools: ${connection.tools.map((tool) => tool.name).join(', ')}`);

  const output = await manager.callTool({ url }, 'echo', { text: 'hello-mcp' });
  console.log(`Tool output: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
