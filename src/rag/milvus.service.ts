import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MilvusClient, DataType, RRFRanker } from '@zilliz/milvus2-sdk-node';
import { hybridCollectionIndexes, hybridCollectionSchema } from './hybrid-collection.schema';

const EMBEDDING_DIM = 1024; // BAAI/bge-m3 default

@Injectable()
export class MilvusService implements OnModuleInit {
  private readonly logger = new Logger(MilvusService.name);
  private client: MilvusClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const host = this.configService.get('milvus.host');
    const port = this.configService.get('milvus.port');

    try {
      this.client = new MilvusClient({
        address: `${host}:${port}`,
        timeout: 5000,
      });
      const healthCheck = this.client.checkHealth();
      const timeout = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Milvus health check timeout')), 5000),
      );
      const health = await Promise.race([healthCheck, timeout]);
      this.logger.log(`Milvus connected: healthy=${(health as any)?.isHealthy}`);
    } catch (err: any) {
      this.logger.warn(`Milvus not available: ${err.message}. RAG features disabled until Milvus is up.`);
      this.client = null;
    }
  }

  /** 获取 client，不可用时抛出明确错误 */
  private requireClient(): MilvusClient {
    if (!this.client) {
      throw new Error('Milvus is not available. Please check Milvus connection.');
    }
    return this.client;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async createCollection(collectionName: string, dim = EMBEDDING_DIM) {
    const client = this.requireClient();
    const exists = await client.hasCollection({ collection_name: collectionName });
    if (exists.value) {
      this.logger.log(`Collection ${collectionName} already exists`);
      return;
    }

    await client.createCollection({
      collection_name: collectionName,
      fields: [
        { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
        { name: 'text', data_type: DataType.VarChar, max_length: 65535 },
        { name: 'vector', data_type: DataType.FloatVector, dim },
        { name: 'metadata', data_type: DataType.JSON },
        { name: 'knowledge_base_id', data_type: DataType.VarChar, max_length: 64 },
      ],
    });

    await client.createIndex({
      collection_name: collectionName,
      field_name: 'vector',
      index_type: 'IVF_FLAT',
      metric_type: 'COSINE',
      params: { nlist: 1024 },
    });

    await client.loadCollection({ collection_name: collectionName });
    this.logger.log(`Collection ${collectionName} created and loaded`);
  }

  /** 创建新版 Dense + BM25 集合。不会触碰旧集合或旧数据卷。 */
  async createHybridCollection(collectionName: string) {
    const client = this.requireClient();
    const exists = await client.hasCollection({ collection_name: collectionName });
    if (exists.value) {
      throw new Error(`Hybrid collection ${collectionName} already exists; refusing to reuse an unknown schema`);
    }

    const version = (await client.getVersion()).version;
    if (!version?.startsWith('2.6.')) {
      throw new Error(`Hybrid collection requires Milvus 2.6.x; connected to ${version}`);
    }

    const created = await client.createCollection(hybridCollectionSchema(collectionName));
    this.assertMilvusSuccess(created, 'create hybrid collection');
    for (const index of hybridCollectionIndexes(collectionName)) {
      this.assertMilvusSuccess(await client.createIndex(index), `create ${index.field_name} index`);
    }
    this.assertMilvusSuccess(
      await client.loadCollectionSync({ collection_name: collectionName }),
      'load hybrid collection',
    );
    this.logger.log(`Hybrid collection ${collectionName} created and loaded`);
  }

  async insertHybridChunks(
    collectionName: string,
    data: Array<{
      id: string;
      text: string;
      dense_vector: number[];
      metadata: Record<string, unknown>;
      knowledge_base_id: string;
    }>,
  ) {
    if (data.some((chunk) => chunk.dense_vector.length !== EMBEDDING_DIM)) {
      throw new Error(`Hybrid chunks must use ${EMBEDDING_DIM}-dimensional dense vectors`);
    }
    const result = await this.requireClient().insert({ collection_name: collectionName, data });
    this.assertMilvusSuccess(result, 'insert hybrid chunks');
    return result;
  }

  async searchDenseV2(collectionName: string, vector: number[], topK = 5, filter?: string) {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(`Hybrid dense query must use ${EMBEDDING_DIM}-dimensional vector`);
    }
    const result = await this.requireClient().search({
      collection_name: collectionName,
      anns_field: 'dense_vector',
      data: vector,
      limit: topK,
      output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
      filter,
    });
    this.assertMilvusSuccess(result, 'search hybrid dense');
    return result.results;
  }

  async searchBm25V2(collectionName: string, query: string, topK = 5, filter?: string) {
    const result = await this.requireClient().search({
      collection_name: collectionName,
      anns_field: 'sparse_vector',
      data: query,
      limit: topK,
      output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
      filter,
    });
    this.assertMilvusSuccess(result, 'search hybrid BM25');
    return result.results;
  }

  async searchHybridV2(
    collectionName: string,
    vector: number[],
    query: string,
    topK = 5,
    filter?: string,
  ) {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(`Hybrid dense query must use ${EMBEDDING_DIM}-dimensional vector`);
    }
    const candidateK = Math.max(topK, 20);
    const result = await this.requireClient().hybridSearch({
      collection_name: collectionName,
      data: [
        { anns_field: 'dense_vector', data: vector, expr: filter },
        { anns_field: 'sparse_vector', data: query, expr: filter },
      ],
      rerank: RRFRanker(60),
      limit: candidateK,
      output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
    });
    this.assertMilvusSuccess(result, 'search hybrid RRF');
    return result.results.slice(0, topK);
  }

  private assertMilvusSuccess(result: any, operation: string) {
    const status = result?.status ?? result;
    if (status?.error_code !== 'Success') {
      throw new Error(`${operation} failed: ${status?.reason || JSON.stringify(status)}`);
    }
  }

  async insert(
    collectionName: string,
    data: Array<{ id: string; text: string; vector: number[]; metadata: any; knowledge_base_id: string }>,
  ) {
    return this.requireClient().insert({ collection_name: collectionName, data });
  }

  async search(
    collectionName: string,
    vector: number[],
    topK = 5,
    filter?: string,
  ) {
    const result = await this.requireClient().search({
      collection_name: collectionName,
      data: [vector],
      limit: topK,
      output_fields: ['text', 'metadata', 'knowledge_base_id'],
      filter
    });
    return result.results;
  }

  async dropCollection(collectionName: string) {
    return this.requireClient().dropCollection({ collection_name: collectionName });
  }
}
