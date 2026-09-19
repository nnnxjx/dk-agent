import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { ToolRegistry } from './tool-registry';

function mcpTool(name: string) {
  // eslint-disable-next-line @typescript-eslint/require-await
  return tool(async () => 'ok', {
    name,
    description: `${name} tool`,
    schema: z.object({}),
  });
}

describe('ToolRegistry MCP partition (stage 2)', () => {
  it('refuses to overwrite builtin tools', () => {
    const registry = new ToolRegistry();
    const builtinNames = registry.listNames();
    expect(builtinNames).toContain('web_search');
    // 内置工具名不可被 MCP 分区占用
    expect(registry.registerMcpTool(mcpTool('mcp__web_search'))).toBe(true);
    // 同名再次注册不做静默覆盖
    expect(registry.registerMcpTool(mcpTool('mcp__web_search'))).toBe(false);
    expect(
      registry.getAll().filter((t) => t.name === 'mcp__web_search'),
    ).toHaveLength(1);
  });

  it('rejects builtin registration with reserved prefix', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(mcpTool('mcp__evil'))).toThrow();
  });

  it('supports unregister by server alias', () => {
    const registry = new ToolRegistry();
    registry.registerMcpTools([
      mcpTool('mcp__demo__echo'),
      mcpTool('mcp__demo__fail'),
      mcpTool('mcp__other__echo'),
    ]);
    expect(registry.unregisterMcpToolsByAlias('demo')).toBe(2);
    expect(registry.listNames()).toContain('mcp__other__echo');
    expect(registry.listNames()).not.toContain('mcp__demo__echo');
  });

  it('getAvailableTools returns builtin + mcp without changing defaults', () => {
    const registry = new ToolRegistry();
    registry.registerMcpTool(mcpTool('mcp__demo__echo'));
    const all = registry.getAvailableTools({ tenantId: 't1' });
    expect(all.map((t) => t.name)).toContain('web_search');
    expect(all.map((t) => t.name)).toContain('mcp__demo__echo');
  });
});
