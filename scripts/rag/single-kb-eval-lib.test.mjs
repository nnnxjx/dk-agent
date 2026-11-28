import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindQuestions,
  scoreSingle,
  summarizeSingle,
} from './single-kb-eval-lib.mjs';
const kb = { id: 'kb', tenantId: 'tenant' };
const q = {
  id: 'q',
  noAnswer: false,
  evidence: [
    { source: 'corpus/a.md', quote: '超时 2800' },
    { source: 'corpus/b.md', quote: '重试 3 次' },
  ],
};
const chunks = [
  { id: 'a1', text: '超时 2800', metadata: { source: 'a.md' } },
  { id: 'a2', text: '默认超时 2800', metadata: { source: 'a.md' } },
  { id: 'wrong', text: '重试 3 次', metadata: { source: 'a.md' } },
  { id: 'b', text: '重试 3 次', metadata: { source: 'b.md' } },
];
test('绑定来源与原文，重叠分块归同一证据组，保留逐题 Chunk ID', () => {
  const [bound] = bindQuestions([q], chunks, kb);
  assert.deepEqual(
    bound.evidenceGroups.map((g) => g.relevantChunkIds),
    [['a1', 'a2'], ['b']],
  );
  assert.deepEqual(bound.relevantChunkIds, ['a1', 'a2', 'b']);
  assert.equal(bound.knowledgeBaseId, 'kb');
});
test('Chunk Recall 与证据覆盖独立，重复返回不会重复计分', () => {
  const [bound] = bindQuestions([q], chunks, kb);
  const result = scoreSingle(
    bound,
    [{ id: 'a1' }, { id: 'b' }, { id: 'b' }],
    3,
  );
  assert.equal(result.recall, 2 / 3);
  assert.equal(result.precision, 2 / 3);
  assert.equal(result.evidenceRecall, 1);
  assert.equal(result.allEvidenceFound, true);
});
test('证据缺失或跨分块不能静默忽略，错误来源不算支持', () => {
  assert.throws(
    () =>
      bindQuestions(
        [q],
        chunks.filter((c) => c.id !== 'b'),
        kb,
      ),
    /Missing/,
  );
  assert.throws(
    () =>
      bindQuestions(
        [{ ...q, evidence: [{ source: 'a.md', quote: '' }] }],
        chunks,
        kb,
      ),
    /Missing/,
  );
});
test('只评指定 TopK，并将失败留在质量分母中', () => {
  const [bound] = bindQuestions([q], chunks, kb);
  const scored = scoreSingle(
    bound,
    [{ id: 'wrong' }, { id: 'a1' }, { id: 'b' }],
    2,
  );
  assert.equal(scored.evidenceRecall, 0.5);
  assert.equal(scored.allEvidenceFound, false);
  const result = summarizeSingle(
    [
      { ...scored, noAnswer: false, totalMs: 10, hits: [] },
      { error: 'timeout', noAnswer: false, hits: [] },
    ],
    2,
  );
  assert.equal(result.evidenceRecallAt2, 0.25);
  assert.equal(result.failedCount, 1);
});
