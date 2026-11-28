import { isDeepStrictEqual } from 'node:util';
import { hash, retrievalMetrics } from './project-eval-lib.mjs';
import { summarizeAnswers } from './answer-eval-lib.mjs';

const key = (row, kind) =>
  kind === 'retrieval' ? `${row.id}:k${row.topK}` : row.id;

// 禁止把不同语料、模型或未跑完的两轮报告拼成“算法提升”。
export function validatePair(baseline, rerank, kind, questions) {
  for (const [name, report, enabled] of [
    ['baseline', baseline, false],
    ['rerank', rerank, true],
  ]) {
    if (
      !report.complete ||
      report.processedRecordCount !== report.expectedRecordCount ||
      report.rows.length !== report.expectedRecordCount
    )
      throw new Error(`Incomplete ${name} ${kind}`);
    if (
      report.expectedQuestionCount !== questions.length ||
      report.settings.rerankEnabled !== enabled
    )
      throw new Error(`Invalid ${name} scope/rerank flag`);
    if (
      report.signature !== hash(JSON.stringify(report.settings)) ||
      report.rows.some((r) => r.signature !== report.signature)
    )
      throw new Error(`Invalid ${name} configuration signature`);
    const expected =
      kind === 'retrieval'
        ? questions.flatMap((q) => [3, 5, 10].map((k) => `${q.id}:k${k}`))
        : questions.map((q) => q.id);
    const actual = report.rows.map((r) => key(r, kind));
    if (
      new Set(actual).size !== actual.length ||
      !isDeepStrictEqual([...actual].sort(), expected.sort())
    )
      throw new Error(`Invalid ${name} question IDs/TopKs`);
    for (const row of report.rows) {
      const q = questions.find((q) => q.id === row.id);
      if (row.query !== q.query || row.noAnswer !== false)
        throw new Error(`Changed query: ${row.id}`);
      if (
        kind === 'retrieval' &&
        !row.error &&
        !isDeepStrictEqual(
          row.coverage.map(({ source, line, quote }) => ({
            source,
            line,
            quote,
          })),
          q.evidence,
        )
      )
        throw new Error(`Changed evidence: ${row.id}`);
      if (
        kind === 'answers' &&
        row.judgment &&
        !isDeepStrictEqual(
          row.judgment.points.map((p) => p.point).sort(),
          [...q.points].sort(),
        )
      )
        throw new Error(`Changed reference points: ${row.id}`);
    }
  }
  const { rerankEnabled: _a, ...a } = baseline.settings;
  const { rerankEnabled: _b, ...b } = rerank.settings;
  if (!isDeepStrictEqual(a, b))
    throw new Error('Configurations differ beyond rerankEnabled');
}

export function pairedChanges(baselineRows, rerankRows, getScore, kind) {
  const byKey = new Map(rerankRows.map((r) => [key(r, kind), r]));
  const improved = [],
    regressed = [],
    unchanged = [];
  for (const before of baselineRows) {
    const after = byKey.get(key(before, kind));
    if (!after) throw new Error('Missing paired row');
    const delta = getScore(after) - getScore(before);
    (delta > 1e-12 ? improved : delta < -1e-12 ? regressed : unchanged).push(
      key(before, kind),
    );
  }
  return { improved, regressed, unchanged };
}

// 对比实际召回候选集合，而不是只看最终 TopK，辅助识别排序以外的变量。
function candidateFingerprint(row) {
  const candidates = (row.candidates || [])
    .map((c) => ({
      kb: c.knowledgeBaseId,
      query: c.query,
      topK: c.topK,
      mode: c.mode,
      error: c.error || null,
      hits: (c.hits || [])
        .map((h) => ({ id: String(h.id), text: h.text }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.kb.localeCompare(b.kb));
  return hash(JSON.stringify(candidates));
}
function toolAudit(rows, kind) {
  const outputs =
    kind === 'retrieval'
      ? rows.map((r) => r.output).filter(Boolean)
      : rows.flatMap(
          (r) =>
            r.trace?.results.map((x) => x.parsed).filter((x) => x?.reranking) ||
            [],
        );
  return {
    toolCalls: outputs.length,
    rerankApplied: outputs.filter((x) => x.reranking?.applied).length,
    fallbackReasons: Object.fromEntries(
      [
        ...new Set(
          outputs.map(
            (x) =>
              x.reranking?.fallbackReason ||
              (x.reranking ? 'none' : 'missing_ranking_metadata'),
          ),
        ),
      ].map((reason) => [
        reason,
        outputs.filter(
          (x) =>
            (x.reranking?.fallbackReason ||
              (x.reranking ? 'none' : 'missing_ranking_metadata')) === reason,
        ).length,
      ]),
    ),
  };
}
export function compareReports(baseline, rerank, kind, questions) {
  validatePair(baseline, rerank, kind, questions);
  if (kind === 'answers')
    return {
      baseline: summarizeAnswers(baseline.rows),
      rerank: summarizeAnswers(rerank.rows),
      pairedCorrectness: pairedChanges(
        baseline.rows,
        rerank.rows,
        (r) => (!r.error && r.judgment?.correct ? 1 : 0),
        kind,
      ),
      toolAudit: {
        baseline: toolAudit(baseline.rows, kind),
        rerank: toolAudit(rerank.rows, kind),
      },
    };
  const counterpart = new Map(rerank.rows.map((r) => [key(r, kind), r]));
  return {
    byTopK: Object.fromEntries(
      [3, 5, 10].map((k) => {
        const a = baseline.rows.filter((r) => r.topK === k),
          b = rerank.rows.filter((r) => r.topK === k);
        return [
          k,
          {
            baseline: retrievalMetrics(a),
            rerank: retrievalMetrics(b),
            pairedCompleteEvidence: pairedChanges(
              a,
              b,
              (r) => (!r.error && r.completeEvidence ? 1 : 0),
              kind,
            ),
          },
        ];
      }),
    ),
    differentCandidateSets: baseline.rows
      .filter(
        (r) =>
          candidateFingerprint(r) !==
          candidateFingerprint(counterpart.get(key(r, kind))),
      )
      .map((r) => key(r, kind)),
    toolAudit: {
      baseline: toolAudit(baseline.rows, kind),
      rerank: toolAudit(rerank.rows, kind),
    },
  };
}
