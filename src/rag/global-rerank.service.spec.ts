import { ConfigService } from '@nestjs/config';
import { GlobalRerankService } from './global-rerank.service';

describe('GlobalRerankService', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  function service(extra: Record<string, unknown> = {}) {
    const values = { 'rag.rerank.enabled': true, 'rag.rerank.baseUrl': 'https://rerank.test/v1/', 'rag.rerank.apiKey': 'test-key', ...extra };
    return new GlobalRerankService(new ConfigService(values));
  }
  it('scores the whole pool and uses returned indices instead of provider text', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }) });
    const result = await service().rank('question', ['noise', 'answer']);
    expect(result.applied).toBe(true);
    expect(result.order.map((r) => r.index)).toEqual([1, 0]);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://rerank.test/v1/rerank');
    expect(JSON.parse(options.body)).toMatchObject({ documents: ['noise', 'answer'], top_n: 2, return_documents: false });
  });
  it.each([
    [{ index: 0, relevance_score: 1 }],
    [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }],
    [{ index: -1, relevance_score: 1 }, { index: 1, relevance_score: 0 }],
    [{ index: 0, relevance_score: NaN }, { index: 1, relevance_score: 0 }],
  ])('falls back on incomplete or malformed response %j', async (...results) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results }) });
    expect((await service().rank('q', ['a', 'b'])).applied).toBe(false);
  });
  it('does not call external services when disabled or above candidate limit', async () => {
    global.fetch = jest.fn();
    expect((await service({ 'rag.rerank.enabled': false }).rank('q', ['a','b'])).reason).toBe('disabled');
    expect((await service({ 'rag.rerank.maxCandidates': 1 }).rank('q', ['a','b'])).reason).toBe('candidate_limit_exceeded');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('falls back on HTTP errors without reading error bodies', async () => {
    const json = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json });
    expect((await service().rank('q', ['a','b'])).reason).toBe('http_503');
    expect(json).not.toHaveBeenCalled();
  });
  it('skips requests without configuration or sufficient candidates', async () => {
    global.fetch = jest.fn();
    expect((await service({ 'rag.rerank.baseUrl': '' }).rank('q', ['a','b'])).reason).toBe('not_configured');
    expect((await service().rank('q', [])).reason).toBe('insufficient_candidates');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('returns sanitized fallback on timeout or network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('secret response details'));
    const result = await service().rank('q',['a','b']);
    expect(result.reason).toBe('request_failed_or_timeout');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
