# 第四步：真实项目文档问答集（仅有答案）

本轮根据用户要求只设置有答案题，衡量“有依据时能否检索并正确回答”。不设置无答案题，不评估无答案拒答率。`noAnswerAbstentionRate=null` 表示不适用，不能解释成 0% 或 100%。

## 数据与边界

- 107 题：81 道开发题、26 道保留测试题；99 道单项问题、8 道组合问题。保留测试集尚不运行。
- 7 份仓库真实文档冻结快照，分别入 7 个独立评测库；分块大小 1000、重叠 200，总计 29 块。
- 来源为项目概览、API、MCP 工具适配、配置管理、连接池、前端管理和授权。没有使用架构旧图或未实施的中断计划作为当前行为真值。
- 题目回答的是这些文档的内容，不意味着已测试对应业务 API 的真实运行行为。文档中的配置、示例和约束也不自动代表生产部署状态。
- 问题、参考答案、原文引用、评分要点由本轮 Agent 编写并检查原文；尚未经过独立人工审核，不宣称是人工金标准。每题 `evidence.line` 为快照行号，`quote` 为逐字原文。
- 组合题与对应单项题用 `familyId` 归组，同一组不跨开发／测试集。此规则针对显式分组，不保证消除了全部隐含语义重叠；正式验收前仍需人工审核题库。
- 107 题共 91 个事实家族，初版按首次出现顺序约每 4 个家族留 1 个作测试：69 个开发家族共 81 题，22 个测试家族共 26 题，约 76%/24%。这不是按成绩挑题，也不是必须采用 81 题的固定要求；初版未做独立人工审定的随机分层抽样。
- 开发集用于比较方案、分析失败和调参。保留测试集在标注审核、语料与模型、分块及检索／重排／评分配置冻结后执行最终验收，两种待比较方案使用相同保留题。若查看测试结果后据此调参，应另补新的保留测试题。
- 本轮增加的是 Markdown 项目资料，并未覆盖 PDF 解析、复杂表格、旧版本冲突或用户真实问答流量；107 题、29 个分块仍属于有限规模的首轮扩充。

## 文件地图

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 语料版本、原仓库提交、源文件路径及 SHA256、题数与划分、标注审核状态 |
| `corpus/*.md` | 7 份冻结原文；唯一允许入库的内容。后续原文变化不会静默更改本轮语料 |
| `questions.jsonl` | 每行一道题：ID、类别、事实家族、问题、参考答案、固定评分要点、原文引用、划分、`noAnswer=false`。禁止入库 |
| `questions.md` | 题库阅读版，方便人工核对问题、答案和证据；由 JSONL 派生，不供执行脚本读取，禁止入库 |
| `../../../../scripts/rag/project-eval-lib.mjs` | 校验原文哈希、证据行号、标签与划分；按来源及引用匹配证据，汇总检索指标 |
| `../../../../scripts/rag/project-eval.mjs` | 校验、创建知识库、真实跨库检索、真实 Agent 作答及自动评分的命令入口 |
| `../../../../scripts/rag/project-eval-lib.test.mjs` | 来源混淆、重复证据、漏证据、失败分母、事实家族划分的回归测试 |
| `../../../../scripts/rag/project-compare.mjs` | 同一开发集上原合并与全局重排的离线对比入口，校验两组配置并生成对比 JSON 和中文报告 |
| `../../../../scripts/rag/project-compare-lib.mjs` | 检查完成度、题目、标注、配置一致性；重算指标、逐题改善／退步及候选集合差异 |
| `../../../../scripts/rag/project-compare-lib.test.mjs` | 防止未完成、错题目或不同配置被错误比较的测试 |
| `../../../../docs/rag-evaluation/results/step4-expanded/baseline.md` | 本轮可读结果、限制和样例复核 |
| `../../../../docs/rag-evaluation/results/step4-expanded/review.md` | 来源严格匹配漏算等价证据、引文核验差异等具体复核记录；不回改本轮分数 |
| `../../../../docs/rag-evaluation/results/step4-expanded/comparison.md` | 2026-11-28 补跑原合并后的同题对比；使用本数据集，不使用步骤三的 7 题 |

本地结果默认位于 `reports/rag-baseline/step4-expanded/project-step4-v1/`，受 Git 忽略，需另行保留：

报告已按步骤归档，原步骤一和扩充单库实验统一放到 `step1-single-kb/`；全部目录与常用统计入口见 [报告目录索引](../../../../docs/rag-evaluation/README.md)。历史 JSON 的分数、内容和签名未修改，原路径字段保留为运行溯源信息。

| 输出文件 | 作用 |
| --- | --- |
| `binding.json` | 实际租户 ID、7 库名称／ID／Collection、实际 Chunk、指纹、数据集绑定。不是题库，也不入库 |
| `settings.json` | 模型、温度、重排开关、提示词、绑定与源码签名、评测覆盖范围 |
| `retrieval-project-XXX-kK.json` | 单题固定 TopK 的最终结果、各库候选、每条证据的覆盖和丢失情况、耗时 |
| `pilot-retrieval-summary.json` / `dev-retrieval-summary.json` | 先导／开发集 Top3/5/10 的汇总及逐题记录 |
| `answers-project-XXX.json` | Agent 事件、最终回答、实际检索片段、工具参数、原始及引文校验后的评分标签 |
| `pilot-answers-summary.json` / `dev-answers-summary.json` | 先导／开发集回答指标与逐题评分 |

## 运行方法

在仓库根目录执行：

```powershell
# 本地验证；无数据库或模型调用。检查全部标签及其分块可匹配性。
node scripts/rag/project-eval.mjs validate

# 只创建独立评测租户的 7 库并上传 corpus，不上传题目和参考答案。
node --env-file=.env scripts/rag/project-eval.mjs prepare pilot

# 先导：普通问题、API、连接池、授权、多处证据，共 5 题。
node --env-file=.env scripts/rag/project-eval.mjs retrieval pilot
node --env-file=.env scripts/rag/project-eval.mjs answers pilot

# 完整开发集：81*3=243 条固定 TopK 检索记录；81 条问答记录。
node --env-file=.env scripts/rag/project-eval.mjs retrieval dev
node --env-file=.env scripts/rag/project-eval.mjs answers dev

# 本地测试
node --test scripts/rag/project-eval-lib.test.mjs scripts/rag/answer-judge.test.mjs scripts/rag/answer-eval-lib.test.mjs scripts/rag/eval-metrics.test.mjs
```

`prepare` 遇到已有绑定会停止，避免重复创建；入库中断时保留部分绑定，需先核对而不是盲目重复准备。开发评测会验证实际知识库的 Chunk 指纹与当前题库签名。成功结果只有在同一签名下才复用；想保留不同配置的结果，请使用新输出目录。

复用相同知识库、对比关闭重排的配置示例：

```powershell
$env:RAG_PROJECT_BINDING='reports/rag-baseline/step4-expanded/project-step4-v1/binding.json'
$env:RAG_RERANK_ENABLED='false'
node --env-file=.env scripts/rag/project-eval.mjs retrieval dev reports/rag-baseline/step4-expanded/project-step4-v1-no-rerank
Remove-Item Env:RAG_PROJECT_BINDING
Remove-Item Env:RAG_RERANK_ENABLED
```

上述命令是复现示例。2026-11-28 补跑原合并的实际输出目录为 `reports/rag-baseline/step4-expanded/project-step4-v1-no-rerank-20261128/`，复用原有 `binding.json`；重排组仍为 `project-step4-v1/`。对比 JSON 输出在 `reports/rag-baseline/step4-expanded/project-step4-comparison-20261128/comparison.json`，可读报告见 `docs/rag-evaluation/results/step4-expanded/comparison.md`。

两组报告完成后运行 `node scripts/rag/project-compare.mjs` 可离线生成对比，脚本拒绝未跑完或配置、题目、固定标签不一致的报告。`RAG_PROJECT_TOPKS` 可显式指定如 `3,5,10`；默认即这三组，对比脚本要求三组齐全。不运行测试集；最终冻结方案并审核标签后才显式指定 `test`。

## 指标解释

### 扩充题库的单库对照（2026-11-28）

此前跨库评测保持原样。另将同一 7 份语料放进单个新知识库，用相同 81 道开发题分别运行 Dense、BM25、Hybrid 的 Top3/5/10，共 729 条检索，不调用全局重排或生成模型，保留测试题未运行。

- 执行脚本：`scripts/rag/single-kb-eval.mjs`，支持 `prepare|compare` 和 `pilot|dev|test`；本轮运行 `prepare dev`、`compare dev`。
- 绑定及统计：`scripts/rag/single-kb-eval-lib.mjs`，将原文证据关联实际 Chunk ID，保留证据组。
- 本地绑定：`reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/binding.json`，包含 `questions[].relevantChunkIds`、`questions[].evidenceGroups`，与已有跨库绑定分开保存。
- 九组统计：`reports/rag-baseline/step1-single-kb/single-kb-expanded-20261128/dev-comparison.json`，看 `reports[].metrics`；每组包含 81 道逐题记录。
- 可读结果与命令：[扩充单库报告](../../../../docs/rag-evaluation/results/step1-single-kb/expanded.md)，由 `scripts/rag/single-kb-report.mjs` 离线复算逐题分数后生成。

单库 Recall/Precision 沿用步骤一按标注 Chunk ID 计数的公式；额外报告证据组 Recall 和完整证据覆盖。不能把单库的 Chunk Recall 与跨库的证据 Recall 混为同一统计口径。

### 跨库检索与问答

检索直接调用真实跨库 Hybrid 工具，固定 query 与 TopK，不让生成模型参与选取 query。

- 每条证据必须同时匹配来源文件与片段中的原文；同文合并时检查 `sources` 中保留的来源。
- Hit：至少覆盖一条标注证据；证据 Recall：覆盖条数／该题标注条数；完整证据命中：覆盖全部。
- 丢失证据：各库实际候选中存在某条证据，最终结果中却缺失；统计有此现象的题目数。
- 按题取平均；运行失败记 0，不从质量分母排除。这是标注证据覆盖口径，不是步骤一按 Chunk 计数的 Recall/Precision。

问答直接调用项目 `AgentService.execute()`，经过真实 Supervisor、工具、Milvus 和模型；Agent 自主决定 query、TopK 和检索次数，结果独立于固定 TopK 评测。不经过 HTTP、鉴权或会话落库，无 web/MCP 工具。只能说明受控 Agent 集成效果，不能视为正式服务端到端验收。

评分复用 `answer-judge.mjs`，固定每题 `points`，不让评审临时增删要点。正确性对照参考答案；完整性为要点覆盖比例；忠实度对照实际返回片段，程序核验逐字引文后计算题均值。所有指标公式由代码统计，LLM 只生成逐题标签。生成与评审使用同模型家族，且引文匹配可能误扣元数据或组合概括，自动结果需要人工复核。忠实度只包含成功评分且有事实陈述的题，报告应同时看评分覆盖数和失败数。

每题保存生成时间，评分耗时不计入回答耗时。评测为顺序请求，检索与回答两类任务可能并行执行，耗时不用于宣称生产 SLA 或独立性能提升。生成 Token／费用未可靠暴露，报告为空。
