import { createRagRetrievalTool } from './rag-retrieval.tool';
import type { RagService } from '../rag/rag.service';

type ToolOutput = {
  results: Array<{
    chunkId: string;
    text: string;
    knowledgeBaseId: string;
    knowledgeBaseName: string;
    retrievalMode: string;
    localScore: number;
    rankWithinKnowledgeBase: number;
    sources: Array<{ chunkId: string; metadata: Record<string, unknown> }>;
  }>;
  success: boolean;
  partialFailure: boolean;
  failedKnowledgeBases: Array<{
    knowledgeBaseId: string;
    knowledgeBaseName: string;
  }>;
  mergeStrategy: string;
};

function parseOutput(value: unknown): ToolOutput {
  return JSON.parse(String(value)) as ToolOutput;
}

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  DataType: { VarChar: 21, JSON: 23, FloatVector: 101, SparseFloatVector: 104 },
  FunctionType: { BM25: 1 },
}));

describe('rag_retrieval cross-knowledge-base merge', () => {
  it('always uses hybrid search for every knowledge base', async () => {
    const search = jest.fn().mockResolvedValue([]);
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue([
        { id: 'kb-1', name: 'First' },
        { id: 'kb-2', name: 'Second' },
      ]),
      search,
    } as unknown as RagService;

    const tool = createRagRetrievalTool(ragService, 'tenant-1');
    await tool.invoke({ query: 'test', topK: 3 });

    expect(search).toHaveBeenNthCalledWith(
      1,
      'kb-1',
      'tenant-1',
      'test',
      10,
      'hybrid',
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      'kb-2',
      'tenant-1',
      'test',
      10,
      'hybrid',
    );
  });

  it('uses hybrid search when topK is omitted', async () => {
    const search = jest.fn().mockResolvedValue([]);
    const ragService = {
      listKnowledgeBases: jest
        .fn()
        .mockResolvedValue([{ id: 'kb-1', name: 'First' }]),
      search,
    } as unknown as RagService;

    await createRagRetrievalTool(ragService, 'tenant-1').invoke({
      query: 'test',
    });

    expect(search).toHaveBeenCalledWith(
      'kb-1',
      'tenant-1',
      'test',
      10,
      'hybrid',
    );
  });

  it('interleaves local ranks instead of sorting incomparable scores', async () => {
    const search = jest.fn((kbId: string) =>
      kbId === 'kb-1'
        ? [
            { id: 'a1', text: 'First A', metadata: {}, score: 0.01 },
            { id: 'a2', text: 'Second A', metadata: {}, score: 0.005 },
          ]
        : [
            { id: 'b1', text: 'First B', metadata: {}, score: 100 },
            { id: 'b2', text: 'Second B', metadata: {}, score: 90 },
          ],
    );
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue([
        { id: 'kb-2', name: 'Second' },
        { id: 'kb-1', name: 'First' },
      ]),
      search,
    } as unknown as RagService;

    const output = parseOutput(
      await createRagRetrievalTool(ragService, 'tenant-1').invoke({
        query: 'test',
        topK: 4,
      }),
    );

    expect(output.results.map((hit) => hit.chunkId)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
    ]);
    expect(output.results[0]).toMatchObject({
      knowledgeBaseId: 'kb-1',
      knowledgeBaseName: 'First',
      retrievalMode: 'hybrid',
      localScore: 0.01,
      rankWithinKnowledgeBase: 1,
    });
    expect(output.results[0]).not.toHaveProperty('score');
    expect(output.mergeStrategy).toBe('rank_interleave');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('deduplicates identical text while retaining every source', async () => {
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue([
        { id: 'kb-1', name: 'First' },
        { id: 'kb-2', name: 'Second' },
      ]),
      search: jest.fn((kbId: string) =>
        kbId === 'kb-1'
          ? [
              {
                id: 'a1',
                text: 'same  text',
                metadata: { file: 'a' },
                score: 0.1,
              },
            ]
          : [
              {
                id: 'b1',
                text: 'same text',
                metadata: { file: 'b' },
                score: 90,
              },
              { id: 'b2', text: 'unique', metadata: {}, score: 80 },
            ],
      ),
    } as unknown as RagService;

    const output = parseOutput(
      await createRagRetrievalTool(ragService, 'tenant-1').invoke({
        query: 'test',
        topK: 2,
      }),
    );

    expect(output.results.map((hit) => hit.text)).toEqual([
      'same  text',
      'unique',
    ]);
    expect(output.results[0].sources.map((source) => source.chunkId)).toEqual([
      'a1',
      'b1',
    ]);
    expect(output.results[0].sources[1].metadata).toEqual({ file: 'b' });
  });

  it('limits concurrent KB searches and records partial failures', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const search = jest.fn(async (kbId: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      if (kbId === 'kb-3') throw new Error('Milvus unavailable');
      return [
        { id: `hit-${kbId}`, text: `text-${kbId}`, metadata: {}, score: 1 },
      ];
    });
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({
          id: `kb-${i + 1}`,
          name: `KB ${i + 1}`,
        })),
      ),
      search,
    } as unknown as RagService;

    const output = parseOutput(
      await createRagRetrievalTool(ragService, 'tenant-1').invoke({
        query: 'test',
        topK: 5,
      }),
    );

    expect(maxInFlight).toBe(4);
    expect(search).toHaveBeenCalledTimes(7);
    expect(output.success).toBe(true);
    expect(output.partialFailure).toBe(true);
    expect(output.failedKnowledgeBases).toEqual([
      { knowledgeBaseId: 'kb-3', knowledgeBaseName: 'KB 3' },
    ]);
    expect(output.results).toHaveLength(5);
  });

  it('reports failure when every KB search fails', async () => {
    const ragService = {
      listKnowledgeBases: jest
        .fn()
        .mockResolvedValue([{ id: 'kb-1', name: 'First' }]),
      search: jest.fn().mockRejectedValue(new Error('offline')),
    } as unknown as RagService;

    const output = parseOutput(
      await createRagRetrievalTool(ragService, 'tenant-1').invoke({
        query: 'test',
      }),
    );

    expect(output).toMatchObject({
      success: false,
      partialFailure: false,
      results: [],
    });
    expect(output.failedKnowledgeBases).toHaveLength(1);
  });
});


describe('global cross-KB reranking', () => {
  const fixture = () => ({
    listKnowledgeBases: jest.fn().mockResolvedValue([{ id: 'a', name: 'noise' }, { id: 'b', name: 'target' }, { id: 'c', name: 'duplicate' }]),
    search: jest.fn(async (id: string) => [{ id, text: id === 'a' ? 'unrelated text' : 'correct evidence', metadata: { source: id }, score: 1 }]),
  }) as unknown as RagService;
  it('reranks before truncation and retains duplicate sources', async () => {
    const rank = jest.fn(async () => ({ applied: true, order: [{ index: 1, score: .9 }, { index: 0, score: .1 }], elapsedMs: 2 }));
    const result = JSON.parse(String(await createRagRetrievalTool(fixture(), 'tenant', { rank } as any).invoke({ query: 'q', topK: 1 })));
    expect(rank).toHaveBeenCalledWith('q', ['unrelated text', 'correct evidence']);
    expect(result.results[0].text).toBe('correct evidence');
    expect(result.results[0].sources.map((s: any) => s.knowledgeBaseId)).toEqual(['b','c']);
    expect(result.results[0].rerankScore).toBe(.9);
    expect(result.mergeStrategy).toBe('global_semantic_rerank');
  });
  it('preserves original ordering and marks fallback on rerank failure', async () => {
    const rank = jest.fn(async () => ({ applied: false, order: [], reason: 'http_503', elapsedMs: 2 }));
    const result = JSON.parse(String(await createRagRetrievalTool(fixture(), 'tenant', { rank } as any).invoke({ query: 'q', topK: 1 })));
    expect(result.results[0].knowledgeBaseId).toBe('a');
    expect(result.mergeStrategy).toBe('rank_interleave');
    expect(result.reranking.fallbackReason).toBe('http_503');
    expect(result.success).toBe(true);
  });
});
