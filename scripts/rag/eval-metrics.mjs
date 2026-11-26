export function scoreRetrieval(question, hits, topK) {
  const relevant = new Set(question.relevantChunkIds.map(String));
  const returned = [...new Set(hits.slice(0, topK).map((hit) => String(hit.id)))];
  const matched = returned.filter((id) => relevant.has(id));
  return {
    firstRelevantRank: hits.slice(0, topK).findIndex((hit) => relevant.has(String(hit.id))) + 1 || null,
    recall: !question.noAnswer && relevant.size ? matched.length / relevant.size : 0,
    precision: !question.noAnswer ? matched.length / topK : 0,
    allEvidenceFound: !question.noAnswer && question.evidenceGroups.length > 0
      && question.evidenceGroups.every((group) => group.relevantChunkIds.some((id) => returned.includes(String(id)))),
  };
}

export function summarize(rows, topK) {
  const answerable = rows.filter((row) => !row.noAnswer);
  const negatives = rows.filter((row) => row.noAnswer);
  const average = (items, get) => items.length
    ? Number((items.reduce((sum, row) => sum + get(row), 0) / items.length).toFixed(4)) : null;
  const timings = rows.filter((row) => !row.error).map((row) => row.totalMs).sort((a, b) => a - b);
  return {
    questionCount: rows.length, answerableCount: answerable.length, noAnswerCount: negatives.length,
    failedCount: rows.filter((row) => row.error).length,
    [`hitAt${topK}`]: average(answerable, (row) => !row.error && row.firstRelevantRank ? 1 : 0),
    [`recallAt${topK}`]: average(answerable, (row) => row.error ? 0 : row.recall),
    [`precisionAt${topK}`]: average(answerable, (row) => row.error ? 0 : row.precision),
    [`mrrAt${topK}`]: average(answerable, (row) => !row.error && row.firstRelevantRank ? 1 / row.firstRelevantRank : 0),
    [`allEvidenceAt${topK}`]: average(answerable, (row) => !row.error && row.allEvidenceFound ? 1 : 0),
    noAnswerReturnedResultsRate: average(negatives, (row) => row.hits.length ? 1 : 0),
    p50TotalMs: timings.length ? timings[Math.ceil(timings.length * 0.5) - 1] : null,
    p95TotalMs: timings.length ? timings[Math.ceil(timings.length * 0.95) - 1] : null,
  };
}
