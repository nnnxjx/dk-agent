# RAG 评测文档总入口


本目录集中保存评测计划、标注指南与可读结果；原始运行产物在 `reports/rag-baseline/`，固定数据集在 `datasets/rag/`。

## 文档与数据入口

| 入口 | 作用 |
| --- | --- |
| [四步评测计划](plan.md) | 评测目标、步骤、验收与历史实施记录；本次整体移动，暂不拆历史章节 |
| [标注方法与模板](guides/baseline-labeling.md) | 原文、Chunk 标签和指标口径，配套模板在同目录 |
| [人工评测实操指南](guides/manual-evaluation.md) | 从原文审核、检索判断到回答正确性／完整性／忠实度，含页面手测流程与人工记录模板 |
| [Hybrid 检索改造计划](guides/hybrid-search-plan.md) | Dense/BM25/RRF 设计与历史部署规划 |
| [Milvus 联调记录](guides/hybrid-step1-runbook.md) | Hybrid 基础设施联调说明 |
| [单库扩充结果](results/step1-single-kb/expanded.md) | 81 题 Dense/BM25/Hybrid 九组对照 |
| [第二步问答入口](results/step2-answer/README.md) | 问答评测历史章节及原始统计 |
| [第三步合成跨库入口](results/step3-cross-kb/README.md) | 7 题实验、原合并与重排、补评分 |
| [扩充题库首轮基线](results/step4-expanded/baseline.md) | 81 题检索和 Agent 问答 |
| [扩充题库两策略对比](results/step4-expanded/comparison.md) | 原合并与全局重排的同题对比 |
| [复核与限制](results/step4-expanded/review.md) | 等价证据来源、引文核验差异 |
| [数据集总入口](../../datasets/rag/README.md) | 三套数据的用途、版本与划分 |

可读报告按评测链路归档：扩充后的单库实验放在第一步；单库与跨库共用的 107 题数据集只保留一份，放在 project-docs/v1。架构、会话流程、MCP 业务文档保留原位置。

2026-11-28 按评测阶段整理。本次移动 15 个目录／文件入口，共 1520 个历史文件，移动前后逐文件 SHA256 一致；未重新检索、生成或评分。

## 目录结构

```text
reports/rag-baseline/
├── step0-inventory/
│   ├── inventory-2026-10-18T15-30-52-382Z.json
│   └── inventory-2026-10-18T15-32-15-010Z.json
├── step1-single-kb/
│   ├── hybrid-v1
│   ├── hybrid-v2
│   ├── retrieval-step1-20261126
│   └── single-kb-expanded-20261128
├── step2-answer/
│   ├── answer-step2-20261126
│   ├── answer-step2-20261126-v2
│   └── answer-step2-rerank-20261127
├── step3-cross-kb/
│   ├── cross-kb-step3-20261127
│   ├── cross-kb-step3-rerank-20261127
│   └── cross-kb-grading-20261127
└── step4-expanded/
    ├── project-step4-v1
    ├── project-step4-v1-no-rerank-20261128
    └── project-step4-comparison-20261128
```

## 每组放什么

| 目录 | 用途 |
| --- | --- |
| [step0-inventory](../../reports/rag-baseline/step0-inventory) | 环境与知识库盘点 |
| [step1-single-kb](../../reports/rag-baseline/step1-single-kb) | 第一步：单库检索；包含扩充后 81 题的单库对照 |
| [step2-answer](../../reports/rag-baseline/step2-answer) | 第二步：端到端问答与重排后的问答回归 |
| [step3-cross-kb](../../reports/rag-baseline/step3-cross-kb) | 第三步：7 题合成跨库场景、重排与补评分 |
| [step4-expanded](../../reports/rag-baseline/step4-expanded) | 第四步：81 题扩充开发集的跨库检索、问答及两策略对比 |

扩充后 81 题的单库实验归入 step1-single-kb，因为测试的是单库检索；使用第四步题库不改变实验所属链路。step4-expanded 中是同一扩充题库的跨库和 Agent 问答结果。各次运行原目录名与日期保持不变。

## 常用报告入口

| 实验 | 统计入口 |
| --- | --- |
| 原步骤一九组对照 | [step1-summary.json](../../reports/rag-baseline/step1-single-kb/retrieval-step1-20261126/step1-summary.json) |
| 扩充后单库九组对照 | [dev-comparison.json](../../reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/dev-comparison.json) |
| 步骤二问答 | [dev-summary.json](../../reports/rag-baseline/step2-answer/answer-step2-20261126-v2/dev-summary.json) |
| 步骤三合成跨库补评分 | [comparison.json](../../reports/rag-baseline/step3-cross-kb/cross-kb-grading-20261127/comparison.json) |
| 扩充题库重排组检索 | [dev-retrieval-summary.json](../../reports/rag-baseline/step4-expanded/project-step4-v1/dev-retrieval-summary.json) |
| 扩充题库重排组问答 | [dev-answers-summary.json](../../reports/rag-baseline/step4-expanded/project-step4-v1/dev-answers-summary.json) |
| 扩充题库两策略对照 | [comparison.json](../../reports/rag-baseline/step4-expanded/project-step4-comparison-20261128/comparison.json) |

## 内容、签名与后续运行

- reports/rag-baseline 继续受 Git 忽略，报告目录移动不等于把原始数据提交到仓库。此索引随代码保存。
- 已同步更新 scripts/rag 中的默认输出／输入路径和文档链接；用户自己设定的 RAG_PROJECT_BINDING、RAG_CROSS_BINDING 或命令行路径需使用新目录。
- 历史 JSON 中的 sourcePath、reportPath 或文件哈希索引可能仍记录当时的旧路径，这是运行溯源信息，未重写；当前文件位置按本索引查找。
- 历史源码签名保留，表示当次运行使用的代码。路径调整改变了脚本内容，未来重新执行评测时，签名检查可能要求重新运行，不应为复用缓存篡改旧签名。离线对比仍按两轮当时的相同设置校验。
- 迁移清单在本地 reports/rag-baseline/layout-migration-20261128.json，仅包含路径映射、文件数和完整性核验结果。

## 81 道开发题与 26 道保留测试题

扩充题库共 107 道有答案题。初版按 familyId 将组合题与相应单项题归为同组，共 91 个事实家族；按初次出现顺序约每 4 组留 1 组作测试，得到 69 个开发家族、22 个测试家族，对应 81/26 道题（约 76%/24%）。81 不是模型要求的固定题量，也不是只挑了通过的题。该划分并非独立人工审定的随机分层抽样，仍需审核隐含语义重叠。

- 开发集：日常比较 Dense/BM25/Hybrid、重排及 TopK，检查失败、修改方案后反复评测。目前单库和跨库对比均用这 81 题。
- 保留测试集：人工审核标注并冻结语料、分块、Embedding、检索／融合／重排参数和生成／评分设置后，用于最终验收。两种待比较配置都要在同一保留集上执行，保存最终报告。
- 本次目录整理没有运行 26 道保留测试题。若查看测试失败后据此调参，它就不再是独立验收依据；应记录其使用并补充新的保留题。
- 当前开发集结果适合表述为“81 道开发题上的对照”，不能称为独立测试集或生产准确率。
