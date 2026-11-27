#!/usr/bin/env node
// Offline judging of saved answers only: never searches, embeds, or regenerates answers.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { judgeAnswer } from './answer-judge.mjs';
import { summarizeAnswers } from './answer-eval-lib.mjs';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { ConfigService } = require('@nestjs/config');
const { LLMService } = require('../../src/llm/llm.service.ts');
const configuration = require('../../src/common/config/configuration.ts').default;
const outDir = resolve(process.argv[2] || 'reports/rag-baseline/cross-kb-grading-20261127');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const read = async (p) => JSON.parse(await readFile(p,'utf8'));
const fixture = await read('datasets/rag-cross-kb-v1/fixture.json');
const rubricRaw = await readFile('datasets/rag-cross-kb-v1/grading-rubric.json','utf8');
const rubric = JSON.parse(rubricRaw);
const variants = [
  { name: 'baseline', path: 'reports/rag-baseline/cross-kb-step3-20261127/agent-results.json' },
  { name: 'rerank', path: 'reports/rag-baseline/cross-kb-step3-rerank-20261127/agent-results.json' },
];
for (const variant of variants) {
  variant.sourceRaw = await readFile(variant.path,'utf8');
  variant.data = JSON.parse(variant.sourceRaw);
  const runSummary = await read(variant.path.replace('agent-results.json', 'summary.json'));
  if (runSummary.fixtureHash !== hash(await readFile('datasets/rag-cross-kb-v1/fixture.json','utf8'))) throw new Error('Source fixture hash mismatch');
  if (variant.data.rows.length !== fixture.cases.length || new Set(variant.data.rows.map((r)=>r.id)).size !== fixture.cases.length) throw new Error('Source case count/IDs changed');
}
const config = new ConfigService(configuration());
const llms = new LLMService(config);
const settings = {
  judgeProvider: config.get('llm.defaultProvider'), judgeModel: config.get('llm.defaultModel'), temperature:0,
  judgeCodeHash:hash(await readFile('scripts/rag/answer-judge.mjs','utf8')),
  metricCodeHash:hash(await readFile('scripts/rag/answer-eval-lib.mjs','utf8')),
  rubricHash:hash(rubricRaw),
  sourceHashes:Object.fromEntries(variants.map((v)=>[v.name,hash(v.sourceRaw)])),
  note:'Same model, rubric, prompt, quote verifier and formulas for both variants; blind independent per-answer judging, no answer regeneration. Same judge family as generator; small sample, automatic estimates need review.',
};
const signature = hash(JSON.stringify(settings));
await mkdir(outDir,{recursive:true});
await writeFile(resolve(outDir,'settings.json'),JSON.stringify({...settings,signature},null,2)+'\n');
const all = { baseline:[],rerank:[] };
async function saveSummary() {
  const results = Object.fromEntries(variants.map((v)=>{
    const rows=all[v.name];
    return [v.name,{expectedQuestionCount:fixture.cases.length,processedQuestionCount:rows.length,metrics:summarizeAnswers(rows),
      faithfulnessScoredQuestionCount:rows.filter((r)=>r.judgment?.claims.length&&!r.error).length,
      answerableOnlyFaithfulnessDiagnostic:summarizeAnswers(rows.filter((r)=>!r.noAnswer)).faithfulnessOnJudgedNonemptyClaims,
      rows:rows.map((r)=>({id:r.id,noAnswer:r.noAnswer,error:r.error,judgeError:r.judgeError,judgment:r.judgment}))}];
  }));
  await writeFile(resolve(outDir,'comparison.json'),JSON.stringify({generatedAt:new Date().toISOString(),settings,results},null,2)+'\n');
}
// Interleave variants by case so drift/rate limits are not assigned entirely to one group.
for (const testCase of fixture.cases) for (const variant of variants) {
  const source=variant.data.rows.find((r)=>r.id===testCase.id);
  const reference=rubric.cases.find((r)=>r.id===testCase.id);
  if (!source||!reference||source.noAnswer!==!!testCase.noAnswer) throw new Error('Fixture or rubric mismatch');
  const path=resolve(outDir,`${variant.name}-${testCase.id}.json`);
  let row;
  try {const saved=await read(path);if(saved.signature===signature&&saved.judgment&&!saved.judgeError&&!saved.error) row=saved;} catch {}
  if (row) {all[variant.name].push(row);await saveSummary();console.log(`${variant.name} ${testCase.id}: reused`);continue;}
  const contexts=source.trace.contexts.map((c)=>({text:c.text,metadata:c.metadata,sources:c.sources?.map((s)=>({knowledgeBaseId:s.knowledgeBaseId,knowledgeBaseName:s.knowledgeBaseName,metadata:s.metadata}))}));
  row={id:testCase.id,noAnswer:!!testCase.noAnswer,category:testCase.category,signature,sourcePath:variant.path,reference,query:testCase.query,totalMs:source.elapsedMs,
    trace:{answer:source.trace.answer,contexts,calls:source.trace.calls},
    toolStatuses:source.trace.results.filter((r)=>r.parsed?.results).map((r)=>({success:r.parsed.success,partialFailure:r.parsed.partialFailure,failedKnowledgeBases:r.parsed.failedKnowledgeBases})),
    error:source.error||(!source.trace.completed||!source.trace.answer?'Incomplete saved answer':null)};
  if (!row.error) {
    for (let attempt=1;attempt<=2;attempt++) {
      try {
        const model=llms.createModel({temperature:0,streaming:false,maxTokens:6000});
        Object.assign(row,await judgeAnswer(model,{question:testCase.query,noAnswer:!!testCase.noAnswer,referenceAnswer:reference.expectedAnswer,referenceEvidence:testCase.evidence,response:source.trace.answer,actualRetrievedContexts:contexts},reference.points));
        row.attempts=attempt;delete row.judgeError;break;
      } catch(e) {row.judgeError=String(e.message).replace(/sk-[w-]+/g,'[REDACTED]');}
    }
  }
  await writeFile(path,JSON.stringify(row,null,2)+'\n');all[variant.name].push(row);await saveSummary();
  console.log(`${variant.name} ${testCase.id}: ${row.error||row.judgeError||`correct=${row.judgment.correct} claims=${row.judgment.claims.length}`}`);
}
await saveSummary();
for (const variant of variants) console.log(JSON.stringify({variant:variant.name,metrics:summarizeAnswers(all[variant.name])},null,2));
if(Object.values(all).flat().some((r)=>r.error||r.judgeError))process.exitCode=1;
