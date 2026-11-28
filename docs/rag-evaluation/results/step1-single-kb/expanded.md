# 扩充题库的单库检索对比（2026-11-28）

本轮在当前改动提交为 `94a96d8` 后实施。使用第四步冻结的 7 份项目文档和 107 道有答案题，81 道开发题实际参与评测，26 道保留测试题未运行。旧步骤一仅 24 道有答案开发题、两份文档、16 个分块，本轮为 81 道、7 份文档、29 个分块。

## 实现与控制条件

新建独立评测租户和单个知识库 **RAG 单库扩充评测-3e6bf185**，把 7 份文档放进同一个 Collection；Embedding 为 BAAI/bge-m3，分块大小 1000、重叠 200，共 29 块。

固定相同语料、题目、标签和分块，调用项目真实 RagService.search，分别传 dense_v2、bm25、hybrid，运行 Top3/5/10；每组 81 题，共 729 条记录。不调用 rag_retrieval、不经过跨库合并或全局 Reranker、不生成回答、不调用 LLM 评审。不能把跨库重排的收益混入单库 Hybrid 结果。

题库中的 source 与 quote 先独立匹配实际分块，保存逐题 relevantChunkIds 及 evidenceGroups。对应记录在 binding.json 的 questions 中；标签建立不读取检索排名。一个必要证据组可有多个重叠 Chunk，任意一个命中即可覆盖该组。

## 九组实测结果

| 模式 | TopK | Hit | Chunk Recall | Precision | MRR | 证据组 Recall | 完整证据覆盖 | P95（ms） | 失败 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense_v2 | 3 | 76.54% | 74.69% | 27.98% | 0.6481 | 76.54% | 76.54% | 221.68 | 0 |
| dense_v2 | 5 | 87.65% | 85.80% | 19.26% | 0.6751 | 87.04% | 86.42% | 234.25 | 0 |
| dense_v2 | 10 | 96.30% | 96.30% | 10.99% | 0.6876 | 96.30% | 96.30% | 563.2 | 0 |
| bm25 | 3 | 96.30% | 94.44% | 35.39% | 0.8025 | 95.68% | 95.06% | 12.69 | 0 |
| bm25 | 5 | 97.53% | 97.53% | 22.22% | 0.8056 | 97.53% | 97.53% | 10.73 | 0 |
| bm25 | 10 | 98.77% | 98.77% | 11.23% | 0.8076 | 98.77% | 98.77% | 8.62 | 0 |
| hybrid | 3 | 93.83% | 91.36% | 34.16% | 0.7942 | 92.59% | 91.36% | 236.86 | 0 |
| hybrid | 5 | 96.30% | 96.30% | 21.98% | 0.8004 | 96.30% | 96.30% | 303.21 | 0 |
| hybrid | 10 | 100.00% | 100.00% | 11.36% | 0.8060 | 100.00% | 100.00% | 235.92 | 0 |

Chunk Recall、Precision、MRR 沿用步骤一公式：以预先标注相关 Chunk ID 为真值，Precision 分母为 K。证据组 Recall 是必要证据组覆盖比例；完整证据覆盖要求全部必要组都命中。各指标按题宏平均，失败记零，不从分母排除。没有无答案题，相应指标为 null，不解释为 0% 或 100%。

## Top5 同题对照

Dense Chunk Recall@5：85.80%；BM25：97.53%；Hybrid：96.30%。Hybrid 相比 Dense 的变化为 10.50 个百分点。

Dense MRR@5：0.6751；BM25：0.8056；Hybrid：0.8004。

不可将本轮与旧小题库的百分比直接相减当作算法提升；应使用本表同一题库中各模式的差异。Hybrid 不保证每项指标或每道题都优于单路检索，结论以实际表格为准。

## Top5 检索变化的样例

- project-005：工具调用的四段式事件顺序是什么？；Dense Recall=0.00%、首个相关排名=未命中；Hybrid Recall=100.00%、首个相关排名=4。
- project-010：web_search 使用哪个搜索服务？；Dense Recall=100.00%、首个相关排名=3；Hybrid Recall=100.00%、首个相关排名=2。
- project-013：什么时候自动摘要早期对话？；Dense Recall=0.00%、首个相关排名=未命中；Hybrid Recall=100.00%、首个相关排名=2。
- project-014：会话消息用什么缓存以减少数据库查询？；Dense Recall=0.00%、首个相关排名=未命中；Hybrid Recall=100.00%、首个相关排名=2。
- project-015：多租户隔离使用什么认证和守卫？；Dense Recall=100.00%、首个相关排名=2；Hybrid Recall=100.00%、首个相关排名=1。
- project-017：本地开发 MySQL 映射到宿主机的端口是多少？；Dense Recall=100.00%、首个相关排名=3；Hybrid Recall=100.00%、首个相关排名=1。
- project-023：Agent 检索工具允许调用者指定检索模式吗？；Dense Recall=50.00%、首个相关排名=1；Hybrid Recall=100.00%、首个相关排名=1。
- project-029：API 文档规定的基础路径是什么？；Dense Recall=100.00%、首个相关排名=3；Hybrid Recall=100.00%、首个相关排名=1。
- project-036：聊天请求传 workflowId 会进入哪种编排模式？；Dense Recall=100.00%、首个相关排名=3；Hybrid Recall=100.00%、首个相关排名=1。
- project-037：llmOptions.temperature 的允许范围是多少？；Dense Recall=100.00%、首个相关排名=2；Hybrid Recall=100.00%、首个相关排名=1。
- project-040：会话列表按什么顺序返回？；Dense Recall=100.00%、首个相关排名=3；Hybrid Recall=100.00%、首个相关排名=1。
- project-041：查询会话消息使用哪个接口？；Dense Recall=100.00%、首个相关排名=4；Hybrid Recall=100.00%、首个相关排名=3。

## 文件地图

| 文件 | 作用 |
| --- | --- |
| [数据集说明](../../../../datasets/rag/project-docs/v1/README.md) | 原文、题库、划分和审核状态 |
| [执行入口](../../../../scripts/rag/single-kb-eval.mjs) | 创建独立单库、验证语料、运行三种模式与三个 TopK |
| [绑定与评分逻辑](../../../../scripts/rag/single-kb-eval-lib.mjs) | 从原文生成逐题 Chunk ID 映射，保留证据组指标，复用步骤一统计公式 |
| [测试](../../../../scripts/rag/single-kb-eval-lib.test.mjs) | 校验重复分块、来源、证据缺失、失败分母与 TopK 截断 |
| [本文生成脚本](../../../../scripts/rag/single-kb-report.mjs) | 离线核验全部逐题分数及汇总，生成本报告 |
| [binding.json](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/binding.json) | 实际单库、Chunk、指纹，questions[].relevantChunkIds 与 evidenceGroups |
| [settings.json](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/settings.json) | 模型、Milvus 版本、语料和源码签名 |
| [九组汇总](../../../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/dev-comparison.json) | reports[].metrics、逐题命中片段与证据覆盖 |

单组报告命名为 dev-dense_v2-k5.json 等；单题文件为 dense_v2-k5-project-XXX.json 等。reports/rag-baseline 被 Git 忽略，原始 JSON 需另行保存；本 Markdown 可随代码追踪。

## 复现

```powershell
# prepare 只在新目录执行一次；已存在 binding 时拒绝覆盖
node --env-file=.env scripts/rag/single-kb-eval.mjs prepare dev
node --env-file=.env scripts/rag/single-kb-eval.mjs compare dev
node scripts/rag/single-kb-report.mjs
node --test scripts/rag/single-kb-eval-lib.test.mjs scripts/rag/eval-metrics.test.mjs
```

compare 支持 pilot/dev/test，默认 dev；本轮未调用 test。已有同签名成功记录可以复用；不同配置应使用新输出目录保存历史。prepare 中断后保留部分绑定，避免盲目重复建库。

## 限制与验证

虽然题量增大到 81 道有答案开发题，文档仍仅 7 份、29 块，属于有限规模的项目文档评测，不代表生产准确率。参考答案和证据由 Agent 编写并核对原文，未独立人工审核；严格来源和逐字引文可能漏标其他等价来源，本轮不按结果追改标签。Chunk Recall 也会受重叠分块数量影响，应结合证据组指标解读。

本轮只测试原生单库检索，不测试 PDF 解析、跨库重排、最终回答、拒答、并发负载或费用。顺序检索 P95 不是生产 SLA。原第一至四步的知识库、数据和报告没有覆盖。相关 7 项本地测试通过，全部已保存逐题分数已离线复算校验。
