# RAG Dense 基线标注与运行说明

本说明配合 [混合检索改造计划](hybrid-search-plan.md) 的步骤 0 使用。旧 Milvus 数据不迁移；先在新版 Schema v2 知识库重新上传固定文档集，再标注问题。`scripts/rag/baseline.mjs` 只读取 MySQL、Milvus 和 Embedding API，不会修改知识库。评估输出包含问题、租户与知识库 ID；盘点默认写入 `reports/rag-baseline/step0-inventory/`，Dense 基线默认写入 `reports/rag-baseline/step1-single-kb/dense-baseline/`，均被 Git 忽略。目录分组与其他报告入口见 [报告目录索引](../README.md)。不要将含敏感内容的报告提交到仓库。

## 1. 启动与盘点

先确保 `.env` 中的 MySQL、Milvus 和 Embedding 配置对应实际运行环境。启动服务后，在仓库根目录执行：

```powershell
node --env-file=.env scripts/rag/baseline.mjs inventory
```

报告记录实际 Milvus 版本、健康状态、Collection 数量、每个 Collection 的字段/维度/索引/Chunk 数，以及 MySQL 中的知识库映射。脚本同时记录 `docker-compose.yml` 的声明版本，以便检查“配置版本”与“运行版本”是否一致。某个服务不可用时仍会写出报告，并以非零状态结束。

## 2. 标注真实问题

将 `docs/rag-evaluation/guides/baseline.template.jsonl` 复制为本地数据集，例如 `datasets/rag-baseline.jsonl`。模板行带 `"labelStatus":"todo"`，仅提示问题类别，不会进入评估。每行应填入真实知识库中的问题和标签：

```json
{"id":"error-code-01","category":"错误码","tenantId":"真实租户 UUID","knowledgeBaseId":"真实知识库 UUID","query":"RUN_CANCELLED 在何时发送？","relevantChunkIds":["真实 Milvus Chunk ID"],"noAnswer":false}
{"id":"no-answer-01","category":"无答案","tenantId":"真实租户 UUID","knowledgeBaseId":"真实知识库 UUID","query":"此知识库没有回答的问题","relevantChunkIds":[],"noAnswer":true}
```

`relevantChunkIds` 应来自当前知识库中确实能支持答案的 Chunk。一个问题可以标多个正确 Chunk。先核对原文和 Milvus 主键，再记录标签；不要把检索系统现有的 TopK 直接当作真值，否则漏召回无法被发现。无答案问题应由人工确认该知识库确无相关依据。

建议至少标注 50 条，覆盖同义改写、中文领域术语、中英文混合、错误码、接口路径、版本号和无答案问题；每类保留数条。正式比较 Dense、BM25 和 Hybrid 时使用同一份固定数据集。

验证格式与标注进度：

```powershell
node --env-file=.env scripts/rag/baseline.mjs validate --dataset datasets/rag-baseline.jsonl
```

## 3. 跑新版 Dense 基线

```powershell
node --env-file=.env scripts/rag/baseline.mjs evaluate --dataset datasets/rag-baseline.jsonl --top-k 5
```

脚本以 BGE-M3 查询向量搜索当前集合的 `dense_vector`，带 `knowledge_base_id` 过滤条件，并显式返回 `id`；默认标注的知识库都已在 Milvus 2.6 重建并重新上传文档。记录每题返回的 Chunk ID、排序、分数、Embedding 耗时、Milvus 耗时及错误，并计算：

- Recall@1、Recall@K：有答案问题中，正确 Chunk 在前 1/K 条出现的比例；失败问题按未命中计入分母。
- MRR@K：每道有答案题的首个正确 Chunk 名次倒数的平均值，未命中记 0。
- 无答案有结果率：无答案问题中仍返回 Chunk 的比例。当前 Dense 检索没有相关性阈值，此项不能直接解释为“答案幻觉率”，只用于后续对比。
- P50/P95：成功请求的总耗时、Embedding 耗时及 Milvus 检索耗时，不包括 MySQL 查询、Agent 推理或网络到浏览器的耗时。

如果某题标注错误或服务调用失败，逐题报告会保留错误信息。指标必须连同 `failedCount` 一起看；存在失败时不要用该次结果判断新方案优劣。

## 4. 完成步骤 0 的条件

- 实际 Milvus、MySQL、Collection、索引和维度盘点成功。
- 至少 50 条真实问题通过 `validate`，有答案题附带正确 Chunk ID，无答案题经人工确认。
- `evaluate` 无调用失败，并保存逐题结果与汇总指标。后续三种模式使用相同数据集和 TopK 对比。
