#!/usr/bin/env node
// 单库扩充实验的离线报告；从保存的 Chunk ID 标签和逐题记录重新核算，不调用模型。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadDataset, readJson, hash } from './project-eval-lib.mjs';
import { scoreSingle, summarizeSingle } from './single-kb-eval-lib.mjs';

const dir = resolve(
  process.argv[2] || 'reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128',
);
const data = await loadDataset();
const report = await readJson(resolve(dir, 'dev-comparison.json'));
const binding = await readJson(resolve(dir, 'binding.json'));
const questions = data.questions.filter((q) => q.split === 'dev');
const keys = new Set();
if (
  !report.complete ||
  report.phase !== 'dev' ||
  report.expectedQuestions !== questions.length ||
  report.reports.length !== 9 ||
  report.processedRecords !== questions.length * 9 ||
  report.settings.datasetSignature !== data.signature ||
  binding.datasetSignature !== data.signature ||
  report.settings.bindingHash !==
    hash(await readFile(resolve(dir, 'binding.json')))
)
  throw new Error('Incomplete/changed single-KB report');
for (const config of report.reports) {
  const key = `${config.mode}:${config.topK}`;
  if (
    keys.has(key) ||
    !['dense_v2', 'bm25', 'hybrid'].includes(config.mode) ||
    ![3, 5, 10].includes(config.topK) ||
    !config.complete ||
    config.rows.length !== questions.length
  )
    throw new Error('Invalid configuration coverage');
  keys.add(key);
  if (new Set(config.rows.map((r) => r.id)).size !== questions.length)
    throw new Error('Duplicate question');
  for (const row of config.rows) {
    const q = binding.questions.find(
      (q) => q.id === row.id && q.split === 'dev',
    );
    if (
      !q ||
      row.query !== q.query ||
      row.signature !== report.signature ||
      row.mode !== config.mode ||
      row.topK !== config.topK
    )
      throw new Error('Changed question/settings');
    if (!row.error) {
      const actual = scoreSingle(q, row.hits, config.topK);
      for (const field of [
        'recall',
        'precision',
        'evidenceRecall',
        'allEvidenceFound',
        'firstRelevantRank',
      ])
        if (row[field] !== actual[field])
          throw new Error(`Score mismatch: ${row.id} ${field}`);
    }
  }
  if (
    JSON.stringify(config.metrics) !==
    JSON.stringify(summarizeSingle(config.rows, config.topK))
  )
    throw new Error('Metric summary mismatch');
}
const pct = (x) => (x == null ? '不适用' : `${(x * 100).toFixed(2)}%`);
const get = (mode, k) =>
  report.reports.find((r) => r.mode === mode && r.topK === k);
const k5 = Object.fromEntries(
  ['dense_v2', 'bm25', 'hybrid'].map((mode) => [mode, get(mode, 5).metrics]),
);
const lines = [
  '# 扩充题库的单库检索对比（2026-11-28）',
  '',
  '本轮在当前改动提交为 `94a96d8` 后实施。使用第四步冻结的 7 份项目文档和 107 道有答案题，81 道开发题实际参与评测，26 道保留测试题未运行。旧步骤一仅 24 道有答案开发题、两份文档、16 个分块，本轮为 81 道、7 份文档、29 个分块。',
  '',
  '## 实现与控制条件',
  '',
  `新建独立评测租户和单个知识库 **${binding.kb.name}**，把 7 份文档放进同一个 Collection；Embedding 为 BAAI/bge-m3，分块大小 1000、重叠 200，共 ${binding.chunkCount} 块。`,
  '',
  '固定相同语料、题目、标签和分块，调用项目真实 RagService.search，分别传 dense_v2、bm25、hybrid，运行 Top3/5/10；每组 81 题，共 729 条记录。不调用 rag_retrieval、不经过跨库合并或全局 Reranker、不生成回答、不调用 LLM 评审。不能把跨库重排的收益混入单库 Hybrid 结果。',
  '',
  '题库中的 source 与 quote 先独立匹配实际分块，保存逐题 relevantChunkIds 及 evidenceGroups。对应记录在 binding.json 的 questions 中；标签建立不读取检索排名。一个必要证据组可有多个重叠 Chunk，任意一个命中即可覆盖该组。',
  '',
  '## 九组实测结果',
  '',
  '| 模式 | TopK | Hit | Chunk Recall | Precision | MRR | 证据组 Recall | 完整证据覆盖 | P95（ms） | 失败 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...report.reports.map((r) => {
    const k = r.topK,
      m = r.metrics;
    return `| ${r.mode} | ${k} | ${pct(m[`hitAt${k}`])} | ${pct(m[`recallAt${k}`])} | ${pct(m[`precisionAt${k}`])} | ${m[`mrrAt${k}`].toFixed(4)} | ${pct(m[`evidenceRecallAt${k}`])} | ${pct(m[`allEvidenceAt${k}`])} | ${m.p95TotalMs} | ${m.failedCount} |`;
  }),
  '',
  'Chunk Recall、Precision、MRR 沿用步骤一公式：以预先标注相关 Chunk ID 为真值，Precision 分母为 K。证据组 Recall 是必要证据组覆盖比例；完整证据覆盖要求全部必要组都命中。各指标按题宏平均，失败记零，不从分母排除。没有无答案题，相应指标为 null，不解释为 0% 或 100%。',
  '',
  '## Top5 同题对照',
  '',
  `Dense Chunk Recall@5：${pct(k5.dense_v2.recallAt5)}；BM25：${pct(k5.bm25.recallAt5)}；Hybrid：${pct(k5.hybrid.recallAt5)}。Hybrid 相比 Dense 的变化为 ${((k5.hybrid.recallAt5 - k5.dense_v2.recallAt5) * 100).toFixed(2)} 个百分点。`,
  '',
  `Dense MRR@5：${k5.dense_v2.mrrAt5.toFixed(4)}；BM25：${k5.bm25.mrrAt5.toFixed(4)}；Hybrid：${k5.hybrid.mrrAt5.toFixed(4)}。`,
  '',
  '不可将本轮与旧小题库的百分比直接相减当作算法提升；应使用本表同一题库中各模式的差异。Hybrid 不保证每项指标或每道题都优于单路检索，结论以实际表格为准。',
  '',
  '## Top5 检索变化的样例',
  '',
  ...questions
    .filter((q) => {
      const a = get('dense_v2', 5).rows.find((r) => r.id === q.id),
        b = get('hybrid', 5).rows.find((r) => r.id === q.id);
      return (
        a.recall !== b.recall || a.firstRelevantRank !== b.firstRelevantRank
      );
    })
    .slice(0, 12)
    .map((q) => {
      const a = get('dense_v2', 5).rows.find((r) => r.id === q.id),
        b = get('hybrid', 5).rows.find((r) => r.id === q.id);
      return `- ${q.id}：${q.query}；Dense Recall=${pct(a.recall)}、首个相关排名=${a.firstRelevantRank ?? '未命中'}；Hybrid Recall=${pct(b.recall)}、首个相关排名=${b.firstRelevantRank ?? '未命中'}。`;
    }),
  '',
  '## 文件地图',
  '',
  '| 文件 | 作用 |',
  '| --- | --- |',
  '| [数据集说明](../../../../datasets/rag/project-docs/v1/README.md) | 原文、题库、划分和审核状态 |',
  '| [执行入口](../../../../scripts/rag/single-kb-eval.mjs) | 创建独立单库、验证语料、运行三种模式与三个 TopK |',
  '| [绑定与评分逻辑](../../../../scripts/rag/single-kb-eval-lib.mjs) | 从原文生成逐题 Chunk ID 映射，保留证据组指标，复用步骤一统计公式 |',
  '| [测试](../../../../scripts/rag/single-kb-eval-lib.test.mjs) | 校验重复分块、来源、证据缺失、失败分母与 TopK 截断 |',
  '| [本文生成脚本](../../../../scripts/rag/single-kb-report.mjs) | 离线核验全部逐题分数及汇总，生成本报告 |',
  '| [binding.json](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/binding.json) | 实际单库、Chunk、指纹，questions[].relevantChunkIds 与 evidenceGroups |',
  '| [settings.json](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/settings.json) | 模型、Milvus 版本、语料和源码签名 |',
  '| [九组汇总](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/dev-comparison.json) | reports[].metrics、逐题命中片段与证据覆盖 |',
  '',
  '单组报告命名为 dev-dense_v2-k5.json 等；单题文件为 dense_v2-k5-project-XXX.json 等。reports/rag-baseline 被 Git 忽略，原始 JSON 需另行保存；本 Markdown 可随代码追踪。',
  '',
  '## 复现',
  '',
  '```powershell',
  '# prepare 只在新目录执行一次；已存在 binding 时拒绝覆盖',
  'node --env-file=.env scripts/rag/single-kb-eval.mjs prepare dev',
  'node --env-file=.env scripts/rag/single-kb-eval.mjs compare dev',
  'node scripts/rag/single-kb-report.mjs',
  'node --test scripts/rag/single-kb-eval-lib.test.mjs scripts/rag/eval-metrics.test.mjs',
  '```',
  '',
  'compare 支持 pilot/dev/test，默认 dev；本轮未调用 test。已有同签名成功记录可以复用；不同配置应使用新输出目录保存历史。prepare 中断后保留部分绑定，避免盲目重复建库。',
  '',
  '## 限制与验证',
  '',
  '虽然题量增大到 81 道有答案开发题，文档仍仅 7 份、29 块，属于有限规模的项目文档评测，不代表生产准确率。参考答案和证据由 Agent 编写并核对原文，未独立人工审核；严格来源和逐字引文可能漏标其他等价来源，本轮不按结果追改标签。Chunk Recall 也会受重叠分块数量影响，应结合证据组指标解读。',
  '',
  '本轮只测试原生单库检索，不测试 PDF 解析、跨库重排、最终回答、拒答、并发负载或费用。顺序检索 P95 不是生产 SLA。原第一至四步的知识库、数据和报告没有覆盖。相关 7 项本地测试通过，全部已保存逐题分数已离线复算校验。',
  '',
];
await writeFile('docs/rag-evaluation/results/step1-single-kb/expanded.md', lines.join('\n'));
console.log(
  JSON.stringify(
    {
      report: 'docs/rag-evaluation/results/step1-single-kb/expanded.md',
      records: report.processedRecords,
      top5: k5,
    },
    null,
    2,
  ),
);
