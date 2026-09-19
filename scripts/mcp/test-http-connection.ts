/* 阶段 1 联调脚本：验证 connect -> listTools(分页上限) -> callTool(归一化) -> close */
import { McpConnectionManager } from '../../src/mcp/mcp-connection.manager';
import { McpToolCallError } from '../../src/mcp/errors/mcp.errors';

async function main() {
  const manager = new McpConnectionManager();
  const url = process.env.MCP_TEST_URL ?? 'http://localhost:3100/mcp';

  const connection = await manager.testConnection({ url });
  console.log(`Connected in ${connection.durationMs}ms`);
  console.log(`Tools: ${connection.tools.map((tool) => tool.name).join(', ')}`);
  console.log(`Truncated: ${Boolean(connection.truncated)}`);

  const echo = await manager.callTool({ url }, 'echo', { text: 'hello-mcp' });
  console.log(
    `Echo output: ${echo.text} (blocks=${echo.blockCount} truncated=${echo.truncated})`,
  );

  const big = await manager.callTool({ url }, 'big', {});
  console.log(
    `Big output bytes=${Buffer.byteLength(big.text, 'utf8')} truncated=${big.truncated}`,
  );

  try {
    await manager.callTool({ url }, 'fail', { reason: 'boom' });
    console.log('Fail tool: unexpected success (should have thrown isError)');
    process.exitCode = 1;
  } catch (error) {
    console.log(
      `Fail tool correctly threw: ${(error as McpToolCallError).message.slice(0, 120)}`,
    );
  }

  try {
    await manager.callTool({ url }, 'not-exist-tool', {});
    console.log('Missing tool: unexpected success');
    process.exitCode = 1;
  } catch (error) {
    console.log(
      `Missing tool correctly threw: ${(error as Error).message.slice(0, 120)}`,
    );
  }

  console.log(`Leaked connections: ${manager.getLeakedConnections()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
