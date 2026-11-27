#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { extractTrace } from './answer-eval-lib.mjs';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { ConfigService } = require('@nestjs/config');
const { GlobalRerankService } = require('../../src/rag/global-rerank.service.ts');
const { RagService } = require('../../src/rag/rag.service.ts');
const { MilvusService } = require('../../src/rag/milvus.service.ts');
const { createRagRetrievalTool } = require('../../src/tools/rag-retrieval.tool.ts');
const { LLMService } = require('../../src/llm/llm.service.ts');
const { AgentService } = require('../../src/agent/agent.service.ts');
const { SupervisorFactory } = require('../../src/agent/supervisor.factory.ts');
const configuration = require('../../src/common/config/configuration.ts').default;
const command = process.argv[2];
if (!['prepare', 'evaluate'].includes(command)) throw new Error('Usage: cross-kb-eval.mjs prepare|evaluate [outputDirectory]');
const outDir = resolve(process.argv[3] || 'reports/rag-baseline/cross-kb-step3-20261127');
const fixtureRaw = await readFile('datasets/rag-cross-kb-v1/fixture.json', 'utf8');
const fixture = JSON.parse(fixtureRaw);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const config = new ConfigService(configuration());
const reranker = new GlobalRerankService(config);
async function main() {
const db = await mysql.createConnection({ host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectTimeout: 5000 });
const milvus = new MilvusService(config);
let state;
const bindingPath = resolve(process.env.RAG_CROSS_BINDING || resolve(outDir, 'binding.json'));
const columns = 'id, name, tenant_id AS tenantId, collection_name AS collectionName, embedding_model AS embeddingModel, chunk_size AS chunkSize, chunk_overlap AS chunkOverlap, document_count AS documentCount';
const repo = {
  create: (value) => ({ ...value, id: randomUUID(), documentCount: 0 }),
  save: async (kb) => {
    await db.execute('INSERT INTO knowledge_bases (id,name,description,tenant_id,collection_name,embedding_model,chunk_size,chunk_overlap,document_count) VALUES (?,?,?,?,?,?,?,?,?)', [kb.id,kb.name,kb.description,kb.tenantId,kb.collectionName,kb.embeddingModel,kb.chunkSize,kb.chunkOverlap,kb.documentCount]); return kb;
  },
  findOne: async ({ where }) => (await db.execute(`SELECT ${columns} FROM knowledge_bases WHERE id = ? AND tenant_id = ?`, [where.id, where.tenantId]))[0][0] || null,
  find: async ({ where }) => (await db.execute(`SELECT ${columns} FROM knowledge_bases WHERE tenant_id = ?`, [where.tenantId]))[0],
  update: async (id, fields) => db.execute('UPDATE knowledge_bases SET document_count = ? WHERE id = ?', [fields.documentCount, id]),
};
const rag = new RagService(repo, milvus, config);
const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();
const chunkFingerprint = (chunks) => hash(JSON.stringify(chunks.map((c) => ({ id: String(c.id), text: c.text, metadata: c.metadata })).sort((a,b) => a.id.localeCompare(b.id))));
async function getChunks(kb) {
  const r = await milvus.client.query({ collection_name: kb.collectionName, filter: `knowledge_base_id == "${kb.id}"`, output_fields: ['id','text','metadata'], limit: 1000 });
  if (r.status?.error_code !== 'Success') throw new Error('Failed to read fixture collection');
  return r.data;
}
await mkdir(outDir, { recursive: true });
try {
  await milvus.onModuleInit(); if (!milvus.isAvailable()) throw new Error('Milvus unavailable');
  if (command === 'prepare') {
    try { await readFile(bindingPath); throw new Error('Binding exists; use a new output directory to avoid duplicate fixtures'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const runTag = randomUUID();
    state = { fixtureHash: hash(fixtureRaw), runTag, tenantId: `rag-step3-${runTag}`, foreignTenantId: `rag-step3-other-${runTag}`, knowledgeBases: [], createdAt: new Date().toISOString() };
    await writeFile(bindingPath, JSON.stringify(state,null,2)+'\n');
    for (let i = 0; i < fixture.knowledgeBases.length; i++) {
      const definition = fixture.knowledgeBases[i];
      // Force distractors before targets in UUID order to expose rank-interleave truncation.
      const originalCreate = repo.create;
      repo.create = (value) => ({ ...originalCreate(value), id: `${String(i+1).padStart(8,'0')}-${randomUUID().slice(9)}` });
      const kb = await rag.createKnowledgeBase(`${definition.name}-${runTag.slice(0,8)}`, 'Synthetic step-3 fixture; safe to identify by dedicated tenant and binding', definition.foreign ? state.foreignTenantId : state.tenantId);
      const entry = { ...kb, role: definition.role, prepared: false };
      state.knowledgeBases.push(entry); await writeFile(bindingPath, JSON.stringify(state,null,2)+'\n');
      await rag.addDocuments(kb.id, kb.tenantId, definition.documents);
      const flushed = await milvus.client.flushSync({ collection_names: [kb.collectionName] });
      if (flushed.status?.error_code && flushed.status.error_code !== 'Success') throw new Error('Flush failed');
      entry.chunks = await getChunks(kb); entry.fingerprint = chunkFingerprint(entry.chunks); entry.prepared = true;
      if (entry.chunks.length !== definition.documents.length) throw new Error('Unexpected chunk count');
      await writeFile(bindingPath, JSON.stringify(state,null,2)+'\n');
      console.log(`Prepared ${definition.role}: ${entry.chunks.length} chunks`);
    }
    return;
  }
  state = JSON.parse(await readFile(bindingPath,'utf8'));
  if (state.fixtureHash !== hash(fixtureRaw) || state.knowledgeBases.length !== fixture.knowledgeBases.length || state.knowledgeBases.some((k) => !k.prepared)) throw new Error('Incomplete or changed fixture');
  for (const kb of state.knowledgeBases) {
    const actual = await repo.findOne({ where: { id: kb.id, tenantId: kb.tenantId } });
    if (!actual || actual.collectionName !== kb.collectionName || chunkFingerprint(await getChunks(kb)) !== kb.fingerprint) throw new Error('Fixture binding changed');
  }
  const foreign = state.knowledgeBases.find((k) => k.role === 'foreign');
  const ownerHits = await rag.search(foreign.id, state.foreignTenantId, '霁云网关隔离标记的具体值', 5, 'hybrid');
  let denied = false;
  try { await rag.search(foreign.id, state.tenantId, '霁云网关隔离标记的具体值', 5, 'hybrid'); } catch (e) { if (e.getStatus?.() !== 404) throw e; denied = true; }
  const isolation = { ownerCanRetrieveCanary: ownerHits.some((h) => h.text.includes('STEP3_FOREIGN_ONLY_7F')), wrongTenantDirectSearchDenied: denied, note: 'Real SQL tenant predicates and RagService path; not HTTP authentication testing' };
  if (!isolation.ownerCanRetrieveCanary || !denied) throw new Error('Isolation precondition/check failed');
  function serviceFor(testCase, telemetry) {
    let active = 0;
    return {
      listKnowledgeBases: rag.listKnowledgeBases.bind(rag),
      search: async (...args) => {
        const kb = state.knowledgeBases.find((k) => k.id === args[0]);
        const row = { knowledgeBaseId: kb?.id, role: kb?.role, tenantId: args[1], query: args[2], candidateK: args[3], mode: args[4], hits: [] };
        telemetry.candidates.push(row); active++; telemetry.maxConcurrency = Math.max(telemetry.maxConcurrency,active);
        try {
          if (testCase.failure === 'all' || testCase.failure === kb?.role) throw new Error('Injected evaluation-only KB failure');
          row.hits = await rag.search(...args); return row.hits;
        } catch (e) { row.error = String(e.message); throw e; } finally { active--; }
      },
    };
  }
  function evidenceCoverage(testCase, hits) {
    return testCase.evidence.map((evidence) => ({ evidence, found: hits.some((h) => normalize(h.text).includes(normalize(evidence))) }));
  }
  const rows = [];
  for (const testCase of fixture.cases) for (const topK of [3,5,10]) {
    const telemetry = { candidates: [], maxConcurrency: 0 };
    const start = performance.now();
    const output = JSON.parse(String(await createRagRetrievalTool(serviceFor(testCase,telemetry),state.tenantId,reranker).invoke({ query: testCase.query, topK })));
    const coverage = evidenceCoverage(testCase,output.results);
    const candidates = evidenceCoverage(testCase,telemetry.candidates.flatMap((c) => c.hits));
    const duplicateHit = testCase.duplicate ? output.results.find((h) => normalize(h.text) === normalize(testCase.evidence[0])) : null;
    const duplicateSources = duplicateHit?.sources || [];
    const row = { id: testCase.id, category: testCase.category, topK, noAnswer: !!testCase.noAnswer, failure: testCase.failure, elapsedMs: Math.round(performance.now()-start),
      hit: coverage.length ? coverage.some((c) => c.found) : null,
      completeEvidence: coverage.length ? coverage.every((c) => c.found) : null,
      evidenceRecall: coverage.length ? coverage.filter((c) => c.found).length/coverage.length : null,
      candidatesComplete: candidates.length ? candidates.every((c) => c.found) : null,
      mergeLostEvidence: coverage.some((c,i) => candidates[i].found && !c.found),
      leaked: JSON.stringify(output).includes('STEP3_FOREIGN_ONLY_7F') || output.results.some((h) => h.sources.some((s) => s.knowledgeBaseId === foreign.id)),
      duplicateSourceCount: testCase.duplicate ? duplicateSources.length : null,
      duplicateSourcesComplete: testCase.duplicate ? ['targetA','targetB'].every((role) => duplicateSources.some((s) => s.knowledgeBaseId === state.knowledgeBases.find((k) => k.role === role).id)) : null,
      output, telemetry };
    rows.push(row); console.log(`${row.id} k=${topK} hit=${row.hit} all=${row.completeEvidence} lost=${row.mergeLostEvidence}`);
    await writeFile(resolve(outDir,'retrieval-results.json'),JSON.stringify({isolation,rows},null,2)+'\n');
  }
  const generation = [];
  const llms = new LLMService(config);
  for (const testCase of fixture.cases) {
    const telemetry = { candidates: [], maxConcurrency: 0 }; const events = [];
    const agent = new AgentService(llms,{getByNames:()=>[]},new SupervisorFactory(),{},{},serviceFor(testCase,telemetry),undefined,reranker);
    const start = performance.now(); let error;
    try {
      await agent.execute({ threadId: randomUUID(),runId:randomUUID(),tenantId:state.tenantId,
        messages:[{role:'user',content:'请仅依据当前租户的内部知识库回答；资料不足或检索失败请明确说明，不要推测。问题：'+testCase.query}],
        llmOptions:{temperature:0},signal:AbortSignal.timeout(180000),onEvent:(e)=>events.push(e) });
    } catch (e) { error=String(e.message); }
    const trace = extractTrace(events);
    const abstained = /无法|不能确认|没有.{0,12}(依据|信息|记录)|未.{0,8}(找到|提供)|检索失败|查询失败|暂时无法/.test(trace.answer);
    const row = { id:testCase.id,noAnswer:!!testCase.noAnswer,elapsedMs:Math.round(performance.now()-start),error:error||(!trace.completed||!trace.answer?'Incomplete agent answer':null),
      requiredLiterals:testCase.answerTokens.map((token)=>({token,present:trace.answer.includes(token)})),
      abstained, leaked:trace.answer.includes('STEP3_FOREIGN_ONLY_7F'),
      allFailureDoesNotInventTimeout:testCase.failure==='all'?abstained&&!trace.answer.includes('2800'):null,
      trace,telemetry,events };
    generation.push(row); console.log(`Agent ${row.id}: completed=${!row.error} abstained=${abstained}`);
    await writeFile(resolve(outDir,'agent-results.json'),JSON.stringify({model:config.get('llm.defaultModel'),provider:config.get('llm.defaultProvider'),note:'Direct real AgentService execution, no HTTP/auth/persistence; deterministic literal checks are not full correctness judgments',rows:generation},null,2)+'\n');
  }
  const summary = {
    generatedAt:new Date().toISOString(),fixtureHash:state.fixtureHash,isolation,
    rerankEnabled:config.get('rag.rerank.enabled'),
    scope:'Synthetic cross-KB integration; real SQL/RagService/Milvus/Hybrid/tool/AgentService; no HTTP/auth test',
    model:config.get('llm.defaultModel'),provider:config.get('llm.defaultProvider'),temperature:0,
    sourceHashes:Object.fromEntries(await Promise.all(['src/tools/rag-retrieval.tool.ts','src/rag/rag.service.ts','src/rag/milvus.service.ts','src/agent/agent.service.ts','src/agent/supervisor.factory.ts'].map(async(path)=>[path,hash(await readFile(path,'utf8'))]))),
    byTopK:Object.fromEntries([3,5,10].map((k)=>{ const relevant=rows.filter((r)=>r.topK===k&&!r.noAnswer);const mean=(key)=>relevant.reduce((s,r)=>s+Number(r[key]),0)/relevant.length;return[k,{answerableCases:relevant.length,hitRate:mean('hit'),allEvidenceRate:mean('completeEvidence'),evidenceRecall:mean('evidenceRecall'),mergeLostCases:relevant.filter((r)=>r.mergeLostEvidence).map((r)=>r.id)}];})),
    contractChecks:{noTenantLeak:rows.every((r)=>!r.leaked),concurrencyAtMostFour:rows.every((r)=>r.telemetry.maxConcurrency<=4),observedMaxConcurrency:Math.max(...rows.map((r)=>r.telemetry.maxConcurrency)),
      partialFailureFlags:rows.filter((r)=>r.id==='partial-failure').every((r)=>r.output.success&&r.output.partialFailure&&r.output.failedKnowledgeBases.length===1),
      allFailureFlags:rows.filter((r)=>r.id==='all-failure').every((r)=>!r.output.success&&!r.output.partialFailure&&!r.output.results.length&&r.output.failedKnowledgeBases.length===6),
      dedupAllSourcesAt10:rows.find((r)=>r.id==='dedup'&&r.topK===10).duplicateSourcesComplete},
    generation:{count:generation.length,failedCount:generation.filter((r)=>r.error).length,requiredLiteralCasesPassed:generation.filter((r)=>!r.noAnswer&&!r.error&&r.requiredLiterals.every((c)=>c.present)).length,answerableCount:generation.filter((r)=>!r.noAnswer).length,noTenantLeak:generation.every((r)=>!r.leaked),allFailureDoesNotInventTimeout:generation.find((r)=>r.id==='all-failure').allFailureDoesNotInventTimeout},
    limitations:['Small synthetic fixture; no production accuracy claim','Faults injected in evaluation wrapper only; actual healthy searches use real SQL/Milvus/Embedding','Generation checks are literals/abstention heuristics, manually inspect answers','Dedicated tenant fixtures retained; no production data changed; binding identifies created KBs'],
  };
  await writeFile(resolve(outDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
  const contracts = summary.contractChecks;
  if (!contracts.noTenantLeak || !contracts.concurrencyAtMostFour || !contracts.partialFailureFlags || !contracts.allFailureFlags || !contracts.dedupAllSourcesAt10 || summary.generation.failedCount || !summary.generation.noTenantLeak || !summary.generation.allFailureDoesNotInventTimeout) process.exitCode = 1;
} finally { await milvus.client?.closeConnection(); await db.end(); }

}
await main();
