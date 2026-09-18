// @ts-nocheck
/* 阶段 1 本地联调脚本：Streamable HTTP 测试 Server，仅本地使用
 * 工具：echo（文本回显）、fail（返回 isError）、big（超长文本，验证截断）
 */
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.MCP_TEST_PORT || 3100);

function createServer(): McpServer {
  const server = new McpServer({ name: 'nest-agent-mcp-test-server', version: '0.1.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo back the input text for MCP connectivity testing.',
      inputSchema: { text: z.string().describe('Text to echo back') },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );
  server.registerTool(
    'fail',
    {
      description: 'Always returns isError for normalizer testing.',
      inputSchema: { reason: z.string().optional().describe('Failure reason') },
    },
    async ({ reason }) => ({
      content: [{ type: 'text', text: `fail: ${reason ?? 'boom'}` }],
      isError: true,
    }),
  );
  server.registerTool(
    'big',
    {
      description: 'Returns oversized text for truncation testing.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'x'.repeat(100_000) }] }),
  );
  return server;
}

async function main() {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP test server error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP test server error' });
      }
      await server.close().catch(() => undefined);
    }
  });

  app.listen(PORT, () => {
    console.log(`MCP test server listening on http://localhost:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
