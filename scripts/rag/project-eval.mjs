#!/usr/bin/env node
// 第四步：固定真实项目文档；仅有答案；实际跨库工具与 AgentService 集成评测。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { datasetDir, loadDataset, hash, readJson, writeJson, evidenceCoverage, retrievalMetrics } from './project-eval-lib.mjs';
import { extractTrace, summarizeAnswers } from './answer-eval-lib.mjs';
import { judgeAnswer } from './answer-judge.mjs';

const [command = 'validate', phase = 'pilot', output = 'reports/rag-baseline/step4-expanded/project-step4-v1'] = process.argv.slice(2);
if (!['validate', 'prepare', 'retrieval', 'answers'].includes(command) || !['pilot', 'dev', 'test'].includes(phase)) throw new Error('Usage: project-eval.mjs validate|prepare|retrieval|answers pilot|dev|test [outputDir]');
// 测试集必须显式指定，默认命令不会消耗保留题。
const data = await loadDataset();
const { RecursiveCharacterTextSplitter } = await import('@langchain/textsplitters');
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
const plannedChunks = [];
for (const d of data.documents) for (const text of await splitter.splitText(d.content)) plannedChunks.push({ text, metadata: { source: basename(d.path) } });
for (const q of data.questions) if (evidenceCoverage(q, plannedChunks).some(e => !e.found)) throw new Error(`Evidence crosses chunks: ${q.id}`);
if (command === 'validate') {
  console.log(JSON.stringify({ dataset: data.manifest.version, questions: data.questions.length, split: data.manifest.split, documents: data.documents.length, plannedChunks: plannedChunks.length, evidenceLabelsVerified: true, independentHumanReview: false, noAnswerEvaluated: false }, null, 2));
  process.exit(0);
}
async function main() {
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const mysql = (await import('mysql2/promise')).default;
const { ConfigService } = require('@nestjs/config');
const configuration = require('../../src/common/config/configuration.ts').default;
const { RagService } = require('../../src/rag/rag.service.ts');
const { MilvusService } = require('../../src/rag/milvus.service.ts');
const { GlobalRerankService } = require('../../src/rag/global-rerank.service.ts');
const { createRagRetrievalTool } = require('../../src/tools/rag-retrieval.tool.ts');
const { LLMService } = require('../../src/llm/llm.service.ts');
const { AgentService } = require('../../src/agent/agent.service.ts');
const { SupervisorFactory } = require('../../src/agent/supervisor.factory.ts');
const config = new ConfigService(configuration());
const milvus = new MilvusService(config);
const outDir = resolve(output);
const bindingPath = resolve(process.env.RAG_PROJECT_BINDING || resolve(outDir, 'binding.json'));
let db;
const redact = e => String(e?.message || e).replace(/sk-[\w-]+/g, '[REDACTED]');
const fingerprint = chunks => hash(JSON.stringify(chunks.map(c => ({ id: String(c.id), text: c.text, metadata: c.metadata })).sort((a,b) => a.id.localeCompare(b.id))));
try {
  await mkdir(outDir, { recursive: true });
  db = await mysql.createConnection({ host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectTimeout: 5000 });
  await milvus.onModuleInit();
  if (!milvus.isAvailable()) throw new Error('Milvus unavailable');
  const columns = 'id,name,tenant_id AS tenantId,collection_name AS collectionName,embedding_model AS embeddingModel,chunk_size AS chunkSize,chunk_overlap AS chunkOverlap,document_count AS documentCount';
  const repo = {
    create: value => ({ ...value, id: randomUUID(), documentCount: 0 }),
    save: async kb => { await db.execute('INSERT INTO knowledge_bases (id,name,description,tenant_id,collection_name,embedding_model,chunk_size,chunk_overlap,document_count) VALUES (?,?,?,?,?,?,?,?,?)', [kb.id,kb.name,kb.description,kb.tenantId,kb.collectionName,kb.embeddingModel,kb.chunkSize,kb.chunkOverlap,kb.documentCount]); return kb; },
    findOne: async ({ where }) => (await db.execute(`SELECT ${columns} FROM knowledge_bases WHERE id = ? AND tenant_id = ?`, [where.id, where.tenantId]))[0][0] || null,
    update: async (id, fields) => db.execute('UPDATE knowledge_bases SET document_count = ? WHERE id = ?', [fields.documentCount,id]),
  };
  const rag = new RagService(repo, milvus, config);
  async function getChunks(kb) {
    const count = await milvus.client.count({ collection_name: kb.collectionName });
    if (count.status?.error_code !== 'Success' || Number(count.data) > 10000) throw new Error('Invalid corpus size/count');
    const result = await milvus.client.query({ collection_name: kb.collectionName, filter: `knowledge_base_id == "${kb.id}"`, output_fields: ['id','text','metadata'], limit: 10000 });
    if (result.status?.error_code !== 'Success' || result.data.length !== Number(count.data)) throw new Error('Incomplete corpus query');
    return result.data;
  }
  if (command === 'prepare') {
    // 已有 binding 不覆盖；中断后的部分创建同样保留，以便人工定位。
    try { await readFile(bindingPath); throw new Error('Binding already exists; choose a new directory'); } catch(e) { if (e.code !== 'ENOENT') throw e; }
    const tag = randomUUID();
    const binding = { datasetSignature: data.signature, tenantId: `rag-step4-${tag}`, knowledgeBases: [], createdAt: new Date().toISOString(), sourceCommit: data.manifest.sourceCommit };
    await writeJson(bindingPath, binding);
    for (const source of data.documents) {
      const kb = await rag.createKnowledgeBase(`RAG 第四步-${source.knowledgeBase}-${tag.slice(0,8)}`, 'Frozen repository documentation; answerable-only evaluation', binding.tenantId);
      const entry = { ...kb, source: source.path, prepared: false };
      binding.knowledgeBases.push(entry); await writeJson(bindingPath, binding);
      await rag.addDocuments(kb.id, kb.tenantId, [{ content: source.content, metadata: { source: basename(source.path) } }]);
      const flush = await milvus.client.flushSync({ collection_names: [kb.collectionName] });
      if (flush.status?.error_code && flush.status.error_code !== 'Success') throw new Error('Flush failed');
      entry.chunks = await getChunks(kb); entry.fingerprint = fingerprint(entry.chunks); entry.prepared = true;
      await writeJson(bindingPath, binding);
      console.log(`Prepared ${source.knowledgeBase}: ${entry.chunks.length} chunks`);
    }
    return;
  }
  const binding = await readJson(bindingPath);
  if (binding.datasetSignature !== data.signature || binding.knowledgeBases.length !== data.documents.length || binding.knowledgeBases.some(k => !k.prepared)) throw new Error('Binding incomplete/dataset changed');
  for (const kb of binding.knowledgeBases) {
    const actual = await repo.findOne({ where: { id: kb.id, tenantId: binding.tenantId } });
    if (!actual || actual.collectionName !== kb.collectionName || fingerprint(await getChunks(kb)) !== kb.fingerprint) throw new Error('Knowledge base changed');
  }
  const allChunks = binding.knowledgeBases.flatMap(k => k.chunks);
  for (const q of data.questions) if (evidenceCoverage(q, allChunks).some(e => !e.found)) throw new Error(`Unbound evidence: ${q.id}`);
  const reranker = new GlobalRerankService(config);
  const llms = new LLMService(config);
  const codePaths = ['scripts/rag/project-eval.mjs','scripts/rag/project-eval-lib.mjs','scripts/rag/answer-judge.mjs','scripts/rag/answer-eval-lib.mjs','src/rag/rag.service.ts','src/rag/milvus.service.ts','src/tools/rag-retrieval.tool.ts','src/rag/global-rerank.service.ts','src/agent/agent.service.ts','src/agent/supervisor.factory.ts'];
  const settings = { datasetSignature: data.signature, bindingHash: hash(await readFile(bindingPath)), provider: config.get('llm.defaultProvider'), model: config.get('llm.defaultModel'), temperature: 0, rerankEnabled: config.get('rag.rerank.enabled'), rerankModel: config.get('rag.rerank.model'), instruction: '请仅依据当前租户的内部知识库回答，回答简洁且不要加入无依据的扩展。问题：', scope: 'Real cross-KB RagService/tool/AgentService; direct execution, no HTTP/auth/session persistence; no web/MCP. Answerable only; no rejection-quality claim.', sourceHashes: Object.fromEntries(await Promise.all(codePaths.map(async p => [p,hash(await readFile(p))]))), generationTokenUsage: null, generationCost: null, judgeLimit: 'Same model family as generator; source labels not independently human reviewed; automatic quality estimates.' };
  const signature = hash(JSON.stringify(settings));
  await writeJson(resolve(outDir, 'settings.json'), { ...settings, signature });
  const dev = data.questions.filter(q => q.split === 'dev');
  const pilotIds = [dev[0].id, dev.find(q => q.evidence.length > 1).id, dev.find(q => q.evidence[0].source.includes('api')).id, dev.find(q => q.evidence[0].source.includes('pool')).id, dev.find(q => q.evidence[0].source.includes('grants')).id];
  const selected = phase === 'pilot' ? dev.filter(q => pilotIds.includes(q.id)) : data.questions.filter(q => q.split === phase);
  let candidates = [], executions = [];
  const scopedRag = {
    listKnowledgeBases: async tenantId => tenantId === binding.tenantId ? binding.knowledgeBases : [],
    search: async (...args) => {
      if (args[1] !== binding.tenantId || !binding.knowledgeBases.some(k => k.id === args[0])) throw new Error('Outside evaluation scope');
      const row = { knowledgeBaseId: args[0], query: args[2], topK: args[3], mode: args[4] }; candidates.push(row);
      try { row.hits = await rag.search(...args); return row.hits; } catch(e) { row.error = redact(e); throw e; }
    },
  };
  const rows = [];
  const topKs = (process.env.RAG_PROJECT_TOPKS || '3,5,10').split(',').map(Number);
  if (topKs.some(k => !Number.isInteger(k) || k < 1 || k > 20) || new Set(topKs).size !== topKs.length) throw new Error('Invalid TopKs');
  const save = async () => {
    const metrics = command === 'retrieval' ? Object.fromEntries(topKs.map(k => [k,retrievalMetrics(rows.filter(r => r.topK === k))])) : summarizeAnswers(rows);
    await writeJson(resolve(outDir, `${phase}-${command}-summary.json`), { settings, signature, expectedQuestionCount: selected.length, expectedRecordCount: command === 'retrieval' ? selected.length*topKs.length : selected.length, processedRecordCount: rows.length, complete: rows.length === selected.length*(command === 'retrieval' ? topKs.length : 1), metrics, rows });
  };
  for (const question of selected) for (const topK of command === 'retrieval' ? topKs : [null]) {
    const path = resolve(outDir, `${command}-${question.id}${topK ? `-k${topK}` : ''}.json`);
    let row;
    try { const old = await readJson(path); if (old.signature === signature && !old.error && (command === 'retrieval' || old.judgment && !old.judgeError)) row = old; } catch {}
    if (row) { rows.push(row); await save(); console.log(`${question.id} ${topK || 'answer'} reused`); continue; }
    row = { id: question.id, query: question.query, category: question.category, noAnswer: false, topK, signature };
    candidates = []; executions = [];
    const start = performance.now();
    try {
      if (command === 'retrieval') {
        const output = JSON.parse(String(await createRagRetrievalTool(scopedRag,binding.tenantId,reranker).invoke({ query: question.query, topK })));
        row.output = output;
        if (!output.success || output.partialFailure) throw new Error('Incomplete retrieval; see output and candidates');
        const coverage = evidenceCoverage(question, output.results);
        const candidateCoverage = evidenceCoverage(question,candidates.flatMap(c => c.hits || []));
        Object.assign(row, { coverage, candidateCoverage, hit: coverage.some(e => e.found), evidenceRecall: coverage.filter(e => e.found).length/coverage.length, completeEvidence: coverage.every(e => e.found), mergeLostEvidence: coverage.some((e,i) => candidateCoverage[i].found && !e.found) });
      } else {
        const factory = new SupervisorFactory();
        const original = factory.createSupervisorGraph.bind(factory);
        factory.createSupervisorGraph = (llm, definitions) => {
          for (const d of definitions) for (const tool of d.tools) {
            const invoke = tool.invoke.bind(tool);
            tool.invoke = async (input, options) => {
              const call = { name: tool.name, input: input?.args || input }; executions.push(call);
              try { const result = await invoke(input,options); call.completed = true; return result; } catch(e) { call.error=redact(e); throw e; }
            };
          }
          return original(llm,definitions);
        };
        const events = []; row.events = events;
        const agent = new AgentService(llms,{ getByNames: () => [] },factory,{},{},scopedRag,undefined,reranker);
        await agent.execute({ threadId: randomUUID(), runId: randomUUID(), tenantId: binding.tenantId, messages: [{ role: 'user', content: settings.instruction + question.query }], llmOptions: { temperature: 0 }, signal: AbortSignal.timeout(180000), onEvent: e => events.push(e) });
        row.trace = extractTrace(events);
        if (!row.trace.completed || !row.trace.answer || row.trace.calls.some(c => c.name !== 'rag_retrieval')) throw new Error('Incomplete/unexpected Agent run');
      }
    } catch(e) { row.error = redact(e); }
    row.elapsedMs = Math.round(performance.now()-start); row.totalMs = row.elapsedMs;
    row.candidates = candidates; row.toolExecutions = executions;
    await writeJson(path,row);
    if (command === 'answers' && !row.error) {
      for (let attempt=1; attempt<=2; attempt++) {
        try {
          Object.assign(row,await judgeAnswer(llms.createModel({ temperature:0, streaming:false, maxTokens:6000 }), { question: question.query, noAnswer:false, referenceAnswer:question.expectedAnswer, referenceEvidence:question.evidence, response:row.trace.answer, actualRetrievedContexts:row.trace.contexts },question.points));
          delete row.judgeError; break;
        } catch(e) { row.judgeError = redact(e); }
      }
    }
    await writeJson(path,row); rows.push(row); await save();
    console.log(`${question.id} ${topK || 'answer'} ${row.error || row.judgeError || (command === 'retrieval' ? `recall=${row.evidenceRecall}` : `correct=${row.judgment.correct}`)} ${row.elapsedMs}ms`);
  }
  await save();
  if (rows.some(r => r.error || r.judgeError)) process.exitCode = 1;
} finally { await milvus.client?.closeConnection(); await db?.end(); }

}
await main();
