import { normalizeMcpCallResult } from './mcp-result.normalizer';

describe('normalizeMcpCallResult (stage 1)', () => {
  it('joins text blocks', () => {
    const result = normalizeMcpCallResult([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
    expect(result.text).toBe('hello\nworld');
    expect(result.isError).toBe(false);
    expect(result.blockCount).toBe(2);
  });

  it('describes binary/resource blocks instead of inlining bytes', () => {
    const result = normalizeMcpCallResult([
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'file:///a.txt', text: 'file-body' },
      },
      { type: 'resource_link', uri: 'https://example.com', name: 'doc' },
    ]);
    expect(result.text).toContain('[image 0:');
    expect(result.text).toContain('file-body');
    expect(result.text).toContain('[resource_link 2:');
  });

  it('keeps isError flag for remote failures', () => {
    const result = normalizeMcpCallResult([{ type: 'text', text: 'boom' }], {
      isError: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('boom');
  });

  it('truncates oversized text and marks truncated', () => {
    const result = normalizeMcpCallResult([
      { type: 'text', text: 'x'.repeat(100_000) },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('[truncated');
  });

  it('falls back to structuredContent when no text blocks', () => {
    const result = normalizeMcpCallResult([], {
      structuredContent: { ok: true },
    });
    expect(result.text).toContain('"ok"');
    expect(result.structuredContent).toEqual({ ok: true });
  });
});
