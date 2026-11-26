import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEDecoder, extractTrace, summarizeAnswers, evidenceMatches } from './answer-eval-lib.mjs';
test('SSE accepts fragmented CRLF and keeps tool contexts separate from final text', () => {
  const events = []; const decoder = new SSEDecoder((e) => events.push(e));
  const input = [
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '答案' },
    { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'rag_retrieval' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"query":"q"}' },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'other', content: '{"results":[{"text":"证据"}]}' },
    { type: 'RUN_FINISHED' },
  ].map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  for (const char of input) decoder.push(char);
  decoder.finish(); const trace = extractTrace(events);
  assert.equal(trace.answer, '答案'); assert.equal(trace.contexts[0].text, '证据');
  assert.equal(trace.calls[0].args, '{"query":"q"}'); assert.equal(trace.completed, true);
});
test('truncated streams and run errors cannot count as completed', () => {
  assert.throws(() => new SSEDecoder(() => {}).finish(), /DONE/);
  assert.equal(extractTrace([{ type: 'RUN_FINISHED' }, { type: 'RUN_ERROR' }]).completed, false);
});
test('aggregate reports failures and missing judgments without inflating quality', () => {
  const j = { correct: true, abstained: false, points: [{ covered: true }], claims: [{ supported: true }] };
  const m = summarizeAnswers([{ noAnswer: false, judgment: j, totalMs: 10 }, { noAnswer: false, error: 'timeout' }, { noAnswer: true, judgment: { ...j, abstained: true }, totalMs: 20 }]);
  assert.equal(m.answerableCorrectRate, .5); assert.equal(m.noAnswerAbstentionRate, 1); assert.equal(m.failedCount, 1);
});

test('evidence matching tolerates Markdown without accepting invented facts', () => {
  const contexts = [{ text: '| `POST /upload` | 最多 10 个 |' }];
  assert.equal(evidenceMatches(contexts, 'POST /upload | 最多 10 个'), true);
  assert.equal(evidenceMatches(contexts, '最多 20 个'), false);
  assert.equal(evidenceMatches(contexts, ''), false);
});
