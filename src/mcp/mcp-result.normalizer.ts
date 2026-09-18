/** 阶段 1：MCP callTool 返回归一化（纯函数，可单测） */
export interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  uri?: string;
  name?: string;
}

export interface McpNormalizedResult {
  /** 给 Agent/日志的可读文本，已截断并标注 */
  text: string;
  /** 远端是否标记 isError */
  isError: boolean;
  /** 是否发生截断 */
  truncated: boolean;
  /** 原始内容块数量 */
  blockCount: number;
  /** 结构化内容（远端 structuredContent，原样透传，不做执行） */
  structuredContent?: Record<string, unknown>;
}

export const MCP_RESULT_LIMITS = {
  /** 单个文本块上限，避免超大返回污染 prompt/日志 */
  maxTextBytes: 32_768,
  /** 汇总文本上限 */
  maxTotalBytes: 65_536,
} as const;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) return { text: value, truncated: false };
  const buffer = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return { text: `${buffer.toString('utf8')}\n…[truncated ${byteLength(value) - maxBytes} bytes]`, truncated: true };
}

function describeBlock(block: McpContentBlock, index: number): string {
  switch (block?.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
      return `[image ${index}: mimeType=${block.mimeType ?? 'unknown'} bytes=${(block.data ?? '').length}]`;
    case 'audio':
      return `[audio ${index}: mimeType=${block.mimeType ?? 'unknown'} bytes=${(block.data ?? '').length}]`;
    case 'resource': {
      const resource = block.resource;
      if (!resource) return `[resource ${index}: empty]`;
      if (typeof resource.text === 'string') return resource.text;
      if (typeof resource.blob === 'string')
        return `[resource ${index}: uri=${resource.uri ?? 'unknown'} blobBytes=${resource.blob.length}]`;
      return `[resource ${index}: uri=${resource.uri ?? 'unknown'}]`;
    }
    case 'resource_link':
      return `[resource_link ${index}: name=${block.name ?? 'unknown'} uri=${block.uri ?? 'unknown'}]`;
    default:
      // 未知类型不丢弃，直接 JSON 保留可排查性（长度仍受总上限约束）
      return `[${block?.type ?? 'unknown'} ${index}: ${JSON.stringify(block).slice(0, 500)}]`;
  }
}

/**
 * 将 callTool 的 content 数组归一化为可读文本。
 * - text 块拼接；image/audio/resource/resource_link 转为占位描述，不把二进制塞进 prompt
 * - structuredContent 原样透传，不解析执行
 * - 超长截断并保留 truncated 标记
 */
export function normalizeMcpCallResult(
  content: unknown,
  options?: { isError?: boolean; structuredContent?: Record<string, unknown> },
): McpNormalizedResult {
  const blocks = (Array.isArray(content) ? content : []) as McpContentBlock[];
  const parts: string[] = [];
  let truncated = false;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index] ?? {};
    let part = describeBlock(block, index);
    if (block?.type === 'text' && typeof block.text === 'string' && byteLength(part) > MCP_RESULT_LIMITS.maxTextBytes) {
      const truncatedPart = truncateText(part, MCP_RESULT_LIMITS.maxTextBytes);
      part = truncatedPart.text;
      truncated = true;
    }
    parts.push(part);
  }

  let text = parts.filter((part) => part.length > 0).join('\n');
  if (!text) text = options?.structuredContent ? JSON.stringify(options.structuredContent) : '[]';
  if (byteLength(text) > MCP_RESULT_LIMITS.maxTotalBytes) {
    const truncatedAll = truncateText(text, MCP_RESULT_LIMITS.maxTotalBytes);
    text = truncatedAll.text;
    truncated = true;
  }

  return {
    text,
    isError: Boolean(options?.isError),
    truncated,
    blockCount: blocks.length,
    structuredContent: options?.structuredContent,
  };
}
