import { createRagRetrievalTool } from './rag-retrieval.tool';
import type { RagService } from '../rag/rag.service';

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  DataType: { VarChar: 21, JSON: 23, FloatVector: 101, SparseFloatVector: 104 },
  FunctionType: { BM25: 1 },
}));

describe('rag_retrieval request mode', () => {
  it('passes the selected mode to every knowledge base search', async () => {
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue([
        { id: 'kb-1', name: 'First' },
        { id: 'kb-2', name: 'Second' },
      ]),
      search: jest.fn().mockResolvedValue([]),
    } as unknown as RagService;

    const tool = createRagRetrievalTool(ragService, 'tenant-1', 'hybrid');
    await tool.invoke({ query: 'test', topK: 3 });

    expect(ragService.search).toHaveBeenNthCalledWith(1, 'kb-1', 'tenant-1', 'test', 3, 'hybrid');
    expect(ragService.search).toHaveBeenNthCalledWith(2, 'kb-2', 'tenant-1', 'test', 3, 'hybrid');
  });

  it('leaves the mode undefined when the request omits it', async () => {
    const ragService = {
      listKnowledgeBases: jest.fn().mockResolvedValue([{ id: 'kb-1', name: 'First' }]),
      search: jest.fn().mockResolvedValue([]),
    } as unknown as RagService;

    await createRagRetrievalTool(ragService, 'tenant-1').invoke({ query: 'test' });

    expect(ragService.search).toHaveBeenCalledWith('kb-1', 'tenant-1', 'test', 5, undefined);
  });
});
