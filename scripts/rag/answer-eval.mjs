#!/usr/bin/env node
// Controlled integration evaluation: real ChatController + Agent + RAG, in-memory conversations.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { judgeAnswer } from './answer-judge.mjs';
import { SSEDecoder, extractTrace, summarizeAnswers } from './answer-eval-lib.mjs';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { ChatController } = require('../../src/chat/chat.controller.ts');
const { ChatService } = require('../../src/chat/chat.service.ts');
const { RunRegistry } = require('../../src/chat/run-registry.service.ts');
const { JwtAuthGuard, TenantGuard } = require('../../src/auth/guards.ts');
const { AgentService } = require('../../src/agent/agent.service.ts');
const { SupervisorFactory } = require('../../src/agent/supervisor.factory.ts');
const { LLMService } = require('../../src/llm/llm.service.ts');
const { GlobalRerankService } = require('../../src/rag/global-rerank.service.ts');
const { RagService } = require('../../src/rag/rag.service.ts');
const { MilvusService } = require('../../src/rag/milvus.service.ts');
const configuration = require('../../src/common/config/configuration.ts').default;
const phase = process.argv[2] || 'pilot';
if (!['pilot', 'dev'].includes(phase)) throw new Error('Usage: answer-eval.mjs pilot|dev [outputDirectory]');
const outDir = resolve(process.argv[3] || 'reports/rag-baseline/step2-answer/answer-step2-20261126');
const binding = JSON.parse(await readFile('reports/rag-baseline/step1-single-kb/retrieval-step1-20261126/binding.json', 'utf8'));
const rawQuestions = await readFile('datasets/rag/single-kb/v1/questions.jsonl', 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
if (hash(rawQuestions) !== binding.questionHash) throw new Error('Question set changed; rebind first');
const pilotIds = ['hybrid-001', 'hybrid-003', 'hybrid-006', 'hybrid-030', 'hybrid-033'];
const questions = binding.questions.filter((q) => q.split === 'dev' && (phase === 'dev' || pilotIds.includes(q.id)));
const config = new ConfigService(configuration());
const reranker = new GlobalRerankService(config);
const llms = new LLMService(config);
const model = config.get('llm.defaultModel');
const provider = config.get('llm.defaultProvider');
if (!['openai', 'anthropic', 'dashscope', 'deepseek'].includes(provider)) throw new Error('Unsupported evaluation provider');
// HTTP schema omits deepseek, so use the configured default provider in that case.
const httpOptions = { ...(provider === 'deepseek' ? {} : { provider }), model, temperature: 0 };
const instruction = '请仅依据这个项目的内部知识库回答；资料不足请明确说明，不要推测。问题：';
const settings = {
  version: 3, rerankEnabled: config.get('rag.rerank.enabled'), rerankModel: config.get('rag.rerank.model'), knowledgeBaseName: binding.kb.name, kbId: binding.kb.id,
  corpusFingerprint: binding.corpusFingerprint, questionHash: binding.questionHash,
  provider, model, temperature: 0, instruction,
  scope: 'Controlled HTTP/SSE integration using real ChatController, AgentService, SupervisorFactory, rag_retrieval and RagService.search; authentication and persistence replaced by local test doubles; one KB; web/MCP absent; production prompts unchanged.',
  topK: 'Agent-selected (recorded per call); tool uses Hybrid',
  generationTokenUsage: null, generationCost: null,
  judgeModel: model, judgeProvider: provider, judgeVersion: 1,
  judgeLimit: 'Same model as generator; automatic estimates require human review; no claim of independent objective accuracy.',
};
settings.sourceHashes = Object.fromEntries(await Promise.all(['src/agent/agent.service.ts', 'src/agent/supervisor.factory.ts', 'src/chat/chat.controller.ts', 'src/tools/rag-retrieval.tool.ts', 'src/rag/rag.service.ts', 'src/rag/milvus.service.ts', 'src/rag/global-rerank.service.ts', 'scripts/rag/answer-judge.mjs'].map(async (path) => [path, hash(await readFile(path, 'utf8'))])));
const signature = hash(JSON.stringify(settings));
let db, milvus, app;
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'settings.json'), JSON.stringify({ ...settings, signature }, null, 2) + '\n');
try {
  db = await mysql.createConnection({ host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectTimeout: 5000 });
  const [kbs] = await db.execute('SELECT id, name, tenant_id AS tenantId, collection_name AS collectionName, embedding_model AS embeddingModel FROM knowledge_bases WHERE id = ? AND tenant_id = ?', [binding.kb.id, binding.kb.tenantId]);
  const kb = kbs[0];
  if (!kb || kb.name !== binding.kb.name || kb.collectionName !== binding.kb.collectionName || kb.embeddingModel !== 'BAAI/bge-m3') throw new Error('KB binding changed');
  milvus = new MilvusService(config); await milvus.onModuleInit();
  if (!milvus.isAvailable()) throw new Error('Milvus unavailable');
  const response = await milvus.client.query({ collection_name: kb.collectionName, filter: `knowledge_base_id == "${kb.id}"`, output_fields: ['id', 'text', 'metadata'], limit: 10000 });
  if (response.status?.error_code !== 'Success') throw new Error('Corpus query failed');
  const fingerprint = hash(JSON.stringify(response.data.map((c) => ({ id: c.id, text: c.text, source: c.metadata.source })).sort((a, b) => String(a.id).localeCompare(String(b.id)))));
  if (fingerprint !== binding.corpusFingerprint) throw new Error('Corpus changed');
  const rag = new RagService({ findOne: async ({ where }) => where.id === kb.id && where.tenantId === kb.tenantId ? kb : null }, milvus, config);
  const scopedRag = { listKnowledgeBases: async (tenantId) => tenantId === kb.tenantId ? [kb] : [], search: rag.search.bind(rag) };
  let toolExecutions = [];
  const factory = new SupervisorFactory();
  const originalGraph = factory.createSupervisorGraph.bind(factory);
  factory.createSupervisorGraph = (llm, definitions) => {
    for (const definition of definitions) for (const tool of definition.tools) {
      const originalInvoke = tool.invoke.bind(tool);
      tool.invoke = async (input, options) => {
        const execution = { name: tool.name, input: input?.args || input, startedAt: new Date().toISOString() };
        toolExecutions.push(execution);
        try { const result = await originalInvoke(input, options); execution.completed = true; return result; }
        catch (error) { execution.error = String(error.message); throw error; }
      };
    }
    return originalGraph(llm, definitions);
  };
  const agent = new AgentService(llms, { getByNames: () => [] }, factory, {}, {}, scopedRag, undefined, reranker);
  const conversations = new Map();
  const memoryChat = {
    createConversation: async (_user, tenantId, title) => { const c = { id: randomUUID(), tenantId, title: title || 'Evaluation', messages: [] }; conversations.set(c.id, c); return c; },
    getConversation: async (id, tenantId) => { const c = conversations.get(id); if (!c || c.tenantId !== tenantId) throw new Error('Unknown evaluation conversation'); return c; },
    addMessage: async (id, _tenant, role, content) => conversations.get(id).messages.push({ role, content }),
    getContextMessages: async (id) => conversations.get(id).messages,
    touchConversation: async () => {}, generateTitle: async () => {},
  };
  const module = await Test.createTestingModule({ controllers: [ChatController], providers: [
    { provide: ChatService, useValue: memoryChat }, { provide: AgentService, useValue: agent }, RunRegistry,
  ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx) => { ctx.switchToHttp().getRequest().user = { id: 'evaluation-only', tenantId: kb.tenantId }; return true; } }).overrideGuard(TenantGuard).useValue({ canActivate: () => true }).compile();
  app = module.createNestApplication({ logger: ['error', 'warn'] });
  app.setGlobalPrefix('api/v1'); await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl(); const rows = [];
  const saveSummary = async () => writeFile(resolve(outDir, `${phase}-summary.json`), JSON.stringify({ settings, phase, expectedQuestionCount: questions.length, processedQuestionCount: rows.length, metrics: summarizeAnswers(rows), rows: rows.map((r) => ({ id: r.id, error: r.error, judgeError: r.judgeError, judgment: r.judgment })) }, null, 2) + '\n');
  for (const question of questions) {
    const path = resolve(outDir, `${question.id}.json`);
    let row;
    try { const previous = JSON.parse(await readFile(path, 'utf8')); if (previous.signature === signature && previous.judgment && !previous.error && !previous.judgeError) row = previous; } catch {}
    if (row) { rows.push(row); await saveSummary(); console.log(`${question.id}: reused`); continue; }
    row = { id: question.id, query: question.query, category: question.category, noAnswer: question.noAnswer, expectedAnswer: question.expectedAnswer, signature, generatedAt: new Date().toISOString() };
    toolExecutions = [];
    const events = []; const start = performance.now();
    try {
      const conversation = await memoryChat.createConversation(null, kb.tenantId, `RAG evaluation ${question.id}`);
      row.conversationId = conversation.id;
      const res = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conversation.id, message: instruction + question.query, llmOptions: httpOptions }), signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decoder = new SSEDecoder((e) => { events.push({ ...e, receivedMs: Math.round(performance.now() - start) }); if (e.type === 'TEXT_MESSAGE_CONTENT' && row.firstTextMs === undefined) row.firstTextMs = Math.round(performance.now() - start); });
      const textDecoder = new TextDecoder();
      for await (const bytes of res.body) decoder.push(textDecoder.decode(bytes, { stream: true }));
      decoder.push(textDecoder.decode()); decoder.finish();
      row.trace = extractTrace(events);
      if (!row.trace.completed || !row.trace.answer) throw new Error('Run did not complete with a nonempty answer');
      if (row.trace.calls.some((c) => c.name !== 'rag_retrieval')) throw new Error('Unexpected tool call');
    } catch (error) { row.error = String(error.message).replace(/sk-[\w-]+/g, '[REDACTED]'); }
    row.totalMs = Math.round(performance.now() - start); row.events = events; row.toolExecutions = toolExecutions;
    if (!row.error && row.trace?.calls.length && !toolExecutions.length) row.error = 'Tool execution instrumentation did not capture calls';
    await writeFile(path, JSON.stringify(row, null, 2) + '\n');
    if (!row.error) {
      try {
        const judge = llms.createModel({ provider, model, temperature: 0, streaming: false, maxTokens: 6000 });
        Object.assign(row, await judgeAnswer(judge, { question: question.query, noAnswer: question.noAnswer, referenceAnswer: question.expectedAnswer, referenceEvidence: question.evidence, response: row.trace.answer, actualRetrievedContexts: row.trace.contexts }));
      } catch (error) { row.judgeError = String(error.message).replace(/sk-[\w-]+/g, '[REDACTED]'); }
    }
    await writeFile(path, JSON.stringify(row, null, 2) + '\n'); rows.push(row); conversations.clear();
    await saveSummary();
    console.log(`${question.id}: ${row.error || row.judgeError || `correct=${row.judgment.correct} abstained=${row.judgment.abstained}`} ${row.totalMs}ms`);
    if (phase === 'pilot' && (row.error || row.judgeError)) break;
  }
  console.log(JSON.stringify({ phase, model, metrics: summarizeAnswers(rows), outDir }, null, 2));
  await saveSummary();
  if (rows.length !== questions.length || rows.some((r) => r.error || r.judgeError)) process.exitCode = 1;
} finally { await app?.close(); await milvus?.client?.closeConnection(); await db?.end(); }
