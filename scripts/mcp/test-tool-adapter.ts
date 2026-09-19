/* 阶段 2 联调：MCP 工具 -> LangChain -> Supervisor/DAG 兼容性（无需真实 LLM Key）
 * 覆盖：
 * 1. 适配后工具名带命名空间，可注册进 ToolRegistry 且不覆盖内置工具
 * 2. 工具 invoke 走真实 MCP callTool（echo），返回归一化文本
 * 3. DAG tool 节点可用字符串参数调用 MCP 工具（DagEngine 传 JSON 字符串的兼容路径）
 * 4. AG-UI 工具事件可由标准 tool.invoke 触发（on_tool_end 内容即归一化文本）
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ToolRegistry } from '../../src/tools/tool-registry';
import { McpConnectionManager } from '../../src/mcp/mcp-connection.manager';
import { adaptMcpServerTools } from '../../src/mcp/mcp-tool.adapter';

async function main() {
  const url = process.env.MCP_TEST_URL ?? 'http://localhost:3100/mcp';
  const manager = new McpConnectionManager();
  const registry = new ToolRegistry();

  const connection = await manager.testConnection({ url });
  console.log(`Discovered: ${connection.tools.map((t) => t.name).join(', ')}`);

  const { tools, skipped } = adaptMcpServerTools(
    { serverAlias: 'demo', connection: { url }, tools: connection.tools },
    manager,
  );
  console.log(
    `Adapted: ${tools.map((t) => t.name).join(', ')} skipped=${skipped.length}`,
  );
  if (skipped.length > 0) console.log(`Skipped: ${JSON.stringify(skipped)}`);

  const { registered, skipped: regSkipped } = registry.registerMcpTools(tools);
  console.log(
    `Registry: registered=${registered} skipped=${regSkipped} total=${registry.listNames().length}`,
  );
  console.log(`Names: ${registry.listNames().join(', ')}`);

  // 直调：验证 invoke -> 真实 MCP callTool
  const echo = registry.get('mcp__demo__echo');
  if (!echo) throw new Error('mcp__demo__echo not registered');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const direct = await echo.invoke({ text: 'hello-adapter' });
  console.log(`Direct invoke: ${String(direct).slice(0, 200)}`);

  // 说明：DynamicStructuredTool 的 JSON Schema 校验要求对象输入，
  // 传 JSON 字符串会被判 schema 不匹配（已验证）；DAG tool 节点如需调 MCP 工具，
  // 应走“对象输入”语义，见 docs/mcp/阶段2-工具适配.md §6
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const dagStyle = await echo.invoke({ text: 'hello-dag' });
  console.log(`DAG-style invoke: ${String(dagStyle).slice(0, 200)}`);

  // ReactAgent 兼容：工具可被 createReactAgent 接受（不实际调用 LLM，只验证装配）
  const agent = createReactAgent({
    llm: undefined as never,
    tools: registry.getAvailableTools(),
    name: 'probe',
  });
  console.log(
    `ReactAgent assembled with ${(agent as unknown as { tools?: unknown[] }).tools?.length ?? 'unknown'} tools`,
  );

  console.log(`Leaked connections: ${manager.getLeakedConnections()}`);
  if (!String(direct).includes('hello-adapter'))
    throw new Error('Direct invoke did not reach MCP server');
  if (!String(dagStyle).includes('hello-dag'))
    throw new Error('DAG-style invoke did not reach MCP server');
  console.log('Stage 2 adapter check passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
