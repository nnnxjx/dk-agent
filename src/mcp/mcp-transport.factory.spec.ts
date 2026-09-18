import { createMcpClient, createStreamableHttpTransport } from './mcp-transport.factory';

describe('mcp-transport.factory (stage 1)', () => {
  it('creates a fresh transport per call (never reuse started transport)', () => {
    const config = { url: 'http://localhost:3100/mcp' };
    const first = createStreamableHttpTransport(config);
    const second = createStreamableHttpTransport(config);
    expect(first).not.toBe(second);
  });

  it('rejects invalid urls before creating client', () => {
    expect(() => createMcpClient({ url: 'ftp://example.com/mcp' })).toThrow();
  });

  it('rejects disallowed headers before creating client', () => {
    expect(() => createMcpClient({ url: 'http://localhost:3100/mcp', headers: { 'x-evil': '1' } })).toThrow();
  });
});
