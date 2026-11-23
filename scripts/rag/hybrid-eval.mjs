#!/usr/bin/env node
// Read-only Hybrid evaluation. Calls the application's RagService.search path.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const require = createRequire(import.meta.url);
const datasetDir = resolve('datasets/rag-hybrid-v1');
const outDir = resolve(process.argv[5] || 'reports/rag-baseline/hybrid-v1');
const knowledgeBaseName = process.argv[4] || 'RAG 评测 v1';
const normalize = (value) => value.replace(/\s+/g, ' ').trim();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const command = process.argv[2];
const split = process.argv[3] || 'dev';
if (!['prepare', 'evaluate'].includes(command) || !['dev', 'test'].includes(split)) {
  throw new Error('Usage: node --env-file=.env scripts/rag/hybrid-eval.mjs prepare|evaluate [dev|test] [knowledgeBaseName] [outDirectory]');
}

function assertSuccess(response) {
  if (response.status?.error_code !== 'Success') {
    throw new Error(response.status?.reason || 'Milvus request failed');
  }
}

function summarize(rows) {
  const answerable = rows.filter((row) => !row.noAnswer);
  const negatives = rows.filter((row) => row.noAnswer);
  const average = (items, get) => items.length
    ? Number((items.reduce((sum, row) => sum + get(row), 0) / items.length).toFixed(4)) : null;
  const timings = rows.filter((row) => !row.error).map((row) => row.totalMs).sort((a, b) => a - b);
  return {
    questionCount: rows.length,
    answerableCount: answerable.length,
    noAnswerCount: negatives.length,
    failedCount: rows.filter((row) => row.error).length,
    hitAt5: average(answerable, (row) => row.firstRelevantRank ? 1 : 0),
    mrrAt5: average(answerable, (row) => row.firstRelevantRank ? 1 / row.firstRelevantRank : 0),
    allEvidenceAt5: average(answerable, (row) => row.allEvidenceFound ? 1 : 0),
    noAnswerReturnedResultsRate: average(negatives, (row) => row.hits.length ? 1 : 0),
    p50TotalMs: timings.length ? timings[Math.ceil(timings.length * 0.5) - 1] : null,
    p95TotalMs: timings.length ? timings[Math.ceil(timings.length * 0.95) - 1] : null,
  };
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(datasetDir, 'manifest.json'), 'utf8'));
  const rawQuestions = await readFile(resolve(datasetDir, 'questions.jsonl'), 'utf8');
  const questions = rawQuestions.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (questions.length !== 40 || new Set(questions.map((q) => q.id)).size !== 40) {
    throw new Error('Unexpected question count or duplicate IDs');
  }
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE, connectTimeout: 5000,
  });
  const client = new MilvusClient({
    address: `${process.env.MILVUS_HOST || 'localhost'}:${process.env.MILVUS_PORT || 19530}`, timeout: 10000,
  });
  let serviceClient;
  try {
    const [kbs] = await db.execute(
      'SELECT id, name, tenant_id AS tenantId, collection_name AS collectionName, embedding_model AS embeddingModel, chunk_size AS chunkSize, chunk_overlap AS chunkOverlap FROM knowledge_bases WHERE name = ?',
      [knowledgeBaseName],
    );
    if (kbs.length !== 1) throw new Error(`Expected exactly one knowledge base named ${knowledgeBaseName}`);
    const kb = kbs[0];
    if (!/^[a-zA-Z0-9-]+$/.test(kb.id)) throw new Error('Invalid KB ID');
    const count = await client.count({ collection_name: kb.collectionName });
    assertSuccess(count);
    if (Number(count.data) > 10000) throw new Error('Corpus exceeds the evaluator query limit');
    const response = await client.query({
      collection_name: kb.collectionName, filter: `knowledge_base_id == "${kb.id}"`,
      output_fields: ['id', 'text', 'metadata'], limit: 10000,
    });
    assertSuccess(response);
    const chunks = response.data;
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap });
    const allowedSources = new Set(manifest.sources.map((source) => basename(source.path)));
    if (chunks.some((chunk) => !allowedSources.has(chunk.metadata?.source))) {
      throw new Error('Unexpected source in evaluation KB; only the two corpus documents are allowed');
    }
    for (const source of manifest.sources) {
      const content = await readFile(resolve(datasetDir, source.path), 'utf8');
      if (hash(content) !== source.sha256) throw new Error(`Corpus hash changed: ${source.path}`);
      const expected = (await splitter.splitText(content)).map(normalize).sort();
      const actual = chunks.filter((chunk) => chunk.metadata?.source === basename(source.path))
        .map((chunk) => normalize(chunk.text)).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(`Uploaded chunks do not match frozen corpus: ${source.path}`);
      }
    }
    const bound = questions.map((question) => {
      const evidenceGroups = question.evidence.map((evidence) => {
        const ids = chunks.filter((chunk) => chunk.metadata?.source === basename(evidence.source)
          && normalize(chunk.text).includes(normalize(evidence.quote))).map((chunk) => String(chunk.id));
        if (!ids.length) throw new Error(`Evidence crosses chunks or is missing; review required: ${question.id}`);
        return { ...evidence, relevantChunkIds: ids };
      });
      return {
        ...question, tenantId: kb.tenantId, knowledgeBaseId: kb.id,
        relevantChunkIds: [...new Set(evidenceGroups.flatMap((group) => group.relevantChunkIds))],
        evidenceGroups, labelStatus: 'exact_source_match',
      };
    });
    const fingerprint = hash(JSON.stringify(chunks.map((chunk) => ({
      id: chunk.id, text: chunk.text, source: chunk.metadata.source,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))));
    await mkdir(outDir, { recursive: true });
    const binding = {
      generatedAt: new Date().toISOString(), kb, chunkCount: chunks.length,
      corpusFingerprint: fingerprint, questionHash: hash(rawQuestions),
      labelMethod: 'Exact evidence quote match in source-filtered chunks; independent of retrieval ranking',
      questions: bound,
    };
    if (command === 'prepare') {
      await writeFile(resolve(outDir, 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
      console.log(JSON.stringify({ prepared: bound.length, chunkCount: chunks.length, path: resolve(outDir, 'binding.json') }));
      return;
    }
    const saved = JSON.parse(await readFile(resolve(outDir, 'binding.json'), 'utf8'));
    if (saved.corpusFingerprint !== fingerprint || saved.questionHash !== hash(rawQuestions)) {
      throw new Error('Corpus/questions changed; prepare and review labels again');
    }
    // Reuse the actual application path rather than an approximate Hybrid query.
    require('ts-node/register/transpile-only');
    const { ConfigService } = require('@nestjs/config');
    const configuration = require('../../src/common/config/configuration.ts').default;
    const { MilvusService } = require('../../src/rag/milvus.service.ts');
    const { RagService } = require('../../src/rag/rag.service.ts');
    const config = new ConfigService(configuration());
    const milvus = new MilvusService(config);
    await milvus.onModuleInit();
    serviceClient = milvus.client;
    if (!milvus.isAvailable()) throw new Error('Milvus unavailable');
    const repo = {
      findOne: async ({ where }) => {
        const [rows] = await db.execute(
          'SELECT id, tenant_id AS tenantId, collection_name AS collectionName FROM knowledge_bases WHERE id = ? AND tenant_id = ?',
          [where.id, where.tenantId],
        );
        return rows[0] || null;
      },
    };
    const rag = new RagService(repo, milvus, config);
    const results = [];
    for (const question of saved.questions.filter((q) => q.split === split)) {
      const row = { id: question.id, query: question.query, noAnswer: question.noAnswer, hits: [], firstRelevantRank: null, allEvidenceFound: false };
      const start = performance.now();
      try {
        const hits = await rag.search(kb.id, kb.tenantId, question.query, 5, 'hybrid');
        row.hits = hits.map((hit, index) => ({ rank: index + 1, id: String(hit.id), score: hit.score, source: hit.metadata?.source, text: hit.text }));
        row.firstRelevantRank = row.hits.find((hit) => question.relevantChunkIds.includes(hit.id))?.rank ?? null;
        row.allEvidenceFound = !question.noAnswer && question.evidenceGroups.every((group) => row.hits.some((hit) => group.relevantChunkIds.includes(hit.id)));
      } catch (error) {
        row.error = String(error?.message || error).replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
      }
      row.totalMs = Math.round((performance.now() - start) * 100) / 100;
      results.push(row);
      console.log(`${row.id}: ${row.error || `rank=${row.firstRelevantRank ?? '-'} allEvidence=${row.allEvidenceFound}`}`);
    }
    const report = {
      generatedAt: new Date().toISOString(), mode: 'hybrid', split, topK: 5,
      embeddingModel: kb.embeddingModel, chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap,
      milvusVersion: (await client.getVersion()).version, corpusFingerprint: fingerprint,
      questionHash: hash(rawQuestions), kbId: kb.id, knowledgeBaseName: kb.name, collectionName: kb.collectionName,
      scope: 'Single knowledge base via RagService.search; no Agent generation, citations, abstention, web search, or cross-KB merge evaluated',
      noAnswerNote: 'Returned-results rate is diagnostic only, not hallucination or false-answer rate. No rejection gate is evaluated.',
      metrics: summarize(results), results,
    };
    const reportPath = resolve(outDir, `${split}-${Date.now()}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ reportPath, metrics: report.metrics }, null, 2));
    if (report.metrics.failedCount) process.exitCode = 1;
  } finally {
    await serviceClient?.closeConnection();
    await client.closeConnection();
    await db.end();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error).replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]'));
  process.exitCode = 1;
});
