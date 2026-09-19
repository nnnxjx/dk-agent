import { adaptMcpServerTools, buildMcpQualifiedName } from './mcp-tool.adapter';
import { McpConnectionConfig } from './interfaces/mcp-config.interface';

const connection: McpConnectionConfig = { url: 'http://localhost:3100/mcp' };

function fakeManager(
  impl?: (
    toolName: string,
  ) => Promise<{ text: string; truncated: boolean; blockCount: number }>,
) {
  return {
    callTool: jest.fn(
      async (_config: McpConnectionConfig, toolName: string) => {
        if (impl)
          return {
            isError: false,
            structuredContent: undefined,
            ...(await impl(toolName)),
          };
        return {
          text: `ok:${toolName}`,
          isError: false,
          truncated: false,
          blockCount: 1,
        };
      },
    ),
  } as unknown as { callTool: (...args: never[]) => Promise<never> };
}

describe('mcp-tool.adapter (stage 2)', () => {
  it('builds namespaced qualified names', () => {
    expect(buildMcpQualifiedName('GitHub', 'Create Issue')).toBe(
      'mcp__github__create_issue',
    );
    expect(buildMcpQualifiedName('demo', 'echo')).toBe('mcp__demo__echo');
  });

  it('adapts remote tools to LangChain tools without overwriting builtins', async () => {
    const manager = fakeManager();
    const { tools, skipped } = adaptMcpServerTools(
      {
        serverAlias: 'demo',
        connection,
        tools: [
          {
            name: 'echo',
            description: 'Echo tool',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      },
      manager,
    );
    expect(skipped).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__demo__echo');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const output = await tools[0].invoke({ text: 'hi' });
    expect(String(output)).toContain('ok:echo');
  });

  it('skips oversized schema instead of registering', () => {
    const manager = fakeManager();
    const { tools, skipped } = adaptMcpServerTools(
      {
        serverAlias: 'demo',
        connection,
        tools: [
          {
            name: 'huge',
            description: 'huge',
            inputSchema: {
              type: 'object',
              properties: { blob: { type: 'string', maxLength: 100_000 } },
              extra: 'x'.repeat(40_000),
            },
          },
        ],
      },
      manager,
    );
    expect(tools).toHaveLength(0);
    expect(skipped[0].name).toBe('huge');
  });

  it('returns error text instead of throwing when remote call fails', async () => {
    const manager = {
      // eslint-disable-next-line @typescript-eslint/require-await
      callTool: jest.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as { callTool: (...args: never[]) => Promise<never> };
    const { tools } = adaptMcpServerTools(
      { serverAlias: 'demo', connection, tools: [{ name: 'echo' }] },
      manager,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const output = await tools[0].invoke({ text: 'hi' });
    expect(String(output)).toContain('failed');
  });

  it('deduplicates qualified names inside one server', () => {
    const manager = fakeManager();
    const { tools, skipped } = adaptMcpServerTools(
      {
        serverAlias: 'demo',
        connection,
        tools: [{ name: 'Echo' }, { name: 'echo' }],
      },
      manager,
    );
    expect(tools).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});
