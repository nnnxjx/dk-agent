import { Injectable, Logger } from '@nestjs/common';
import { StructuredToolInterface } from '@langchain/core/tools';
import { webSearchTool } from './web-search.tool';

/**
 * 工具注册中心（阶段 2：内置工具 + MCP 工具分区存放）
 * - 内置工具：写死的 web_search 等，优先级最高，不可被覆盖
 * - MCP 工具：必须以 mcp__ 开头，单独分区存放
 * - 同名冲突时拒绝注册并告警，不做静默覆盖
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly builtinTools = new Map<string, StructuredToolInterface>();
  private readonly mcpTools = new Map<string, StructuredToolInterface>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    this.register(webSearchTool);
    this.logger.log(`Registered ${this.builtinTools.size} default tools`);
  }

  /** 注册内置工具：禁止 mcp__ 前缀，避免与 MCP 分区混淆 */
  register(tool: StructuredToolInterface) {
    if (tool.name.startsWith('mcp__')) {
      throw new Error(
        `Builtin tool name "${tool.name}" must not use reserved prefix "mcp__"`,
      );
    }
    this.builtinTools.set(tool.name, tool);
  }

  /**
   * 注册 MCP 工具：必须以 mcp__ 开头；与内置工具或已注册 MCP 工具同名时拒绝覆盖。
   * 返回 false 表示被拒绝，调用方应记录 skipped 原因。
   */
  registerMcpTool(tool: StructuredToolInterface): boolean {
    if (!tool.name.startsWith('mcp__')) {
      throw new Error(`MCP tool name "${tool.name}" must start with "mcp__"`);
    }
    if (this.builtinTools.has(tool.name)) {
      this.logger.warn(
        `Refused MCP tool "${tool.name}": conflicts with builtin tool`,
      );
      return false;
    }
    if (this.mcpTools.has(tool.name)) {
      this.logger.warn(
        `Refused MCP tool "${tool.name}": already registered, skip silent overwrite`,
      );
      return false;
    }
    this.mcpTools.set(tool.name, tool);
    return true;
  }

  /** 批量注册，返回成功与跳过数量 */
  registerMcpTools(tools: StructuredToolInterface[]): {
    registered: number;
    skipped: number;
  } {
    let registered = 0;
    let skipped = 0;
    for (const tool of tools) {
      if (this.registerMcpTool(tool)) registered += 1;
      else skipped += 1;
    }
    return { registered, skipped };
  }

  /** 移除某个 Server 命名空间下的全部 MCP 工具（刷新/禁用时使用） */
  unregisterMcpToolsByAlias(serverAlias: string): number {
    const segment = serverAlias
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const prefix = `mcp__${segment}__`;
    let removed = 0;
    for (const name of Array.from(this.mcpTools.keys())) {
      if (name.startsWith(prefix)) {
        this.mcpTools.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  clearMcpTools(): void {
    this.mcpTools.clear();
  }

  get(name: string): StructuredToolInterface | undefined {
    return this.builtinTools.get(name) ?? this.mcpTools.get(name);
  }

  getAll(): StructuredToolInterface[] {
    return [...this.builtinTools.values(), ...this.mcpTools.values()];
  }

  getBuiltinTools(): StructuredToolInterface[] {
    return Array.from(this.builtinTools.values());
  }

  getMcpTools(): StructuredToolInterface[] {
    return Array.from(this.mcpTools.values());
  }

  getByNames(names: string[]): StructuredToolInterface[] {
    return names
      .map((n) => this.get(n))
      .filter(Boolean) as StructuredToolInterface[];
  }

  /**
   * 阶段 2 预留的统一入口：按上下文返回可用工具。
   * 当前阶段 3 的 DB/授权未落地，context 仅做透传校验；
   * 阶段 6 会在此处执行租户/Server/工具/策略四层过滤。
   */
  getAvailableTools(context?: {
    tenantId?: string;
    workflowId?: string;
    agentName?: string;
  }): StructuredToolInterface[] {
    if (context && typeof context !== 'object') {
      throw new Error('Invalid tool context');
    }
    return this.getAll();
  }

  listNames(): string[] {
    return [...this.builtinTools.keys(), ...this.mcpTools.keys()];
  }
}
