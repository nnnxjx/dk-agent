import { basename } from 'node:path';
import { normalize } from './project-eval-lib.mjs';
import { scoreRetrieval, summarize } from './eval-metrics.mjs';

// 标签由冻结原文生成，与任何检索模式的返回排名无关。
export function bindQuestions(questions, chunks, kb) {
  return questions.map((question) => {
    if (question.noAnswer || !question.evidence?.length)
      throw new Error(`Expected answerable evidence: ${question.id}`);
    const evidenceGroups = question.evidence.map((evidence) => {
      const relevantChunkIds = [
        ...new Set(
          chunks
            .filter(
              (chunk) =>
                chunk.metadata?.source === basename(evidence.source) &&
                normalize(chunk.text).includes(normalize(evidence.quote)),
            )
            .map((chunk) => String(chunk.id)),
        ),
      ];
      if (!evidence.quote.trim() || !relevantChunkIds.length)
        throw new Error(`Missing/cross-chunk evidence: ${question.id}`);
      return { ...evidence, knowledgeBaseId: kb.id, relevantChunkIds };
    });
    return {
      ...question,
      knowledgeBaseId: kb.id,
      tenantId: kb.tenantId,
      evidenceGroups,
      relevantChunkIds: [
        ...new Set(evidenceGroups.flatMap((group) => group.relevantChunkIds)),
      ],
    };
  });
}
export function scoreSingle(question, hits, topK) {
  const returned = new Set(hits.slice(0, topK).map((h) => String(h.id)));
  const coverage = question.evidenceGroups.map((group) => ({
    ...group,
    found: group.relevantChunkIds.some((id) => returned.has(id)),
  }));
  return {
    ...scoreRetrieval(question, hits, topK),
    evidenceRecall: coverage.filter((g) => g.found).length / coverage.length,
    coverage,
  };
}
export function summarizeSingle(rows, topK) {
  return {
    ...summarize(rows, topK),
    [`evidenceRecallAt${topK}`]: rows.length
      ? Number(
          (
            rows.reduce((sum, r) => sum + (r.error ? 0 : r.evidenceRecall), 0) /
            rows.length
          ).toFixed(4),
        )
      : null,
  };
}
