# 第四步：81 道开发题的原合并与全局重排对比

日期：2026-11-28。使用第四步固定题库，7 份项目文档、7 个知识库、29 个分块；未使用步骤三的 7 道合成题，26 道保留测试题未运行。

## 对比方式

原算法为关闭重排后的 rank_interleave（按各库内部名次轮流合并、去重、截取）；重排算法为相同候选池去重后统一 Cross-Encoder 排序再截取。两组唯一记录配置差异为 rerankEnabled。语料指纹、问题、标注、源码、模型、温度、提示词及评分要点均已校验一致。

关闭重排组新跑固定 Top3/5/10 的 243 条检索和 81 条真实 Agent 问答；启用重排组复用第四步已有、配置与源码校验一致的 243 条检索和 81 条问答，两组共 486 条检索、162 条问答。未重建知识库或覆盖原报告。

生成使用 deepseek-chat，temperature=0，评分复用相同模型和固定要点、引文核验与统计公式。两轮为不同时间的单次运行；同一模型名称不保证供应商内部版本相同，生成与评审也存在波动，不能把小幅变化全归因于排序。

## 固定 TopK 检索

以下 Recall 为来源与原文都匹配的标注证据覆盖率，不是按相关 Chunk 数计数的 Recall。

| TopK | 指标 | 原合并 | 全局重排 | 变化 |
| --- | --- | ---: | ---: | ---: |
| 3 | Hit | 40.74% | 95.06% | 54.32 个百分点 |
| 3 | 证据 Recall | 40.12% | 94.44% | 54.32 个百分点 |
| 3 | 完整证据覆盖 | 39.51% | 93.83% | 54.32 个百分点 |
| 5 | Hit | 71.60% | 98.77% | 27.16 个百分点 |
| 5 | 证据 Recall | 70.37% | 97.53% | 27.16 个百分点 |
| 5 | 完整证据覆盖 | 69.14% | 96.30% | 27.16 个百分点 |
| 10 | Hit | 93.83% | 98.77% | 4.94 个百分点 |
| 10 | 证据 Recall | 92.59% | 97.53% | 4.94 个百分点 |
| 10 | 完整证据覆盖 | 91.36% | 96.30% | 4.94 个百分点 |

| TopK | 原合并丢证据场景 | 重排丢证据场景 | 完整证据改善／退步／不变题数 |
| --- | ---: | ---: | ---: |
| 3 | 49 | 5 | 45 / 1 / 35 |
| 5 | 25 | 3 | 22 / 0 / 59 |
| 10 | 7 | 3 | 4 / 0 / 77 |

两组候选集合不同的记录数：0/243（逐题按库、query、候选 ID 与文本校验，忽略返回时序和数值分数）。具体 ID 见 JSON 的 retrieval.differentCandidateSets。

工具审计：原合并实际重排 0/243 次；重排组实际应用 243/243 次。

## Agent 最终回答

Agent 自主决定检索 query、TopK 和调用次数，问答结果不能解释为固定 Top3 的生成成绩。两组均直接执行真实 AgentService/Supervisor/检索/生成，不覆盖 HTTP、鉴权、会话持久化；不开放 web/MCP。

| 指标 | 原合并 | 全局重排 |
| --- | ---: | ---: |
| 有答案核心正确率 | 88.89% | 100.00% |
| 固定要点完整性 | 89.51% | 100.00% |
| 自动忠实度 | 97.59% | 97.91% |
| 回答相关性 | 100.00% | 100.00% |
| 检索调用率 | 100.00% | 100.00% |
| 有答案误拒答率 | 2.47% | 0.00% |
| 运行失败／评分失败 | 0 / 0 | 0 / 0 |
| 评分完成数 | 81/81 | 81/81 |
| 回答 P50／P95（ms） | 3665 / 5251 | 4672 / 5831 |
| 无答案拒答率 | 不适用 | 不适用 |

逐题核心正确性：改善 9、退步 0、不变 72。

真实 Agent 工具调用次数：原合并 110，重排 96；两组的实际参数见逐题 toolExecutions。

核心正确性变化的样例（固定参考答案，最多列出 8 题）：

- project-011：谁决定 Agent 何时调用哪个工具？ 参考答案：由 LLM 自主决定。 原合并 correct=false，重排 correct=true。原合并评审理由：参考答案要求回答“由 LLM 自主决定”，但回答否认知识库中有该机制描述，未覆盖核心要点，构成实质错误，故 correct=false；回答围绕问题展开，relevant=true；未明确以资料不足为由拒答，abstained=false。回答中多数事实陈述可由片段支持，但两处否定性断言无片段依据。
- project-036：聊天请求传 workflowId 会进入哪种编排模式？ 参考答案：DAG 编排模式。 原合并 correct=false，重排 correct=true。原合并评审理由：参考答案为“DAG 编排模式”，回答未给出该结论且明确表示资料不足，属于弃答；唯一评分要点未覆盖，故 correct=false、abstained=true。回答中关于两种模式与 workflowId 字段的陈述有片段支持，但“未记载映射规则”的断言无逐字证据支持。
- project-043：删除会话使用哪个接口？ 参考答案：DELETE /api/v1/chat/conversations/:id。 原合并 correct=false，重排 correct=true。原合并评审理由：回答将删除会话接口表述为 DELETE /api/v1/chat/conversations，缺少参考答案中的 :id 路径参数，未覆盖评分要点，故正确性为 false。其陈述在检索片段中有依据，但片段本身未包含 :id 形式，无法支持参考答案的完整接口。
- project-048：更新工作流使用哪个接口？ 参考答案：PUT /api/v1/workflows/:id。 原合并 correct=false，重排 correct=true。原合并评审理由：回答将更新接口写成 PUT /api/v1/workflows，遗漏了参考答案中的 :id 路径参数，实质错误，故 correct=false；回答直接作答未拒答，relevant=true。
- project-049：更新工作流时字段是否都必须提供？ 参考答案：所有字段均可选。 原合并 correct=false，重排 correct=true。原合并评审理由：参考答案要求回答“所有字段均可选”，但回答明确表示未检索到更新工作流字段规则并拒答，未覆盖该要点，故正确性不成立；其关于创建接口的陈述有检索片段支持。
- project-069：哪些 MCP 配置更新会递增 configVersion？ 参考答案：URL、headers、超时变更。 原合并 correct=false，重排 correct=true。原合并评审理由：回答仅覆盖 URL 变更递增与仅改名不递增，遗漏 headers 和超时变更，未完整回答参考答案要点，且声称「仅明确这两条判定」属无依据的实质错误，故 correct=false。
- project-070：MCP 测试连接后如何释放连接？ 参考答案：一次性连接，用完 close。 原合并 correct=false，重排 correct=true。原合并评审理由：回答正确识别测试连接为一次性连接、不进入连接池，但未给出参考答案的核心操作「用完 close」，反而声明知识库未记载释放 API，导致关键要点缺失，故正确性判为 false。
- project-073：MCP 密文的落库格式是什么？ 参考答案：v<version>:<iv>:<tag>:<cipher>。 原合并 correct=false，重排 correct=true。原合并评审理由：参考答案要求给出密文落库格式 v<version>:<iv>:<tag>:<cipher>，回答未提供该格式并称知识库未说明，故未覆盖要点，correct=false。回答中的加密与字段陈述有检索片段支持，但未回答核心问题。

自动正确率和完整性不是人工验收准确率；忠实度仅在成功评分且有事实陈述的题上取平均。评分模型与生成模型同家族，逐字引文核验会漏算元数据、组合概括等合法证据。

## 文件位置与复现

- 原合并逐题与统计：[reports/rag-baseline/project-step4-v1-no-rerank-20261128](../reports/rag-baseline/project-step4-v1-no-rerank-20261128/)。
- 重排逐题与统计：[reports/rag-baseline/project-step4-v1](../reports/rag-baseline/project-step4-v1/)。
- 对比统计与逐题改善／退步 ID：[comparison.json](../reports/rag-baseline/project-step4-comparison-20261128/comparison.json)。
- [对比脚本](../scripts/rag/project-compare.mjs)：离线检查配置、题目和标签一致性，重新统计并生成本文。
- [对比校验逻辑](../scripts/rag/project-compare-lib.mjs)：拒绝未完成、不同配置、重复或缺少题目的对比。
- [此前的来源与引文复核记录](rag-step4-review.md)：本轮沿用相同标签，没有按结果修改分数。

```powershell
$env:RAG_PROJECT_BINDING='reports/rag-baseline/project-step4-v1/binding.json'
$env:RAG_RERANK_ENABLED='false'
node --env-file=.env scripts/rag/project-eval.mjs retrieval dev reports/rag-baseline/project-step4-v1-no-rerank-20261128
node --env-file=.env scripts/rag/project-eval.mjs answers dev reports/rag-baseline/project-step4-v1-no-rerank-20261128
Remove-Item Env:RAG_PROJECT_BINDING
Remove-Item Env:RAG_RERANK_ENABLED
node scripts/rag/project-compare.mjs
```

本地 reports/rag-baseline 受 Git 忽略；本 Markdown 记录可随代码追踪，原始 JSON 需另行保存。

## 结论范围

可用本轮同题对比替代简历中仅基于步骤三 7 题的跨库数据，但必须注明“81 道有答案开发题”和相应指标口径。此题库不是独立人工审核的生产问答集，7 库共 29 块仍然有限。不能把检索证据覆盖的提升直接表述为回答准确率提升。
