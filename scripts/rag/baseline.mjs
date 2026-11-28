#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { OpenAIEmbeddings } from '@langchain/openai';

const usage = `RAG Dense 检索基线（只读）

用法：
  node --env-file=.env scripts/rag/baseline.mjs inventory [--out 目录]
  node --env-file=.env scripts/rag/baseline.mjs validate --dataset 路径
  node --env-file=.env scripts/rag/baseline.mjs evaluate --dataset 路径 [--top-k 5] [--out 目录]

数据集：JSONL，每行包含 id、category、tenantId、knowledgeBaseId、query、
        relevantChunkIds（有答案时非空）和 noAnswer（布尔值）。
        labelStatus 为 todo 的行仅作模板，不参与评估。`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['inventory', 'validate', 'evaluate'].includes(command)) {
    throw new Error(usage);
  }
  const args = { command, out: command === 'inventory' ? 'reports/rag-baseline/step0-inventory' : 'reports/rag-baseline/step1-single-kb/dense-baseline', topK: 5 };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`无效参数：${key ?? ''}\n\n${usage}`);
    }
    if (key === '--dataset') args.dataset = value;
    else if (key === '--out') args.out = value;
    else if (key === '--top-k') args.topK = Number(value);
    else throw new Error(`未知参数：${key}\n\n${usage}`);
  }
  if (['validate', 'evaluate'].includes(command) && !args.dataset) {
    throw new Error(`请提供 --dataset。\n\n${usage}`);
  }
  if (!Number.isInteger(args.topK) || args.topK < 1 || args.topK > 100) {
    throw new Error('--top-k 必须是 1 到 100 的整数');
  }
  return args;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function createMilvusClient() {
  return new MilvusClient({
    address: `${process.env.MILVUS_HOST || 'localhost'}:${process.env.MILVUS_PORT || '19530'}`,
    timeout: 5000,
  });
}

async function declaredInfrastructure() {
  const compose = await readFile(resolve('docker-compose.yml'), 'utf8');
  const images = {};
  let service = null;
  for (const line of compose.split(/\r?\n/)) {
    const serviceMatch = line.match(/^  ([\w-]+):\s*$/);
    if (serviceMatch) service = serviceMatch[1];
    const imageMatch = line.match(/^    image:\s*([^#]+?)(?:\s+#.*)?$/);
    if (service && imageMatch) images[service] = imageMatch[1].trim();
  }
  return {
    images,
    namedVolumes: [...compose.matchAll(/^  ([\w-]+_data):\s*$/gm)].map((match) => match[1]),
  };
}

async function createMySqlConnection() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'nest_agent',
    password: process.env.MYSQL_PASSWORD || 'nest_agent_pass',
    database: process.env.MYSQL_DATABASE || 'nest_agent',
    connectTimeout: 5000,
  });
}

function errorMessage(error) {
  if (error && typeof error === 'object') {
    return error.message || error.code || JSON.stringify(error) || '未知连接错误';
  }
  return String(error) || '未知连接错误';
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return Number(ordered[index].toFixed(2));
}

function round(value) {
  return Number(value.toFixed(2));
}

async function writeReport(outDir, kind, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(outDir, `${kind}-${stamp}.json`);
  await mkdir(resolve(outDir), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`报告：${path}`);
}

async function loadDataset(path) {
  const lines = (await readFile(resolve(path), 'utf8')).split(/\r?\n/);
  const cases = [];
  const ids = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`数据集第 ${index + 1} 行 JSON 错误：${errorMessage(error)}`);
    }
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) {
      throw new Error(`数据集第 ${index + 1} 行 id 缺失或重复`);
    }
    ids.add(item.id);
    if (item.labelStatus === 'todo') {
      cases.push(item);
      continue;
    }
    const strings = ['category', 'tenantId', 'knowledgeBaseId', 'query'];
    if (strings.some((key) => typeof item[key] !== 'string' || !item[key].trim())) {
      throw new Error(`数据集第 ${index + 1} 行缺少 category/tenantId/knowledgeBaseId/query`);
    }
    if (typeof item.noAnswer !== 'boolean' || !Array.isArray(item.relevantChunkIds)) {
      throw new Error(`数据集第 ${index + 1} 行 noAnswer 或 relevantChunkIds 格式错误`);
    }
    if (item.relevantChunkIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error(`数据集第 ${index + 1} 行包含无效 Chunk ID`);
    }
    if (item.noAnswer === (item.relevantChunkIds.length > 0)) {
      throw new Error(`数据集第 ${index + 1} 行无答案标记与相关 Chunk ID 矛盾`);
    }
    cases.push(item);
  }
  return cases;
}

function datasetSummary(cases) {
  const ready = cases.filter((item) => item.labelStatus !== 'todo');
  const categories = {};
  for (const item of ready) {
    categories[item.category] = (categories[item.category] || 0) + 1;
  }
  return {
    total: cases.length,
    ready: ready.length,
    todo: cases.length - ready.length,
    answerable: ready.filter((item) => !item.noAnswer).length,
    noAnswer: ready.filter((item) => item.noAnswer).length,
    categories,
    recommendation: ready.length < 50 ? '正式比较前建议至少标注 50 条真实问题' : null,
  };
}

async function inventory(args) {
  const declared = await declaredInfrastructure();
  const report = {
    generatedAt: new Date().toISOString(),
    configured: {
      milvusImage: declared.images['milvus-standalone'] ?? null,
      sdkVersion: JSON.parse(await readFile(resolve('node_modules/@zilliz/milvus2-sdk-node/package.json'), 'utf8')).version,
      mysqlImage: declared.images.mysql ?? null,
      etcdImage: declared.images.etcd ?? null,
      minioImage: declared.images.minio ?? null,
      composeVolumes: declared.namedVolumes,
    },
    runtime: { milvus: null, mysql: null },
  };

  const client = createMilvusClient();
  try {
    const version = await client.getVersion();
    const health = await client.checkHealth();
    const collectionResponse = await client.showCollections();
    const collections = [];
    for (const collection of collectionResponse.data) {
      const name = collection.name;
      const item = { name, loadedPercentage: collection.loadedPercentage };
      const [schema, index, count] = await Promise.allSettled([
        client.describeCollection({ collection_name: name }),
        client.describeIndex({ collection_name: name }),
        client.count({ collection_name: name }),
      ]);
      item.fields = schema.status === 'fulfilled'
        ? schema.value.schema.fields.map((field) => ({
            name: field.name,
            type: field.data_type,
            dimension: field.dim ?? field.type_params?.find((param) => param.key === 'dim')?.value ?? null,
          }))
        : { error: errorMessage(schema.reason) };
      item.indexes = index.status === 'fulfilled'
        ? index.value.index_descriptions.map((entry) => ({ field: entry.field_name, state: entry.state, params: entry.params }))
        : { error: errorMessage(index.reason) };
      item.chunkCount = count.status === 'fulfilled' ? count.value.data : null;
      if (count.status === 'rejected') item.countError = errorMessage(count.reason);
      collections.push(item);
    }
    report.runtime.milvus = {
      version: version.version,
      healthy: health.isHealthy,
      collectionCount: collections.length,
      collections,
    };
  } catch (error) {
    report.runtime.milvus = { error: errorMessage(error) };
  } finally {
    await client.closeConnection();
  }

  let db;
  try {
    db = await createMySqlConnection();
    const [rows] = await db.execute(
      'SELECT id, tenant_id AS tenantId, collection_name AS collectionName, embedding_model AS embeddingModel, document_count AS documentCount FROM knowledge_bases ORDER BY created_at',
    );
    report.runtime.mysql = { knowledgeBaseCount: rows.length, knowledgeBases: rows };
  } catch (error) {
    report.runtime.mysql = { error: errorMessage(error) };
  } finally {
    await db?.end();
  }

  await writeReport(args.out, 'inventory', report);
  console.log(`Milvus：${report.runtime.milvus.error || report.runtime.milvus.version}`);
  console.log(`MySQL：${report.runtime.mysql.error || `${report.runtime.mysql.knowledgeBaseCount} 个知识库`}`);
  if (report.runtime.milvus.error || report.runtime.mysql.error) process.exitCode = 1;
}

function summarizeEvaluation(rows, topK) {
  const answerable = rows.filter((row) => !row.noAnswer);
  const noAnswer = rows.filter((row) => row.noAnswer);
  const timings = rows.filter((row) => !row.error);
  const result = {
    caseCount: rows.length,
    answerableCount: answerable.length,
    noAnswerCount: noAnswer.length,
    failedCount: rows.filter((row) => row.error).length,
    recallAt1: answerable.length ? answerable.filter((row) => row.firstRelevantRank === 1).length / answerable.length : null,
    recallAtK: answerable.length ? answerable.filter((row) => row.firstRelevantRank && row.firstRelevantRank <= topK).length / answerable.length : null,
    mrrAtK: answerable.length ? answerable.reduce((sum, row) => sum + (row.firstRelevantRank ? 1 / row.firstRelevantRank : 0), 0) / answerable.length : null,
    noAnswerReturnedResultsRate: noAnswer.length ? noAnswer.filter((row) => row.hits?.length).length / noAnswer.length : null,
    p50TotalMs: percentile(timings.map((row) => row.totalMs), 0.5),
    p95TotalMs: percentile(timings.map((row) => row.totalMs), 0.95),
    p50EmbeddingMs: percentile(timings.map((row) => row.embeddingMs), 0.5),
    p95EmbeddingMs: percentile(timings.map((row) => row.embeddingMs), 0.95),
    p50MilvusMs: percentile(timings.map((row) => row.milvusMs), 0.5),
    p95MilvusMs: percentile(timings.map((row) => row.milvusMs), 0.95),
  };
  for (const key of ['recallAt1', 'recallAtK', 'mrrAtK', 'noAnswerReturnedResultsRate']) {
    if (result[key] !== null) result[key] = Number(result[key].toFixed(4));
  }
  return result;
}

async function evaluate(args, cases) {
  const ready = cases.filter((item) => item.labelStatus !== 'todo');
  if (!ready.length) throw new Error('没有已标注问题；请先填写真实 tenantId、knowledgeBaseId 和 relevantChunkIds');
  requiredEnv('OPENAI_API_KEY');

  const db = await createMySqlConnection();
  const client = createMilvusClient();
  const embeddings = new OpenAIEmbeddings({
    modelName: 'BAAI/bge-m3',
    openAIApiKey: process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_BASE_URL ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } } : {}),
  });
  const rows = [];
  try {
    const version = await client.getVersion();
    for (const item of ready) {
      const result = {
        id: item.id,
        category: item.category,
        query: item.query,
        tenantId: item.tenantId,
        knowledgeBaseId: item.knowledgeBaseId,
        noAnswer: item.noAnswer,
        relevantChunkIds: item.relevantChunkIds,
      };
      try {
        const [kbRows] = await db.execute(
          'SELECT collection_name AS collectionName FROM knowledge_bases WHERE id = ? AND tenant_id = ?',
          [item.knowledgeBaseId, item.tenantId],
        );
        if (kbRows.length !== 1) throw new Error('知识库不存在或不属于指定租户');
        const started = performance.now();
        const vector = await embeddings.embedQuery(item.query);
        const embedded = performance.now();
        const response = await client.search({
          collection_name: kbRows[0].collectionName,
          anns_field: 'dense_vector',
          data: vector,
          limit: args.topK,
          output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
          filter: `knowledge_base_id == "${item.knowledgeBaseId.replace(/[^a-zA-Z0-9-]/g, '')}"`,
        });
        const searched = performance.now();
        result.embeddingMs = round(embedded - started);
        result.milvusMs = round(searched - embedded);
        result.totalMs = round(searched - started);
        result.hits = response.results.map((hit, index) => ({
          rank: index + 1,
          chunkId: String(hit.id),
          score: hit.score,
        }));
        result.firstRelevantRank = item.noAnswer
          ? null
          : (result.hits.find((hit) => item.relevantChunkIds.includes(hit.chunkId))?.rank ?? null);
      } catch (error) {
        result.error = errorMessage(error);
        result.hits = [];
        result.firstRelevantRank = null;
      }
      rows.push(result);
      console.log(`${result.id}: ${result.error || `rank=${result.firstRelevantRank ?? '-'} total=${result.totalMs}ms`}`);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'dense_v2',
      milvusVersion: version.version,
      sdkVersion: JSON.parse(await readFile(resolve('node_modules/@zilliz/milvus2-sdk-node/package.json'), 'utf8')).version,
      embeddingModel: 'BAAI/bge-m3',
      topK: args.topK,
      dataset: resolve(args.dataset),
      datasetSummary: datasetSummary(cases),
      metrics: summarizeEvaluation(rows, args.topK),
      results: rows,
    };
    await writeReport(args.out, 'dense-v2-baseline', report);
    console.log(JSON.stringify(report.metrics, null, 2));
    if (report.metrics.failedCount) process.exitCode = 1;
  } finally {
    await db.end();
    await client.closeConnection();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'inventory') return inventory(args);
  const cases = await loadDataset(args.dataset);
  if (args.command === 'validate') {
    console.log(JSON.stringify(datasetSummary(cases), null, 2));
    return;
  }
  return evaluate(args, cases);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
