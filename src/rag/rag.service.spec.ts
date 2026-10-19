import { BadRequestException } from '@nestjs/common';
import { RagService } from './rag.service';

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  DataType: { VarChar: 21, JSON: 23, FloatVector: 101, SparseFloatVector: 104 },
  FunctionType: { BM25: 1 },
}));

describe('RagService new Milvus schema', () => {
  const tenantId = 'tenant-1';
  const kbId = '11111111-1111-4111-8111-111111111111';
  let repo: any;
  let milvus: any;
  let service: RagService;

  beforeEach(() => {
    repo = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => data),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    milvus = {
      createHybridCollection: jest.fn(),
      insertHybridChunks: jest.fn(),
      searchDenseV2: jest.fn(),
      searchBm25V2: jest.fn(),
      searchHybridV2: jest.fn(),
      dropCollection: jest.fn(),
    };
    service = new RagService(repo, milvus, {
      get: jest.fn(() => 'test-key'),
    } as any);
  });

  it('creates a hybrid collection without a schema version field', async () => {
    const created = await service.createKnowledgeBase('test', '', tenantId);
    expect(created).not.toHaveProperty('collectionSchemaVersion');
    expect(created.collectionName).toMatch(/^kb_[0-9a-f]{32}$/);
    expect(milvus.createHybridCollection).toHaveBeenCalledWith(created.collectionName);
  });

  it('writes text and dense vector but no client-generated sparse vector', async () => {
    repo.findOne.mockResolvedValue({
      id: kbId, tenantId, name: 'test', collectionName: 'kb_test',
      chunkSize: 1000, chunkOverlap: 200,
      documentCount: 0,
    });
    (service as any).embeddings = { embedDocuments: jest.fn().mockResolvedValue([Array(1024).fill(0)]) };

    await service.addDocuments(kbId, tenantId, [{ content: '一键中断', metadata: { source: 'test' } }]);

    const chunks = milvus.insertHybridChunks.mock.calls[0][1];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      text: '一键中断', dense_vector: expect.any(Array), knowledge_base_id: kbId,
      metadata: { source: 'test', chunkIndex: 0 },
    });
    expect(chunks[0]).not.toHaveProperty('sparse_vector');
    expect(chunks[0]).not.toHaveProperty('vector');
  });

  it('uses the collection name without checking a schema version', async () => {
    repo.findOne.mockResolvedValue({
      id: kbId, tenantId, collectionName: 'kb_test',
    });
    (service as any).embeddings = { embedQuery: jest.fn().mockResolvedValue(Array(1024).fill(0)) };
    milvus.searchDenseV2.mockResolvedValue([]);

    await expect(service.search(kbId, tenantId, 'query')).resolves.toEqual([]);
    await service.deleteKnowledgeBase(kbId, tenantId);
    expect(milvus.searchDenseV2).toHaveBeenCalledWith(
      'kb_test', expect.any(Array), 5, `knowledge_base_id == "${kbId}"`,
    );
    expect(milvus.dropCollection).toHaveBeenCalledWith('kb_test');
  });

  it('uses BM25 text without an embedding request', async () => {
    repo.findOne.mockResolvedValue({ id: kbId, tenantId, collectionName: 'kb_test' });
    const embedQuery = jest.fn();
    (service as any).embeddings = { embedQuery };
    milvus.searchBm25V2.mockResolvedValue([{ id: 'chunk-1', text: '命中', metadata: {}, score: 3 }]);

    const hits = await service.search(kbId, tenantId, ' RUN_CANCELLED ', 3, 'bm25');

    expect(embedQuery).not.toHaveBeenCalled();
    expect(milvus.searchBm25V2).toHaveBeenCalledWith(
      'kb_test', 'RUN_CANCELLED', 3, `knowledge_base_id == "${kbId}"`,
    );
    expect(hits[0]).toMatchObject({ id: 'chunk-1', retrievalMode: 'bm25', knowledgeBaseId: kbId });
  });

  it('uses both query text and embedding for Hybrid mode', async () => {
    repo.findOne.mockResolvedValue({ id: kbId, tenantId, collectionName: 'kb_test' });
    const queryVector = Array(1024).fill(0);
    const embedQuery = jest.fn().mockResolvedValue(queryVector);
    (service as any).embeddings = { embedQuery };
    milvus.searchHybridV2.mockResolvedValue([]);

    await service.search(kbId, tenantId, '一键中断', 5, 'hybrid');

    expect(embedQuery).toHaveBeenCalledWith('一键中断');
    expect(milvus.searchHybridV2).toHaveBeenCalledWith(
      'kb_test', queryVector, '一键中断', 5, `knowledge_base_id == "${kbId}"`,
    );
  });

  it('rejects oversized topK before requesting embeddings', async () => {
    repo.findOne.mockResolvedValue({ id: kbId, tenantId, collectionName: 'kb_test' });
    const embedQuery = jest.fn();
    (service as any).embeddings = { embedQuery };
    await expect(service.search(kbId, tenantId, 'query', 100)).rejects.toBeInstanceOf(BadRequestException);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid retrieval mode', async () => {
    repo.findOne.mockResolvedValue({ id: kbId, tenantId, collectionName: 'kb_test' });
    await expect(service.search(kbId, tenantId, 'query', 5, 'invalid' as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(milvus.searchDenseV2).not.toHaveBeenCalled();
  });
});
