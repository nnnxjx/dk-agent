#!/usr/bin/env node
// 离线汇总同题同配置的两种合并算法，不联网、不重新评审、不改写原报告。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadDataset, readJson, writeJson, hash } from './project-eval-lib.mjs';
import { compareReports } from './project-compare-lib.mjs';

const [
  baselinePath = 'reports/rag-baseline/project-step4-v1-no-rerank-20261128',
  rerankPath = 'reports/rag-baseline/project-step4-v1',
  outPath = 'reports/rag-baseline/project-step4-comparison-20261128',
] = process.argv.slice(2);
const data = await loadDataset();
const questions = data.questions.filter((q) => q.split === 'dev');
const summaries = {};
let answerRows;
const sourceHashes = {};
for (const kind of ['retrieval', 'answers']) {
  const paths = [
    resolve(baselinePath, `dev-${kind}-summary.json`),
    resolve(rerankPath, `dev-${kind}-summary.json`),
  ];
  const [a, b] = await Promise.all(paths.map(readJson));
  if (
    a.settings.datasetSignature !== data.signature ||
    b.settings.datasetSignature !== data.signature
  )
    throw new Error('Current dataset changed');
  for (const path of paths) sourceHashes[path] = hash(await readFile(path));
  summaries[kind] = compareReports(a, b, kind, questions);
  if (kind === 'answers') answerRows = { baseline: a.rows, rerank: b.rows };
}
const result = {
  generatedAt: new Date().toISOString(),
  scope:
    '81 answerable development questions; 7 repository docs; fixed source-and-quote evidence labels; no step-3 synthetic questions; 26 held-out questions not run',
  baselinePath,
  rerankPath,
  datasetSignature: data.signature,
  sourceHashes,
  ...summaries,
};
await writeJson(resolve(outPath, 'comparison.json'), result);
const pct = (x) => (x == null ? '不适用' : `${(x * 100).toFixed(2)}%`);
const pp = (a, b) => `${((b - a) * 100).toFixed(2)} 个百分点`;
const r = summaries.retrieval,
  g = summaries.answers;
const lines = [
  '# 第四步：81 道开发题的原合并与全局重排对比',
  '',
  '日期：2026-11-28。使用第四步固定题库，7 份项目文档、7 个知识库、29 个分块；未使用步骤三的 7 道合成题，26 道保留测试题未运行。',
  '',
  '## 对比方式',
  '',
  '原算法为关闭重排后的 rank_interleave（按各库内部名次轮流合并、去重、截取）；重排算法为相同候选池去重后统一 Cross-Encoder 排序再截取。两组唯一记录配置差异为 rerankEnabled。语料指纹、问题、标注、源码、模型、温度、提示词及评分要点均已校验一致。',
  '',
  '关闭重排组新跑固定 Top3/5/10 的 243 条检索和 81 条真实 Agent 问答；启用重排组复用第四步已有、配置与源码校验一致的 243 条检索和 81 条问答，两组共 486 条检索、162 条问答。未重建知识库或覆盖原报告。',
  '',
  '生成使用 deepseek-chat，temperature=0，评分复用相同模型和固定要点、引文核验与统计公式。两轮为不同时间的单次运行；同一模型名称不保证供应商内部版本相同，生成与评审也存在波动，不能把小幅变化全归因于排序。',
  '',
  '## 固定 TopK 检索',
  '',
  '以下 Recall 为来源与原文都匹配的标注证据覆盖率，不是按相关 Chunk 数计数的 Recall。',
  '',
  '| TopK | 指标 | 原合并 | 全局重排 | 变化 |',
  '| --- | --- | ---: | ---: | ---: |',
  ...Object.entries(r.byTopK).flatMap(([k, v]) =>
    [
      ['Hit', 'hitRate'],
      ['证据 Recall', 'evidenceRecall'],
      ['完整证据覆盖', 'completeEvidenceRate'],
    ].map(
      ([label, key]) =>
        `| ${k} | ${label} | ${pct(v.baseline[key])} | ${pct(v.rerank[key])} | ${pp(v.baseline[key], v.rerank[key])} |`,
    ),
  ),
  '',
  '| TopK | 原合并丢证据场景 | 重排丢证据场景 | 完整证据改善／退步／不变题数 |',
  '| --- | ---: | ---: | ---: |',
  ...Object.entries(r.byTopK).map(
    ([k, v]) =>
      `| ${k} | ${v.baseline.mergeLostCases.length} | ${v.rerank.mergeLostCases.length} | ${v.pairedCompleteEvidence.improved.length} / ${v.pairedCompleteEvidence.regressed.length} / ${v.pairedCompleteEvidence.unchanged.length} |`,
  ),
  '',
  `两组候选集合不同的记录数：${r.differentCandidateSets.length}/243（逐题按库、query、候选 ID 与文本校验，忽略返回时序和数值分数）。具体 ID 见 JSON 的 retrieval.differentCandidateSets。`,
  '',
  `工具审计：原合并实际重排 ${r.toolAudit.baseline.rerankApplied}/${r.toolAudit.baseline.toolCalls} 次；重排组实际应用 ${r.toolAudit.rerank.rerankApplied}/${r.toolAudit.rerank.toolCalls} 次。`,
  '',
  '## Agent 最终回答',
  '',
  'Agent 自主决定检索 query、TopK 和调用次数，问答结果不能解释为固定 Top3 的生成成绩。两组均直接执行真实 AgentService/Supervisor/检索/生成，不覆盖 HTTP、鉴权、会话持久化；不开放 web/MCP。',
  '',
  '| 指标 | 原合并 | 全局重排 |',
  '| --- | ---: | ---: |',
  ...Object.entries({
    有答案核心正确率: 'answerableCorrectRate',
    固定要点完整性: 'answerableCompleteness',
    自动忠实度: 'faithfulnessOnJudgedNonemptyClaims',
    回答相关性: 'responseRelevancyRate',
    检索调用率: 'retrievalCallRate',
    有答案误拒答率: 'answerableFalseAbstentionRate',
  }).map(
    ([label, key]) =>
      `| ${label} | ${pct(g.baseline[key])} | ${pct(g.rerank[key])} |`,
  ),
  `| 运行失败／评分失败 | ${g.baseline.failedCount} / ${g.baseline.judgeFailedCount} | ${g.rerank.failedCount} / ${g.rerank.judgeFailedCount} |`,
  `| 评分完成数 | ${g.baseline.judgedCount}/81 | ${g.rerank.judgedCount}/81 |`,
  `| 回答 P50／P95（ms） | ${g.baseline.p50TotalMs} / ${g.baseline.p95TotalMs} | ${g.rerank.p50TotalMs} / ${g.rerank.p95TotalMs} |`,
  '| 无答案拒答率 | 不适用 | 不适用 |',
  '',
  `逐题核心正确性：改善 ${g.pairedCorrectness.improved.length}、退步 ${g.pairedCorrectness.regressed.length}、不变 ${g.pairedCorrectness.unchanged.length}。`,
  '',
  `真实 Agent 工具调用次数：原合并 ${g.toolAudit.baseline.toolCalls}，重排 ${g.toolAudit.rerank.toolCalls}；两组的实际参数见逐题 toolExecutions。`,
  '',
  '核心正确性变化的样例（固定参考答案，最多列出 8 题）：',
  '',
  ...[...g.pairedCorrectness.improved, ...g.pairedCorrectness.regressed]
    .slice(0, 8)
    .map((id) => {
      const before = answerRows.baseline.find((row) => row.id === id);
      const after = answerRows.rerank.find((row) => row.id === id);
      const question = questions.find((q) => q.id === id);
      return `- ${id}：${question.query} 参考答案：${question.expectedAnswer} 原合并 correct=${before.judgment?.correct}，重排 correct=${after.judgment?.correct}。原合并评审理由：${before.judgment?.reason || before.error || before.judgeError}`;
    }),
  '',
  '自动正确率和完整性不是人工验收准确率；忠实度仅在成功评分且有事实陈述的题上取平均。评分模型与生成模型同家族，逐字引文核验会漏算元数据、组合概括等合法证据。',
  '',
  '## 文件位置与复现',
  '',
  `- 原合并逐题与统计：[${baselinePath}](../${baselinePath}/)。`,
  `- 重排逐题与统计：[${rerankPath}](../${rerankPath}/)。`,
  `- 对比统计与逐题改善／退步 ID：[comparison.json](../${outPath}/comparison.json)。`,
  '- [对比脚本](../scripts/rag/project-compare.mjs)：离线检查配置、题目和标签一致性，重新统计并生成本文。',
  '- [对比校验逻辑](../scripts/rag/project-compare-lib.mjs)：拒绝未完成、不同配置、重复或缺少题目的对比。',
  '- [此前的来源与引文复核记录](rag-step4-review.md)：本轮沿用相同标签，没有按结果修改分数。',
  '',
  '```powershell',
  "$env:RAG_PROJECT_BINDING='reports/rag-baseline/project-step4-v1/binding.json'",
  "$env:RAG_RERANK_ENABLED='false'",
  `node --env-file=.env scripts/rag/project-eval.mjs retrieval dev ${baselinePath}`,
  `node --env-file=.env scripts/rag/project-eval.mjs answers dev ${baselinePath}`,
  'Remove-Item Env:RAG_PROJECT_BINDING',
  'Remove-Item Env:RAG_RERANK_ENABLED',
  'node scripts/rag/project-compare.mjs',
  '```',
  '',
  '本地 reports/rag-baseline 受 Git 忽略；本 Markdown 记录可随代码追踪，原始 JSON 需另行保存。',
  '',
  '## 结论范围',
  '',
  '可用本轮同题对比替代简历中仅基于步骤三 7 题的跨库数据，但必须注明“81 道有答案开发题”和相应指标口径。此题库不是独立人工审核的生产问答集，7 库共 29 块仍然有限。不能把检索证据覆盖的提升直接表述为回答准确率提升。',
  '',
];
await writeFile('docs/rag-step4-comparison.md', lines.join('\n'));
console.log(
  JSON.stringify(
    {
      report: 'docs/rag-step4-comparison.md',
      json: resolve(outPath, 'comparison.json'),
      candidateSetDifferences: r.differentCandidateSets.length,
      retrieval: Object.fromEntries(
        Object.entries(r.byTopK).map(([k, v]) => [
          k,
          {
            baseline: v.baseline.completeEvidenceRate,
            rerank: v.rerank.completeEvidenceRate,
          },
        ]),
      ),
      answers: { baseline: g.baseline, rerank: g.rerank },
    },
    null,
    2,
  ),
);
