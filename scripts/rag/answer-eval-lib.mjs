export class SSEDecoder {
  constructor(onEvent) { this.buffer = ''; this.onEvent = onEvent; this.done = false; }
  push(text) {
    this.buffer += text;
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { this.done = true; continue; }
      if (data) this.onEvent(JSON.parse(data));
    }
  }
  finish() { if (this.buffer.trim()) throw new Error('Truncated SSE frame'); if (!this.done) throw new Error('Missing SSE DONE'); }
}

export function extractTrace(events) {
  const messages = new Map(); const calls = new Map(); const results = [];
  for (const event of events) {
    if (event.type === 'TEXT_MESSAGE_START') messages.set(event.messageId, { role: event.role, content: '' });
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      if (!messages.has(event.messageId)) throw new Error('Text delta without message start');
      messages.get(event.messageId).content += event.delta;
    }
    if (event.type === 'TOOL_CALL_START') calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolCallName, args: '' });
    if (event.type === 'TOOL_CALL_ARGS' && calls.has(event.toolCallId)) calls.get(event.toolCallId).args += event.delta;
    if (event.type === 'TOOL_CALL_RESULT') {
      let parsed; try { parsed = JSON.parse(event.content); } catch { parsed = null; }
      results.push({ toolCallId: event.toolCallId, content: event.content, parsed });
    }
  }
  const errors = events.filter((e) => ['RUN_ERROR', 'RUN_CANCELLED'].includes(e.type));
  const answers = [...messages.values()].filter((m) => m.role === 'assistant' && m.content.trim());
  return {
    answer: answers.at(-1)?.content || '', messages: [...messages.values()], calls: [...calls.values()], results,
    routes: events.filter((e) => e.type === 'STEP_STARTED').map((e) => e.stepName),
    contexts: results.flatMap((r) => r.parsed?.results || []),
    completed: events.some((e) => e.type === 'RUN_FINISHED') && !errors.length, errors,
  };
}

export function summarizeAnswers(rows) {
  const positives = rows.filter((r) => !r.noAnswer); const negatives = rows.filter((r) => r.noAnswer);
  const judged = rows.filter((r) => r.judgment && !r.error);
  const mean = (items, value) => items.length ? Number((items.reduce((s, r) => s + value(r), 0) / items.length).toFixed(4)) : null;
  const measured = (items, value) => mean(items, (r) => r.error || !r.judgment ? 0 : value(r.judgment));
  const latencies = rows.filter((r) => !r.error).map((r) => r.totalMs).sort((a, b) => a - b);
  return {
    questionCount: rows.length, failedCount: rows.filter((r) => r.error).length,
    judgedCount: judged.length, judgeFailedCount: rows.filter((r) => r.judgeError).length,
    retrievalCallRate: mean(rows, (r) => r.trace?.calls.some((c) => c.name === 'rag_retrieval') ? 1 : 0),
    responseRelevancyRate: measured(rows, (j) => j.relevant ? 1 : 0),
    answerableCorrectRate: measured(positives, (j) => j.correct ? 1 : 0),
    answerableCompleteness: measured(positives, (j) => j.points.filter((p) => p.covered).length / j.points.length),
    noAnswerAbstentionRate: measured(negatives, (j) => j.abstained && j.correct ? 1 : 0),
    answerableFalseAbstentionRate: judged.filter((r) => !r.noAnswer).length
      ? mean(judged.filter((r) => !r.noAnswer), (r) => r.judgment.abstained ? 1 : 0) : null,
    faithfulnessOnJudgedNonemptyClaims: mean(judged.filter((r) => r.judgment.claims.length), (r) => r.judgment.claims.filter((c) => c.supported).length / r.judgment.claims.length),
    p50TotalMs: latencies.length ? latencies[Math.ceil(latencies.length * .5) - 1] : null,
    p95TotalMs: latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null,
    note: 'LLM judge estimates, pending human review. Quality denominators include all selected answerable/no-answer questions; unjudged or failed rows score zero. False abstention and faithfulness use judged subsets only. Token/cost unavailable for generation.',
  };
}

// Ignore Markdown presentation only; retain all words/numbers for evidence verification.
export function evidenceMatches(contexts, evidence) {
  const normalize = (text) => String(text).replace(/[`*_>|]/g, '').replace(/\s+/g, '');
  const quote = normalize(evidence);
  return !!quote && contexts.some((context) => normalize(context.text || '').includes(quote));
}
