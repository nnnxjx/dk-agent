#!/usr/bin/env node
// 扩充题库的单库对照：同一知识库、同一题目，直接调用真实 RagService.search。
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  loadDataset,
  hash,
  normalize,
  readJson,
  writeJson,
} from './project-eval-lib.mjs';
import {
  bindQuestions,
  scoreSingle,
  summarizeSingle,
} from './single-kb-eval-lib.mjs';

const [
  command,
  phase = 'dev',
  output = 'reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128',
] = process.argv.slice(2);
if (
  !['prepare', 'compare'].includes(command) ||
  !['pilot', 'dev', 'test'].includes(phase)
)
  throw new Error(
    'Usage: single-kb-eval.mjs prepare|compare [pilot|dev|test] [outputDirectory]',
  );
const data = await loadDataset();
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const mysql = (await import('mysql2/promise')).default;
const { ConfigService } = require('@nestjs/config');
const config = new ConfigService(
  require('../../src/common/config/configuration.ts').default(),
);
const { RagService } = require('../../src/rag/rag.service.ts');
const { MilvusService } = require('../../src/rag/milvus.service.ts');
const { RecursiveCharacterTextSplitter } =
  await import('@langchain/textsplitters');
const outDir = resolve(output),
  bindingPath = resolve(outDir, 'binding.json');
const milvus = new MilvusService(config);
const redact = (e) =>
  String(e?.message || e).replace(/sk-[\w-]+/g, '[REDACTED]');
const fingerprint = (chunks) =>
  hash(
    JSON.stringify(
      chunks
        .map((c) => ({ id: String(c.id), text: c.text, metadata: c.metadata }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
let db;
try {
  await mkdir(outDir, { recursive: true });
  db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectTimeout: 5000,
  });
  await milvus.onModuleInit();
  if (!milvus.isAvailable()) throw new Error('Milvus unavailable');
  const columns =
    'id,name,tenant_id AS tenantId,collection_name AS collectionName,embedding_model AS embeddingModel,chunk_size AS chunkSize,chunk_overlap AS chunkOverlap,document_count AS documentCount';
  const repo = {
    create: (value) => ({ ...value, id: randomUUID(), documentCount: 0 }),
    save: async (kb) => {
      await db.execute(
        'INSERT INTO knowledge_bases (id,name,description,tenant_id,collection_name,embedding_model,chunk_size,chunk_overlap,document_count) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          kb.id,
          kb.name,
          kb.description,
          kb.tenantId,
          kb.collectionName,
          kb.embeddingModel,
          kb.chunkSize,
          kb.chunkOverlap,
          kb.documentCount,
        ],
      );
      return kb;
    },
    findOne: async ({ where }) =>
      (
        await db.execute(
          `SELECT ${columns} FROM knowledge_bases WHERE id = ? AND tenant_id = ?`,
          [where.id, where.tenantId],
        )
      )[0][0] || null,
    update: async (id, fields) =>
      db.execute('UPDATE knowledge_bases SET document_count = ? WHERE id = ?', [
        fields.documentCount,
        id,
      ]),
  };
  const rag = new RagService(repo, milvus, config);
  async function getChunks(kb) {
    const count = await milvus.client.count({
      collection_name: kb.collectionName,
    });
    if (count.status?.error_code !== 'Success' || Number(count.data) > 10000)
      throw new Error('Invalid corpus count');
    const result = await milvus.client.query({
      collection_name: kb.collectionName,
      filter: `knowledge_base_id == "${kb.id}"`,
      output_fields: ['id', 'text', 'metadata'],
      limit: 10000,
    });
    if (
      result.status?.error_code !== 'Success' ||
      result.data.length !== Number(count.data)
    )
      throw new Error('Incomplete corpus query');
    return result.data;
  }
  async function checkCorpus(kb, chunks) {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
    });
    const sources = new Set(data.documents.map((d) => basename(d.path)));
    if (chunks.some((c) => !sources.has(c.metadata?.source)))
      throw new Error('Unexpected source in evaluation KB');
    for (const doc of data.documents) {
      const expected = (await splitter.splitText(doc.content))
        .map(normalize)
        .sort();
      const actual = chunks
        .filter((c) => c.metadata?.source === basename(doc.path))
        .map((c) => normalize(c.text))
        .sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error(`Corpus differs: ${doc.path}`);
    }
  }
  if (command === 'prepare') {
    try {
      await readFile(bindingPath);
      throw new Error('Binding exists; use a new directory');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const tag = randomUUID();
    const binding = {
      createdAt: new Date().toISOString(),
      datasetSignature: data.signature,
      sourceCommit: data.manifest.sourceCommit,
      prepared: false,
      tenantId: `rag-single-expanded-${tag}`,
      kb: null,
    };
    await writeJson(bindingPath, binding);
    binding.kb = await rag.createKnowledgeBase(
      `RAG 单库扩充评测-${tag.slice(0, 8)}`,
      '7 frozen project documents; answerable-only single-KB retrieval evaluation',
      binding.tenantId,
      { chunkSize: 1000, chunkOverlap: 200 },
    );
    await writeJson(bindingPath, binding);
    await rag.addDocuments(
      binding.kb.id,
      binding.tenantId,
      data.documents.map((d) => ({
        content: d.content,
        metadata: { source: basename(d.path) },
      })),
    );
    const flush = await milvus.client.flushSync({
      collection_names: [binding.kb.collectionName],
    });
    if (flush.status?.error_code && flush.status.error_code !== 'Success')
      throw new Error('Flush failed');
    binding.chunks = await getChunks(binding.kb);
    await checkCorpus(binding.kb, binding.chunks);
    binding.questions = bindQuestions(
      data.questions,
      binding.chunks,
      binding.kb,
    );
    binding.chunkCount = binding.chunks.length;
    binding.corpusFingerprint = fingerprint(binding.chunks);
    binding.prepared = true;
    binding.labelMethod =
      'Exact source-and-quote mapping to actual chunk IDs; independent of retrieval ranks; fixed evidence groups retained';
    await writeJson(bindingPath, binding);
    console.log(
      JSON.stringify(
        {
          knowledgeBaseName: binding.kb.name,
          documents: data.documents.length,
          chunks: binding.chunkCount,
          boundQuestions: binding.questions.length,
          split: data.manifest.split,
        },
        null,
        2,
      ),
    );
  } else {
    const binding = await readJson(bindingPath);
    if (!binding.prepared || binding.datasetSignature !== data.signature)
      throw new Error('Incomplete/changed binding');
    const kb = await repo.findOne({
      where: { id: binding.kb.id, tenantId: binding.tenantId },
    });
    if (
      !kb ||
      kb.collectionName !== binding.kb.collectionName ||
      kb.embeddingModel !== 'BAAI/bge-m3' ||
      kb.chunkSize !== 1000 ||
      kb.chunkOverlap !== 200
    )
      throw new Error('Knowledge base configuration changed');
    const chunks = await getChunks(kb);
    await checkCorpus(kb, chunks);
    if (
      fingerprint(chunks) !== binding.corpusFingerprint ||
      JSON.stringify(bindQuestions(data.questions, chunks, kb)) !==
        JSON.stringify(binding.questions)
    )
      throw new Error('Chunks/labels changed; rebind and review');
    const codePaths = [
      'scripts/rag/single-kb-eval.mjs',
      'scripts/rag/single-kb-eval-lib.mjs',
      'scripts/rag/project-eval-lib.mjs',
      'scripts/rag/eval-metrics.mjs',
      'src/rag/rag.service.ts',
      'src/rag/milvus.service.ts',
      'src/rag/retrieval-mode.ts',
      'src/common/config/configuration.ts',
    ];
    const settings = {
      datasetSignature: data.signature,
      bindingHash: hash(await readFile(bindingPath)),
      knowledgeBaseName: kb.name,
      knowledgeBaseId: kb.id,
      embeddingModel: kb.embeddingModel,
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
      corpusFingerprint: binding.corpusFingerprint,
      milvusVersion: (await milvus.client.getVersion()).version,
      scope:
        'Single consolidated KB via real RagService.search; no cross-KB merge/reranking/Agent/LLM judge; answerable-only; sequential requests',
      labelMethod: binding.labelMethod,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          codePaths.map(async (p) => [p, hash(await readFile(p))]),
        ),
      ),
    };
    const signature = hash(JSON.stringify(settings));
    await writeJson(resolve(outDir, 'settings.json'), {
      ...settings,
      signature,
    });
    const selected =
      phase === 'pilot'
        ? binding.questions.filter((q) => q.split === 'dev').slice(0, 5)
        : binding.questions.filter((q) => q.split === phase);
    if (!selected.length) throw new Error('Empty split');
    const configurations = ['dense_v2', 'bm25', 'hybrid'].flatMap((mode) =>
      [3, 5, 10].map((topK) => ({ mode, topK })),
    );
    const reports = [];
    const save = async () =>
      writeJson(resolve(outDir, `${phase}-comparison.json`), {
        generatedAt: new Date().toISOString(),
        settings,
        signature,
        phase,
        expectedQuestions: selected.length,
        expectedRecords: selected.length * configurations.length,
        processedRecords: reports.reduce((n, r) => n + r.rows.length, 0),
        complete:
          reports.length === configurations.length &&
          reports.every((r) => r.complete),
        metricNotes:
          'Chunk Recall/Precision/MRR match step-1 definitions. Evidence-group Recall and complete evidence are separate. Failures count zero; exact source labels are not exhaustive semantic relevance judgments. No-answer metrics are inapplicable. Latencies are sequential, not load tests.',
        reports,
      });
    for (const { mode, topK } of configurations) {
      const report = { mode, topK, rows: [], complete: false, metrics: null };
      reports.push(report);
      for (const question of selected) {
        const path = resolve(outDir, `${mode}-k${topK}-${question.id}.json`);
        let row;
        try {
          const old = await readJson(path);
          if (
            old.signature === signature &&
            old.mode === mode &&
            old.topK === topK &&
            old.query === question.query &&
            !old.error
          )
            row = old;
        } catch {}
        if (!row) {
          row = {
            id: question.id,
            query: question.query,
            category: question.category,
            noAnswer: false,
            mode,
            topK,
            signature,
            hits: [],
            recall: 0,
            precision: 0,
            evidenceRecall: 0,
            allEvidenceFound: false,
            firstRelevantRank: null,
          };
          const start = performance.now();
          try {
            const hits = await rag.search(
              kb.id,
              kb.tenantId,
              question.query,
              topK,
              mode,
            );
            row.hits = hits.map((h, i) => ({
              ...h,
              id: String(h.id),
              rank: i + 1,
            }));
            Object.assign(row, scoreSingle(question, row.hits, topK));
          } catch (e) {
            row.error = redact(e);
          }
          row.totalMs = Math.round((performance.now() - start) * 100) / 100;
          await writeJson(path, row);
        }
        report.rows.push(row);
        report.metrics = summarizeSingle(report.rows, topK);
        await save();
        console.log(
          `${mode} k=${topK} ${question.id}: ${row.error || `recall=${row.recall} evidence=${row.evidenceRecall}`}`,
        );
      }
      report.complete = true;
      report.byCategory = Object.fromEntries(
        [...new Set(selected.map((q) => q.category))].map((category) => [
          category,
          summarizeSingle(
            report.rows.filter((r) => r.category === category),
            topK,
          ),
        ]),
      );
      await writeJson(resolve(outDir, `${phase}-${mode}-k${topK}.json`), {
        settings,
        signature,
        ...report,
      });
      await save();
    }
    if (reports.some((r) => r.rows.some((row) => row.error)))
      process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          phase,
          expectedRecords: selected.length * 9,
          comparisons: reports.map(({ mode, topK, metrics }) => ({
            mode,
            topK,
            metrics,
          })),
        },
        null,
        2,
      ),
    );
  }
} finally {
  await milvus.client?.closeConnection();
  await db?.end();
}
