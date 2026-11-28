import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceCoverage, retrievalMetrics, loadDataset } from './project-eval-lib.mjs';

test('同文不同来源不能替代标准证据，合并来源可以匹配', () => {
  const q = { evidence: [{ source:'corpus/a.md', quote:'超时 2800 毫秒' }] };
  assert.equal(evidenceCoverage(q,[{text:'超时 2800 毫秒',metadata:{source:'b.md'}}])[0].found,false);
  assert.equal(evidenceCoverage(q,[{text:'超时 2800 毫秒',sources:[{metadata:{source:'b.md'}},{metadata:{source:'a.md'}}]}])[0].found,true);
});
test('组合题缺一处证据，重复片段不会补足缺失证据', () => {
  const q = { evidence: [{source:'corpus/a.md',quote:'超时 2800'},{source:'corpus/b.md',quote:'重试 3 次'}] };
  const coverage=evidenceCoverage(q,[{text:'超时 2800',metadata:{source:'a.md'}},{text:'超时 2800',metadata:{source:'a.md'}}]);
  assert.deepEqual(coverage.map(e=>e.found),[true,false]);
});
test('失败保留在召回分母，完整性与命中独立统计', () => {
  const m=retrievalMetrics([{id:'a',hit:true,evidenceRecall:.5,completeEvidence:false,mergeLostEvidence:true,elapsedMs:10},{id:'b',error:'timeout',hit:true,evidenceRecall:1,completeEvidence:true}]);
  assert.equal(m.hitRate,.5); assert.equal(m.evidenceRecall,.25); assert.equal(m.completeEvidenceRate,0);
  assert.deepEqual(m.mergeLostCases,['a']); assert.equal(m.failedCount,1);
});
test('发布题库全部有答案且同一事实家族不会跨 dev/test', async () => {
  const {questions,manifest}=await loadDataset();
  assert.equal(questions.length,manifest.questionCount);
  assert.ok(questions.every(q=>q.noAnswer===false));
  const familySplits=new Map();
  for(const q of questions){if(familySplits.has(q.familyId)) assert.equal(familySplits.get(q.familyId),q.split);familySplits.set(q.familyId,q.split);}
});
