import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRetrieval, summarize } from './eval-metrics.mjs';

const question = {
  noAnswer: false, relevantChunkIds: ['a', 'b', 'c'],
  evidenceGroups: [{ relevantChunkIds: ['a', 'b'] }, { relevantChunkIds: ['c'] }],
};
test('distinguishes any hit, chunk recall, precision and complete evidence', () => {
  const score = scoreRetrieval(question, [{ id: 'noise' }, { id: 'a' }, { id: 'b' }], 5);
  assert.equal(score.firstRelevantRank, 2);
  assert.equal(score.recall, 2 / 3);
  assert.equal(score.precision, 2 / 5);
  assert.equal(score.allEvidenceFound, false);
  assert.equal(scoreRetrieval(question, [{ id: 'a' }, { id: 'c' }], 5).allEvidenceFound, true);
});
test('deduplicates IDs and truncates to K', () => {
  const score = scoreRetrieval(question, [{ id: 'a' }, { id: 'a' }, { id: 'c' }], 2);
  assert.equal(score.precision, 1 / 2);
  assert.equal(score.recall, 1 / 3);
});
test('failures count as zero; negatives are excluded from answerable averages', () => {
  const score = scoreRetrieval(question, [{ id: 'a' }, { id: 'c' }], 5);
  const metrics = summarize([
    { ...score, noAnswer: false, hits: [], totalMs: 10 },
    { noAnswer: false, error: 'failed', hits: [], totalMs: 100 },
    { noAnswer: true, hits: [{ id: 'noise' }], totalMs: 20 },
  ], 5);
  assert.equal(metrics.hitAt5, 0.5);
  assert.equal(metrics.recallAt5, 0.3333);
  assert.equal(metrics.precisionAt5, 0.2);
  assert.equal(metrics.failedCount, 1);
  assert.equal(metrics.noAnswerReturnedResultsRate, 1);
  assert.equal(metrics.p95TotalMs, 20);
  assert.equal(summarize([], 3).recallAt3, null);
});
