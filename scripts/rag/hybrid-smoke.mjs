#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { MilvusClient, DataType, FunctionType, RRFRanker } from '@zilliz/milvus2-sdk-node';

// 只连接隔离测试端口，避免把临时集合建到现有的 19530 实例。
const address = '127.0.0.1:19531';
const collectionName = `rag_hybrid_smoke_${randomUUID().replaceAll('-', '')}`;
const client = new MilvusClient({ address, timeout: 30000 });
let created = false;

function assertSuccess(response, operation) {
  const status = response?.status ?? response;
  if (status?.error_code && status.error_code !== 'Success') {
    throw new Error(`${operation} 失败：${JSON.stringify(response)}`);
  }
}

function assertHit(response, expectedId, operation) {
  assertSuccess(response, operation);
  const results = response?.results ?? [];
  if (!Array.isArray(results) || !results.some((row) => row.id === expectedId)) {
    throw new Error(`${operation} 未命中 ${expectedId}：${JSON.stringify(results)}`);
  }
  console.log(`${operation}: PASS (${results.map((row) => row.id).join(', ')})`);
}

try {
  const health = await client.checkHealth();
  if (!health.isHealthy) throw new Error(`Milvus 不健康：${JSON.stringify(health)}`);
  const version = (await client.getVersion()).version;
  if (!version?.startsWith('2.6.')) throw new Error(`预期 Milvus 2.6.x，实际 ${version}`);
  console.log(`Milvus ${version} @ ${address}`);

  const createdResult = await client.createCollection({
    collection_name: collectionName,
    fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      { name: 'text', data_type: DataType.VarChar, max_length: 1024, enable_analyzer: true },
      { name: 'dense_vector', data_type: DataType.FloatVector, dim: 4 },
      { name: 'sparse_vector', data_type: DataType.SparseFloatVector, is_function_output: true },
    ],
    functions: [{
      name: 'text_bm25',
      type: FunctionType.BM25,
      input_field_names: ['text'],
      output_field_names: ['sparse_vector'],
      params: {},
    }],
  });
  assertSuccess(createdResult, '创建集合');
  created = true;

  assertSuccess(await client.createIndex({
    collection_name: collectionName,
    field_name: 'dense_vector',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  }), '创建 Dense 索引');
  assertSuccess(await client.createIndex({
    collection_name: collectionName,
    field_name: 'sparse_vector',
    index_type: 'SPARSE_INVERTED_INDEX',
    metric_type: 'BM25',
  }), '创建 BM25 索引');

  assertSuccess(await client.insert({
    collection_name: collectionName,
    data: [
      { id: 'cancellation', text: 'RUN_CANCELLED token cancellation', dense_vector: [1, 0, 0, 0] },
      { id: 'billing', text: 'invoice billing payment', dense_vector: [0, 1, 0, 0] },
      { id: 'deployment', text: 'docker deployment image', dense_vector: [0, 0, 1, 0] },
    ],
  }), '插入文本和 Dense 向量');
  assertSuccess(await client.flushSync({ collection_names: [collectionName] }), '持久化');
  assertSuccess(await client.loadCollectionSync({ collection_name: collectionName }), '加载集合');

  const dense = await client.search({
    collection_name: collectionName,
    anns_field: 'dense_vector',
    data: [1, 0, 0, 0],
    limit: 1,
    output_fields: ['id', 'text'],
  });
  assertHit(dense, 'cancellation', 'Dense Search');

  const bm25 = await client.search({
    collection_name: collectionName,
    anns_field: 'sparse_vector',
    data: 'token cancellation',
    limit: 1,
    output_fields: ['id', 'text'],
  });
  assertHit(bm25, 'cancellation', 'BM25 Search');

  const hybrid = await client.hybridSearch({
    collection_name: collectionName,
    data: [
      { anns_field: 'dense_vector', data: [1, 0, 0, 0] },
      { anns_field: 'sparse_vector', data: 'token cancellation' },
    ],
    rerank: RRFRanker(60),
    limit: 3,
    output_fields: ['id', 'text'],
  });
  assertHit(hybrid, 'cancellation', 'Hybrid Search + RRF');
  console.log('步骤 1 Milvus 能力验收通过');
} catch (error) {
  console.error(`步骤 1 Milvus 能力验收失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await client.dropCollection({ collection_name: collectionName });
      console.log(`已清理临时集合 ${collectionName}`);
    } catch (error) {
      console.error(`临时集合 ${collectionName} 清理失败：${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.closeConnection();
}
