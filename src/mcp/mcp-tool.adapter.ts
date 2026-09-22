import {
  DynamicStructuredTool,
  StructuredToolInterface,
} from '@langchain/core/tools';
import { MCP_CONSTANTS } from './mcp.constants';
import { McpError } from './errors/mcp.errors';
import {
  McpConnectionConfig,
  McpToolInfo,
} from './interfaces/mcp-config.interface';
import {
  normalizeMcpUrl,
  sanitizeMcpConfigForLog,
} from './mcp-connection.utils';
import type { McpConnectionManager } from './mcp-connection.manager';

/**
 * 阶段 2：MCP 工具适配到 LangChain StructuredTool（纯 HTTP）
 * - Agent 只看到标准 StructuredTool，不感知 MCP 协议
 * - 工具名带命名空间：mcp__<alias>__<tool>
 * - 远端 inputSchema 仅做“形状校验 + 大小上限”，不拼接成可执行代码
 */
export interface McpAdaptedToolContext {
  /** 工具命名空间，对应 Server alias，租户内唯一 */
  serverAlias: string;
  /** 远端 Server 连接配置（URL + 白名单 headers + 超时） */
  connection: McpConnectionConfig;
  /** 远端工具清单（来自 testConnection/listTools，原样透传） */
  tools: McpToolInfo[];
}

const JSON_SCHEMA_TYPES = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);

function sanitizeNameSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

/** 生成平台内唯一工具名，避免不同 Server 的同名工具冲突 */
export function buildMcpQualifiedName(
  serverAlias: string,
  toolName: string,
): string {
  return `mcp__${sanitizeNameSegment(serverAlias, 'server')}__${sanitizeNameSegment(toolName, 'tool')}`;
}

function truncateDescription(
  description: string | undefined,
  toolName: string,
): string {
  const base = (description ?? '').trim() || `MCP tool "${toolName}"`;
  const max = MCP_CONSTANTS.maxToolDescriptionChars;
  if (base.length <= max) return base;
  return `${base.slice(0, max)}…[truncated ${base.length - max} chars]`;
}

/**
 * 远端 inputSchema 处理（阶段 2 约束）：
 * - 仅透传 JSON Schema 的 properties，不做 zod 转换、不做代码生成
 * - 兼容省略 type 但带 properties 的写法；非对象/非法 properties 直接拒绝
 * - 超大 schema 直接拒绝，避免污染 prompt 与内存
 * - 注意：DynamicStructuredTool 的 JSON Schema 走 @cfworker/json-schema 校验，
 *   传 JSON 字符串会被判 schema 不匹配；DAG tool 节点语义见 docs/mcp/阶段2-工具适配.md
 */
function toJsonSchema(
  inputSchema: McpToolInfo['inputSchema'],
  toolName: string,
): Record<string, unknown> {
  if (
    !inputSchema ||
    typeof inputSchema !== 'object' ||
    Array.isArray(inputSchema)
  ) {
    return { type: 'object', properties: {} };
  }
  const schema = inputSchema;
  const serialized = JSON.stringify(schema);
  if (
    Buffer.byteLength(serialized, 'utf8') > MCP_CONSTANTS.maxToolSchemaBytes
  ) {
    throw new McpError(
      `MCP tool "${toolName}" schema too large (${Buffer.byteLength(serialized, 'utf8')} bytes)`,
      'MCP_INVALID_CONFIG',
    );
  }
  const type = schema.type;
  const properties = schema.properties;
  if (
    type !== undefined &&
    type !== 'object' &&
    !(typeof type === 'string' && JSON_SCHEMA_TYPES.has(type))
  ) {
    throw new McpError(
      `MCP tool "${toolName}" has unsupported schema type`,
      'MCP_INVALID_CONFIG',
    );
  }
  if (
    properties !== undefined &&
    (typeof properties !== 'object' ||
      properties === null ||
      Array.isArray(properties))
  ) {
    throw new McpError(
      `MCP tool "${toolName}" has invalid schema properties`,
      'MCP_INVALID_CONFIG',
    );
  }
  return {
    type: 'object',
    properties: properties ?? {},
  };
}

function toArgsObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    if (!input.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // DAG 的 tool 节点可能传字符串，这里保持兼容：整体按空对象处理并由远端校验
    }
    return {};
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/**
 * 将单个远端 MCP 工具包装为 LangChain StructuredTool。
 * 执行时每次新建连接、用完关闭；错误文本直接返回给 Agent，不抛到图外。
 */
export function adaptMcpToolToLangChain(
  serverAlias: string,
  connection: McpConnectionConfig,
  tool: McpToolInfo,
  manager: Pick<McpConnectionManager, 'callTool'>,
  options?: { guard?: () => Promise<void> },
): StructuredToolInterface {
  // 前置校验：非法 URL 直接拒绝注册，不等到运行时
  normalizeMcpUrl(connection.url);
  const qualifiedName = buildMcpQualifiedName(serverAlias, tool.name);
  const schema = toJsonSchema(tool.inputSchema, tool.name);
  const safeLog = sanitizeMcpConfigForLog(connection);

  const dynamicTool = new DynamicStructuredTool({
    name: qualifiedName,
    description: truncateDescription(tool.description, tool.name),
    schema,
    func: async (input: unknown) => {
      const args = toArgsObject(input);
      try {
        // 阶段 6 调用入口二次校验：授权/状态非法直接返回拒绝文本
        await options?.guard?.();
        const result = await manager.callTool(connection, tool.name, args);
        // 阶段 1 的 normalizer 已处理截断与占位描述，这里保留截断标记便于审计
        return result.truncated
          ? `${result.text}\n[mcp truncated=true blocks=${result.blockCount}]`
          : result.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `[MCP tool "${tool.name}" failed] ${message.slice(0, 1000)} (server=${safeLog.url})`;
      }
    },
  });
  // 附加审计元数据：不进入 prompt，仅供日志/阶段 6 授权使用
  (
    dynamicTool as StructuredToolInterface & {
      metadata?: Record<string, unknown>;
    }
  ).metadata = {
    mcpServerAlias: sanitizeNameSegment(serverAlias, 'server'),
    mcpToolName: tool.name,
    mcpQualifiedName: qualifiedName,
    mcpUrl: safeLog.url,
  };
  return dynamicTool;
}

/** 批量适配一个 Server 的全部工具，单个工具 schema 非法时跳过该工具 */
export function adaptMcpServerTools(
  ctx: McpAdaptedToolContext,
  manager: Pick<McpConnectionManager, 'callTool'>,
): {
  tools: StructuredToolInterface[];
  skipped: Array<{ name: string; reason: string }>;
} {
  const tools: StructuredToolInterface[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const tool of ctx.tools) {
    try {
      const adapted = adaptMcpToolToLangChain(
        ctx.serverAlias,
        ctx.connection,
        tool,
        manager,
      );
      if (seen.has(adapted.name)) {
        skipped.push({
          name: tool.name,
          reason: `duplicate qualified name ${adapted.name}`,
        });
        continue;
      }
      seen.add(adapted.name);
      tools.push(adapted);
    } catch (error) {
      skipped.push({
        name: tool.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { tools, skipped };
}
