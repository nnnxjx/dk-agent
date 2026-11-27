import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAnswer } from './answer-judge.mjs';
const result = { correct:true,abstained:false,relevant:true,points:[{point:'固定要点',covered:true,reason:'匹配'}],claims:[{claim:'事实',supported:true,evidence:'不存在的引文',reason:'认为有依据'}],reason:'结论' };
const model = (data) => ({ invoke:async()=>({content:'```json\n'+JSON.stringify(data)+'\n```',usage_metadata:{total_tokens:10}}) });
test('keeps raw labels while downgrading nonmatching quotations',async()=>{
 const r=await judgeAnswer(model(result),{actualRetrievedContexts:[{text:'原文'}]},['固定要点']);
 assert.equal(r.rawJudgment.claims[0].supported,true);assert.equal(r.judgment.claims[0].supported,false);
 assert.equal(r.judgeTokenUsage.total_tokens,10);
});
test('rejects missing or renamed reference points',async()=>{
 await assert.rejects(()=>judgeAnswer(model(result),{actualRetrievedContexts:[]},['另一个要点']),/fixed reference points/);
});
test('retains supported statements when a formatted quotation exists',async()=>{
 const r=await judgeAnswer(model({...result,claims:[{claim:'事实',supported:true,evidence:'模型 1024',reason:'匹配'}]}),{actualRetrievedContexts:[{text:'**模型** | 1024'}]},['固定要点']);
 assert.equal(r.judgment.claims[0].supported,true);
});
