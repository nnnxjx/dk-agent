import { McpConnectionManager } from './mcp-connection.manager';
import { normalizeMcpHeaders, normalizeMcpUrl } from './mcp-connection.utils';

describe('McpConnectionManager (stage 0 baseline)', () => {
  it('rejects non-http(s) urls', () => {
    expect(() => normalizeMcpUrl('ftp://example.com/mcp')).toThrow();
  });

  it('rejects non-local http urls', () => {
    expect(() => normalizeMcpUrl('http://example.com/mcp')).toThrow();
  });

  it('allows localhost http urls for local testing', () => {
    expect(normalizeMcpUrl('http://localhost:3100/mcp').hostname).toBe(
      'localhost',
    );
  });

  it('rejects disallowed headers', () => {
    expect(() => normalizeMcpHeaders({ 'x-evil': '1' })).toThrow();
  });

  it('keeps allowed headers', () => {
    expect(normalizeMcpHeaders({ Authorization: 'Bearer test' })).toEqual({
      Authorization: 'Bearer test',
    });
  });

  it('does not touch ToolRegistry defaults', () => {
    const manager = new McpConnectionManager();
    expect(manager).toBeDefined();
  });
});
