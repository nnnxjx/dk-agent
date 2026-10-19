#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MilvusClient, RRFRanker } from '@zilliz/milvus2-sdk-node';

const require = createRequire(import.meta.url);
const { hybridCollectionSchema, hybridCollectionIndexes, HYBRID_EMBEDDING_DIM, HYBRID_ANALYZER_PARAMS } =
  require('../../dist/src/rag/hybrid-collection.schema.js');

const collectionName = `rag_schema_v2_smoke_${randomUUID().replaceAll('-', '')}`;
const client = new MilvusClient({ address: '127.0.0.1:19531', timeout: 30000 });
const kbId = '11111111-1111-4111-8111-111111111111';
const otherKbId = '22222222-2222-4222-8222-222222222222';
let created = false;

function assertSuccess(response, operation) {
  const status = response?.status ?? response;
  if (status?.error_code !== 'Success') {
    throw new Error(`${operation}: ${status?.reason || JSON.stringify(status)}`);
  }
}

function vector(position) {
  const values = Array(HYBRID_EMBEDDING_DIM).fill(0);
  values[position] = 1;
  return values;
}

function assertHit(response, expectedId, operation) {
  assertSuccess(response, operation);
  const ids = response.results.map((hit) => hit.id);
  if (!ids.includes(expectedId)) {
    throw new Error(`${operation}: expected ${expectedId}, got ${ids.join(', ') || '(empty)'}`);
  }
  console.log(`${operation}: PASS (${ids.join(', ')})`);
}

try {
  const version = (await client.getVersion()).version;
  if (version !== '2.6.24') throw new Error(`Expected Milvus 2.6.24, got ${version}`);

  const samples = ['一键中断后继续追问', 'RUN_CANCELLED', 'AbortController', '/chat/runs/:runId'];
  const analyzed = await client.runAnalyzer({
    text: samples,
    analyzer_params: HYBRID_ANALYZER_PARAMS,
    with_detail: true,
  });
  assertSuccess(analyzed, 'runAnalyzer');
  for (let i = 0; i < samples.length; i++) {
    const tokens = analyzed.results[i]?.tokens.map((item) => item.token) ?? [];
    console.log(`analyzer ${JSON.stringify(samples[i])}: ${JSON.stringify(tokens)}`);
    if (!tokens.length) throw new Error(`analyzer returned no tokens for ${samples[i]}`);
  }

  assertSuccess(await client.createCollection(hybridCollectionSchema(collectionName)), 'createCollection');
  created = true;
  for (const index of hybridCollectionIndexes(collectionName)) {
    assertSuccess(await client.createIndex(index), `createIndex ${index.field_name}`);
  }

  const rows = [
    { id: 'cn_interrupt', text: '一键中断可以立即停止流式输出，然后继续追问。', dense_vector: vector(0), metadata: { category: 'chinese' }, knowledge_base_id: kbId },
    { id: 'error_code', text: '取消运行时返回 RUN_CANCELLED 错误码。', dense_vector: vector(1), metadata: { category: 'error-code' }, knowledge_base_id: kbId },
    { id: 'controller', text: 'AbortController 用于停止当前请求。', dense_vector: vector(2), metadata: { category: 'api-name' }, knowledge_base_id: kbId },
    { id: 'endpoint', text: '终止运行接口是 /chat/runs/:runId。', dense_vector: vector(3), metadata: { category: 'api-path' }, knowledge_base_id: kbId },
    { id: 'other_kb', text: '另一个知识库也包含一键中断 RUN_CANCELLED AbortController /chat/runs/:runId。', dense_vector: vector(0), metadata: { category: 'other-kb' }, knowledge_base_id: otherKbId },
  ];
  // 插入时故意不提供 sparse_vector：它只能由 Milvus BM25 Function 生成。
  assertSuccess(await client.insert({ collection_name: collectionName, data: rows }), 'insert');
  assertSuccess(await client.flushSync({ collection_names: [collectionName] }), 'flush');
  assertSuccess(await client.loadCollectionSync({ collection_name: collectionName }), 'load');

  const filter = `knowledge_base_id == "${kbId}"`;
  assertHit(await client.search({
    collection_name: collectionName,
    anns_field: 'dense_vector',
    data: vector(0),
    filter,
    limit: 1,
    output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
  }), 'cn_interrupt', 'Dense 1024d + KB filter');

  for (const [query, id] of [
    ['一键中断', 'cn_interrupt'],
    ['RUN_CANCELLED', 'error_code'],
    ['AbortController', 'controller'],
    ['/chat/runs/:runId', 'endpoint'],
  ]) {
    const hits = await client.search({
      collection_name: collectionName,
      anns_field: 'sparse_vector',
      data: query,
      filter,
      limit: 2,
      output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
    });
    assertHit(hits, id, `BM25 ${query}`);
    if (hits.results.some((hit) => hit.knowledge_base_id !== kbId)) {
      throw new Error(`KB filter leaked data for ${query}`);
    }
  }
  const hybrid = await client.hybridSearch({
    collection_name: collectionName,
    data: [
      { anns_field: 'dense_vector', data: vector(0), expr: filter },
      { anns_field: 'sparse_vector', data: '一键中断', expr: filter },
    ],
    rerank: RRFRanker(60),
    limit: 5,
    output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
  });
  assertHit(hybrid, 'cn_interrupt', 'Hybrid RRF + KB filter');
  if (hybrid.results.some((hit) => hit.knowledge_base_id !== kbId)) {
    throw new Error('Hybrid KB filter leaked data');
  }
  console.log('步骤 2 完整 Schema、中文/技术词 BM25、Hybrid 与知识库过滤验证通过');
} catch (error) {
  console.error(`步骤 2 验证失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      assertSuccess(await client.dropCollection({ collection_name: collectionName }), 'dropCollection');
      console.log(`已清理临时集合 ${collectionName}`);
    } catch (error) {
      console.error(`清理临时集合失败：${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.closeConnection();
}
