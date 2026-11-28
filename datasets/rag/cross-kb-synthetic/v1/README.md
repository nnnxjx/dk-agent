# 跨知识库评测 v1

全部语料为合成场景，不代表本项目真实网关、参数或操作要求。`fixture.json` 同时保存文档与测试题，准备脚本只将 `knowledgeBases[].documents` 入库，不上传测试题或答案。

## 场景

- 当前测试租户：四个相似但不适用的干扰库、霁云配置库、霁云运维库。
- 另一个测试租户：包含专属隔离标记的知识库。
- 七个场景：单库超时、单库回滚、多库组合、重复文本、部分失败、全部失败、租户隔离。
- 知识库 ID 前缀特意让干扰库排在目标库之前，作为 rank-interleave 的不利排序案例；这不是随机抽样的业务准确率评测。

## 执行

在仓库根目录配置好 MySQL、Milvus、Embedding 与生成模型后运行：

```powershell
node --env-file=.env scripts/rag/cross-kb-eval.mjs prepare
node --env-file=.env scripts/rag/cross-kb-eval.mjs evaluate
```

默认结果目录：`reports/rag-baseline/step3-cross-kb/cross-kb-step3-20261127/`。可通过第三个参数指定新目录。

`prepare` 在新建的独立租户下创建七个测试知识库和实际 Milvus Collection，不修改已有知识库。已存在绑定时拒绝重复创建；如果准备中断，先核对 binding 中已创建的资源，不直接重复初始化。测试资源保留以便复现，不自动删除。

`evaluate` 核对语料指纹，执行 21 次工具评测（七场景 × Top3/5/10）与七次真实 AgentService 问答。故障仅在测试包装层注入，不停止任何实际服务。租户隔离使用真实 MySQL 条件与 RagService 检查，不验证 HTTP 登录。

生成模型只获得问题和实际工具结果，不获得正确答案；答案通过预设关键字和拒答规则初筛，需人工检查语义，未做第二步的 LLM 忠实度评分。命中及证据覆盖下降作为评测发现记录，不强制要求所有 TopK 满分；泄漏、错误故障标记、并发超限等契约检查失败会令进程返回非零状态。

## 结果文件

- `binding.json`：测试租户、实际知识库、片段及语料指纹。
- `retrieval-results.json`：各库候选、最终合并结果、证据丢失定位和工具标记。
- `agent-results.json`：最终回答、实际候选、流式事件及规则检查。
- `summary.json`：TopK 汇总、隔离/去重/失败/并发检查、问答结果。

首轮结果及限制见 [项目评测记录](../../../../docs/rag-evaluation/plan.md)。


## 两算法已保存回答的同口径补评

`grading-rubric.json` 仅用于评分，不入库。执行 `node --env-file=.env scripts/rag/cross-kb-grade.mjs`，读取原算法和重排算法的已保存回答，使用公共 `answer-judge.mjs` 补充正确性、完整性、忠实度和拒答评分。结果默认保存到 `reports/rag-baseline/step3-cross-kb/cross-kb-grading-20261127/`，其中 `comparison.json` 为统计汇总、`summary.md` 为可读表格，逐题文件保留原始及引文校验后的判断。该命令不重新生成回答。
