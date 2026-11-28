import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from './project-eval-lib.mjs';
import {
  validatePair,
  pairedChanges,
  compareReports,
} from './project-compare-lib.mjs';

const questions = [
  {
    id: 'q1',
    query: '问题',
    points: ['答案'],
    evidence: [{ source: 'corpus/a.md', line: 1, quote: '答案' }],
  },
];
function report(enabled, kind = 'retrieval') {
  const settings = {
    datasetSignature: 'same',
    bindingHash: 'same',
    model: 'fixed',
    rerankEnabled: enabled,
    sourceHashes: { script: 'same' },
  };
  const signature = hash(JSON.stringify(settings));
  const row = {
    id: 'q1',
    query: '问题',
    noAnswer: false,
    signature,
    candidates: [],
    error: undefined,
  };
  const rows =
    kind === 'retrieval'
      ? [3, 5, 10].map((k) => ({
          ...row,
          topK: k,
          coverage: [{ ...questions[0].evidence[0], found: enabled }],
          hit: enabled,
          evidenceRecall: Number(enabled),
          completeEvidence: enabled,
          mergeLostEvidence: !enabled,
          elapsedMs: 1,
          output: {
            reranking: {
              applied: enabled,
              ...(!enabled ? { fallbackReason: 'disabled' } : {}),
            },
          },
        }))
      : [
          {
            ...row,
            totalMs: 1,
            trace: { calls: [], results: [] },
            judgment: {
              correct: true,
              relevant: true,
              abstained: false,
              points: [{ point: '答案', covered: true }],
              claims: [{ supported: true }],
            },
          },
        ];
  return {
    settings,
    signature,
    complete: true,
    processedRecordCount: rows.length,
    expectedRecordCount: rows.length,
    expectedQuestionCount: 1,
    rows,
  };
}
function resign(r) {
  r.signature = hash(JSON.stringify(r.settings));
  for (const row of r.rows) row.signature = r.signature;
  return r;
}
test('同题不同顺序可配对，候选一致时只统计合并质量变化', () => {
  const a = report(false),
    b = report(true);
  b.rows.reverse();
  const result = compareReports(a, b, 'retrieval', questions);
  assert.deepEqual(result.differentCandidateSets, []);
  assert.equal(result.byTopK[3].baseline.evidenceRecall, 0);
  assert.equal(result.byTopK[3].rerank.evidenceRecall, 1);
  assert.deepEqual(result.byTopK[3].pairedCompleteEvidence.improved, ['q1:k3']);
  assert.equal(result.toolAudit.baseline.rerankApplied, 0);
});
test('缺题、重复题、未完成或不同 TopK 的报告必须拒绝', () => {
  for (const change of [
    (r) => (r.complete = false),
    (r) => r.rows.pop(),
    (r) => (r.rows[0] = r.rows[1]),
    (r) => (r.rows[0].topK = 7),
  ]) {
    const b = report(true);
    change(b);
    assert.throws(() => validatePair(report(false), b, 'retrieval', questions));
  }
});
test('模型、语料、知识库绑定或标签不同不能声称同条件对比', () => {
  for (const field of ['model', 'datasetSignature', 'bindingHash']) {
    const b = report(true);
    b.settings[field] = 'changed';
    resign(b);
    assert.throws(
      () => validatePair(report(false), b, 'retrieval', questions),
      /Configurations differ/,
    );
  }
  const b = report(true);
  b.rows[0].coverage[0].quote = '别的证据';
  assert.throws(
    () => validatePair(report(false), b, 'retrieval', questions),
    /Changed evidence/,
  );
});
test('实际 query、签名与固定评分要点也必须一致', () => {
  const b = report(true);
  b.rows[0].query = '另一问题';
  assert.throws(
    () => validatePair(report(false), b, 'retrieval', questions),
    /Changed query/,
  );
  const changed = report(true, 'answers');
  changed.rows[0].judgment.points[0].point = '新要点';
  assert.throws(
    () => validatePair(report(false, 'answers'), changed, 'answers', questions),
    /Changed reference points/,
  );
  const invalid = report(true);
  invalid.signature = 'wrong';
  assert.throws(
    () => validatePair(report(false), invalid, 'retrieval', questions),
    /signature/,
  );
});
test('失败不从正确率分母删除；配对明确保留退步', () => {
  const a = report(false, 'answers'),
    b = report(true, 'answers');
  b.rows[0].error = 'timeout';
  delete b.rows[0].judgment;
  const result = compareReports(a, b, 'answers', questions);
  assert.equal(result.rerank.answerableCorrectRate, 0);
  assert.deepEqual(result.pairedCorrectness.regressed, ['q1']);
  assert.throws(
    () => pairedChanges(a.rows, [], (r) => 0, 'answers'),
    /Missing paired/,
  );
});
