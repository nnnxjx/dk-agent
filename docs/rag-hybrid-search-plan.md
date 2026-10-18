# RAG 混合检索改造计划

## 1. 目标与边界

本文档规划将现有的 BGE-M3 Dense 向量检索，升级为 **Dense 向量检索 + Milvus 内置 BM25 全文检索 + RRF 排名融合**。目标是保留自然语言语义召回能力，同时改善错误码、接口名、版本号和领域专有词的精确召回。

本计划只设计与实施混合检索所必需的变更。Cross-Encoder Reranker、查询改写、共享 Collection 和完整文档管理可在这轮验收后单独推进。本文中的 `Top 20`、`Top 5` 和 `RRF k=60` 是初始实验参数，最终值以离线评估和延迟测试为准。

```text
入库：文档 → 解析/切块 → BGE-M3 Dense 向量 ─┐
                      └→ 原始文本 → BM25 Function ─┤→ 新版 Milvus Collection
查询：问题 → BGE-M3 Dense 向量 → Dense Top N ──┐
          └→ 原始问题文本 → BM25 Top N ────────┤→ RRF → 最终 Top K → Agent
```

Milvus 的 BM25 Function 负责对原文分词、生成稀疏表示并维护检索所需的统计信息；应用端只提交原始文本与 BGE-M3 的 Dense 向量。查询时传入原始问题，Milvus 使用同一分析器处理文本。BM25 稀疏表示与 BGE-M3 自身可能提供的 learned sparse 输出是两种不同路线，本期选择前者。[Milvus 全文检索原理](https://milvus.io/docs/v2.5.x/full-text-search.md)

## 2. 当前实现与改造原因

| 位置 | 当前实现 | 对本次改造的影响 |
| --- | --- | --- |
| `docker-compose.yml` | Milvus Server `v2.3.3` | 原生 BM25 Full Text Search 需要更高版本服务端；只升级 Node SDK 不够 |
| `package.json` | `@zilliz/milvus2-sdk-node: ^2.6.0`；当前安装为 `2.6.17` | 可以基于当前 SDK 类型规划，但必须与目标服务端联调 |
| `src/rag/milvus.service.ts` | `id/text/vector/metadata/knowledge_base_id`，`IVF_FLAT + COSINE`，只有 Dense `search()` | 需要新建包含 analyzer、BM25 Function 与双索引的 Collection；旧 Collection 不原地改造 |
| `src/rag/rag.service.ts` | BGE-M3 生成 1024 维向量，按文档切块后写入；搜索只调用 `embedQuery()` + Dense Search | 写入字段及搜索入口需要兼容新版；保留旧路径供灰度与回滚 |
| `src/tools/rag-retrieval.tool.ts` | 按租户依次检索所有知识库，直接按 `score` 排序 | 不同知识库、不同检索模式的分数不可直接当作同一量纲比较 |
| `src/entities/knowledge-base.entity.ts` | 记录 `collectionName`，没有索引版本/检索模式字段 | 需要能够区分旧 Collection 与新版 Collection，支持逐库切换 |

Milvus 2.5 文档已提供内置 BM25 全文检索；项目目前使用的 Server 2.3.3 不具备这条链路。[Milvus 2.5 全文检索文档](https://milvus.io/docs/v2.5.x/full-text-search.md)

## 3. 实施原则与验收口径

1. **旧集合保留到新链路验收结束。** 新集合使用新名字，例如 `<原collectionName>_hybrid_v2`。不要在切流量前删除旧集合或覆盖原有卷。
2. **先建立基线，再宣称收益。** 记录 Dense Only 的 Recall@5、MRR、精确词召回率、P50/P95 检索延迟，再与 BM25 Only 和 Hybrid 对比。没有数据时只描述“增加混合检索能力”，不写“提升 X%”。
3. **租户和知识库范围由服务端决定。** 继续从 `tenantId + knowledgeBaseId` 查 MySQL，并由服务端拼接/参数化 Milvus 过滤条件；客户端不直接传 Collection 名。
4. **不混排原始分数。** Dense Cosine、BM25 和 RRF 分数含义不同。API 的 `score` 应明确为当前模式的排序分数，并增加 `retrievalMode`；跨知识库汇总另行处理。
5. **每个阶段设通过条件。** 一旦版本、数据完整性、召回质量或延迟不达标，保持旧 Dense 路径可用。

## 4. 分步实施

### 步骤 0：盘点环境和建立检索基线

**要做什么**

- 确认实际运行的 Milvus Server 与 SDK 版本、Collection 数量、每库 Chunk 数量、向量维度、索引状态、数据卷和依赖服务版本。
- 整理至少 50 条带标准答案位置的测试问题，分别覆盖同义改写、中文专有名词、中英文混合、错误码、接口路径、数字版本号及无答案问题。为每题标记正确 `knowledgeBaseId` 和 Chunk ID；旧数据无文档 ID 时先用旧 Milvus 主键。
- 用现有 Dense 路径跑一遍，保存每条问题的命中 Chunk、名次、得分、耗时与错误。记录 Recall@1/5、MRR、P50/P95、Embedding 调用耗时。

**为什么**

混合检索可能提升精确词召回，也可能让常见词噪声进入结果。如果没有基线，无法判断新逻辑改善了什么，或是否以不可接受的延迟换取了小幅收益。

**交付与通过条件**

- 一份固定的评估数据集与可复跑脚本/命令，结果按版本保存。
- 能准确区分“问题没有相关文档”和“相关文档未被召回”。

### 步骤 1：确定 Milvus 升级与迁移路径

**要做什么**

- 在独立测试环境部署支持 BM25 的 Milvus，目标先选与 Node SDK 联调通过的固定 2.6.x 版本，记录完整镜像标签和配套 etcd/MinIO 配置。
- 原有 2.3.3 继续可用。备份 MySQL 知识库记录、Milvus Collection 数据及其 etcd/MinIO 依赖，实际做一次恢复演练。
- 优先采用**新部署 + 数据复制**：在新服务上创建 Hybrid Collection，从旧服务导出 `id/text/vector/metadata/knowledge_base_id` 并写入新 Schema。这样能同时完成服务端迁移与 Schema 改造，且旧服务保留为回滚来源。
- 如果决定原地升级，先按目标版本官方升级文档验证允许的中间版本、依赖和消息队列约束，在测试副本完整演练。不能直接假定 2.3.3 → 2.6.x 只需改 `docker-compose.yml` 镜像标签。

**为什么**

Milvus 官方 2.6 Standalone 升级指南要求先到至少 2.5.16，再升级到其指南对应的 2.6 版本；项目当前是 2.3.3。官方也提供从 2.3.x 读取数据并迁移到新实例的工具，但自动迁移旧 Schema 不会生成本项目所需的 BM25 Function，因此本项目还要执行 Schema 转换。[2.6 升级指南](https://milvus.io/docs/v2.6.x/upgrade_milvus_standalone-docker.md) · [2.3.x 数据迁移指南](https://milvus.io/docs/v2.5.x/from-m2x.md)

**交付与通过条件**

- 测试 Milvus 能创建含 BM25 Function 的 Collection，并分别完成插入、Dense Search、BM25 Search、Hybrid Search。
- 旧实例/卷可独立恢复；版本和依赖升级步骤已在测试环境跑通。

### 步骤 2：设计并验证新版 Collection Schema

**要做什么**

新 Collection 至少包含下列字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | `VarChar` 主键 | 沿用旧 Chunk ID，便于比对与去重 |
| `text` | `VarChar`，启用 analyzer | 原文、BM25 输入与返回的证据内容 |
| `dense_vector` | `FloatVector(1024)` | BGE-M3 Dense 检索；需与实际模型维度一致 |
| `sparse_vector` | `SparseFloatVector` | BM25 Function 输出；插入时不由应用传值 |
| `metadata` | `JSON` | 来源等现有元数据 |
| `knowledge_base_id` | `VarChar` | 知识库范围过滤；仍需校验租户归属 |

- 创建时在 `text` 开启 analyzer，定义 `text → sparse_vector` 的 BM25 Function。分别给 `dense_vector` 建 `COSINE` 索引、给 `sparse_vector` 建 `SPARSE_INVERTED_INDEX + BM25` 索引，完成后加载 Collection。
- 中文内容先测试目标版本的 `chinese` analyzer。样例必须同时包含中文短语、`RUN_CANCELLED`、`AbortController`、`/chat/runs/:runId` 等技术标识符。若分词导致标识符失真，评估自定义 analyzer、另存关键词字段或查询规范化。
- 为每个知识库记录 `collectionSchemaVersion=2`、`hybridCollectionName`、`migrationStatus` 等状态；原有 `collectionName` 保留作为旧路径。若数据库字段改造暂缓，也必须有持久化的映射，不能只靠进程内 Map。

**为什么**

BM25 Function 与 analyzer 是 Collection Schema 的一部分，旧集合无法仅通过给现有 `vector` 添加索引就获得全文检索能力。中文与英文技术标识符混用时，分词质量直接决定 BM25 召回。[Milvus BM25 Schema](https://milvus.io/docs/v2.5.x/full-text-search.md) · [中文 analyzer 选型](https://milvus.io/docs/zh/v2.6.x/choose-the-right-analyzer-for-your-use-case.md)

**交付与通过条件**

- 对同一条测试 Chunk，插入请求只包含 `text + dense_vector + 其他标量字段`，Milvus 自动生成 BM25 稀疏表示。
- 用原始查询文本进行 BM25 搜索，中文词和精确标识符各有可解释的命中；旧 Collection 仍能被 Dense 搜索。

### 步骤 3：修改写入路径并回填旧数据

**要做什么**

- 在 `MilvusService` 增加 `createHybridCollection()`、`insertHybridChunks()` 等独立方法；不要直接改变旧 `createCollection()` 和 `insert()` 的语义。
- 新知识库默认创建新版 Collection 的时机由配置开关控制。灰度阶段每个知识库的写入目标由数据库状态决定；尚未迁移的知识库继续写旧集合。
- 从旧 Collection 分页/迭代读取全部 Chunk，保留主键、文本和元数据。若已确认旧数据全部由相同的 BGE-M3 模型和 1024 维配置生成，可复用旧 Dense 向量；若模型来源不确定，则先抽样核验，必要时重新 Embedding。
- 迁移每批记录 `lastId/已处理数/失败数`，支持中断后续跑；按主键幂等写入。迁移期间限制目标知识库上传和删除，或先实现双写与增量补偿，避免快照与切流量间漏数据。
- 逐库比对源/目标行数、ID 集合、文本 Hash、向量维度与抽样检索结果。现有系统没有独立的原始文档实体和文件存储，因此迁移只能依赖旧 Milvus 中的 Chunk 内容，无法凭空恢复原文件、页码或标题层级。

**为什么**

数据迁移与查询切换必须解耦。先回填并验数，再开启新搜索，才能在查询异常时迅速回到旧路径。记录批次游标和幂等 ID 可以避免长任务失败后重头开始或重复写入。

**交付与通过条件**

- 每个待切换知识库的源/目标 Chunk 数和 ID 完全一致；文本与元数据抽样一致。
- 迁移失败的知识库保持旧路径，不标记为 `READY`。

### 步骤 4：实现单库 Dense、BM25、Hybrid 三种检索模式

**要做什么**

- 保留原来的 Dense Search，新增 `searchDenseV2()`、`searchBm25()`、`searchHybrid()`，三者返回统一的结果类型：`id/text/metadata/score/retrievalMode/knowledgeBaseId`。
- `RagService.search()` 先检查 `tenantId + knowledgeBaseId` 归属，再根据知识库状态和开关选择旧 Dense 或新版检索。对 `query` 长度、`topK` 范围做 Zod 限制，避免过大搜索请求。
- 对同一个新版 Collection，Hybrid 子请求分别传入 `embedQuery(query)` 的 Dense 向量与**原始 query 字符串**。两个子请求采用相同的知识库过滤范围；先取候选 Top N，通过 RRF 排序后在应用层截取最终 Top K。当前安装的 SDK 类型没有在子请求上声明 `limit`，其实现会把顶层 `limit` 继承到各子请求，因此顶层先传候选数。
- 调用接口按当前安装的 SDK `2.6.17` 类型编写：`hybridSearch({ collection_name, data: [{ anns_field, data, ... }], rerank, limit })`。官网其他版本示例有使用 `requests` 的写法，本项目必须以锁定版本的类型定义和集成测试为准。[Node SDK 2.6 hybridSearch API](https://milvus.io/api-reference/node/v2.6.x/Vector/hybridSearch.md)

**接口草图（实际参数以联调为准）**

```ts
import { RRFRanker } from '@zilliz/milvus2-sdk-node';

const candidateK = Math.max(topK, 20);
const response = await client.hybridSearch({
  collection_name: kb.hybridCollectionName,
  data: [
    {
      anns_field: 'dense_vector',
      data: denseQueryVector,
      expr: kbFilter,
      params: { metric_type: 'COSINE' },
    },
    {
      anns_field: 'sparse_vector',
      data: query,
      expr: kbFilter,
      params: { metric_type: 'BM25' },
    },
  ],
  rerank: RRFRanker(60),
  limit: candidateK,
  output_fields: ['text', 'metadata', 'knowledge_base_id'],
});
const hits = response.results.slice(0, topK);
```

具体 SDK 类型里子请求使用 `expr`，而官方网页对不同版本可能展示 `filter`；实施时以本仓库已安装包的类型和真实查询结果校验过滤确实在**两路召回之前**生效。不要仅依赖融合后的过滤来保证范围。

**交付与通过条件**

- 同一问题能分别得到 Dense、BM25、Hybrid 结果；精确标识符可从 BM25 路径命中。
- 不属于当前租户/知识库的数据在三种模式下均不可见；无结果时返回空数组，错误有可追踪日志。

### 步骤 5：处理 Agent 工具的跨知识库结果

**要做什么**

- `rag_retrieval` 仍只列出租户可访问的知识库，但给每个结果补上 `knowledgeBaseId`、`knowledgeBaseName`、`chunkId` 与 `retrievalMode`。
- 当前工具逐库串行搜索且直接按 `score` 排序。改为受控并发查询，并在汇总时避免直接比较不同 Collection 的原始分数。首版可先选择相关知识库，或每库取固定候选后使用应用层的排名融合/配额策略，再做全局去重与截取。
- 工具返回中保留来源和检索模式，便于 Agent 引用和后续排障。混合召回失败时只在明确配置的降级策略下回到旧 Dense 路径，并记录降级原因。

**为什么**

Milvus 的单次 Hybrid Search 只在一个 Collection 内融合。如果有多个知识库 Collection，不能把它们各自返回的 BM25/RRF 分数简单排序，当作一次全局搜索。串行调用还会随着知识库数量增加而拉长响应时间。

**交付与通过条件**

- 多知识库问题能够命中目标库，结果不会因不同分数量纲而明显偏向某个库。
- 租户隔离与 Agent 的现有 `rag_retrieval` 调用方式保持兼容。

### 步骤 6：离线评估与参数选择

**要做什么**

- 对步骤 0 的同一问题集跑 Dense Only、BM25 Only、Hybrid RRF。默认从每路 Top 20、最终 Top 5、`RRF k=60` 开始，再测试候选规模、RRF 参数与 analyzer 配置。
- 指标至少包括 Recall@1/5、MRR、精确词问题命中率、无答案问题误召回率、P50/P95 延迟。区分 Embedding 耗时、Milvus 搜索耗时和 Agent 总耗时。
- 人工复核若干典型错误：中文分词错误、错误码被切断、重复 Chunk 霸榜、同义词仅 Dense 命中、BM25 常见词噪声。
- 预先写下项目验收目标，再对比数据。建议底线是 Hybrid 的总体 Recall@5 不低于 Dense 基线、精确词子集有可验证改善，P95 不超过项目可接受的对话延迟预算。具体数值由基线确定，不在计划里虚构。

**为什么**

RRF 解决的是两路排名融合，不等于 Cross-Encoder 语义重排；它也不能保证所有问题都改善。评估集可以明确哪些查询受益、哪些退化，并让参数调整有依据。[Milvus RRF 说明](https://milvus.io/docs/v2.6.x/rrf-ranker.md)

**交付与通过条件**

- 保存三模式逐题结果与聚合报告，包括退化案例和已知限制。
- 若达不到预设目标，保持 Dense 默认模式，针对分词、切块或候选数修正后再评估。

### 步骤 7：灰度发布、观测与回滚

**要做什么**

- 用配置开关控制 `dense_legacy / dense_v2 / bm25 / hybrid`，先选一个非关键知识库灰度，再按知识库逐步扩大。
- 观测 `tenantId/knowledgeBaseId/retrievalMode/queryId`（查询文本须按隐私要求处理）、结果数量、零结果率、耗时、错误率、降级次数和索引/Collection 状态。
- 回滚时只切回旧 Dense Collection 和旧检索模式；保留新集合供排查。若灰度期间允许写入新版集合，回滚前必须确认旧集合也获得这些增量；否则先做双写或补偿，避免回滚后新文档“消失”。
- 待所有库稳定并完成数据核验后，另开清理任务删除旧资源。删除前确认备份、保留期及恢复演练；本计划不执行删除。

**为什么**

查询代码回退很快，但数据路径若只写新版，回滚到旧集合会出现数据缺口。因此写入路径和回滚路径必须一起设计。

**交付与通过条件**

- 单库开关切换与回滚演练成功；切换前后知识库数据量和结果可见性一致。
- 无跨租户结果、无异常升高、性能达到步骤 6 的预算，再扩大范围。

## 5. 建议的代码改动清单

| 文件/模块 | 计划改动 |
| --- | --- |
| `docker-compose.yml` | 测试环境版本升级与依赖配置；生产/本地迁移方案确认后再改默认部署 |
| `src/rag/milvus.service.ts` | 新版 Schema、双索引、BM25/Hybrid 查询、版本检测与明确的错误处理 |
| `src/rag/rag.service.ts` | 知识库模式选择、写入新版 Collection、三模式搜索及结果归一化 |
| `src/entities/knowledge-base.entity.ts` | 新集合名、Schema 版本和迁移状态持久化；配套数据库迁移 |
| `src/rag/rag.controller.ts` | `topK`/模式参数校验；只对授权的测试或管理入口开放调试模式 |
| `src/tools/rag-retrieval.tool.ts` | 跨知识库召回的并发控制、合并策略、来源字段与降级记录 |
| `src/rag/*.spec.ts`、集成测试 | Mock 验证模式选择与租户过滤；真实 Milvus 验证 BM25 Function、中文分词、写入/查询/迁移 |
| 迁移脚本与评估数据 | 分批回填、断点续跑、源目标数据核验和三模式评估 |

## 6. 必测场景

1. **功能：** 中英文自然语言、错误码、API 路径、版本号、无匹配词、空知识库；Dense/BM25/Hybrid 的返回字段一致。
2. **安全：** 其他租户知识库 ID、伪造过滤条件、非法/极大 `topK`、知识库删除或迁移中查询。
3. **数据：** 迁移中断续跑、重复写入、旧/新主键与文本一致、同一知识库上传与迁移并发。
4. **可靠性：** Milvus 不可用、BM25 索引未加载、Embedding 失败、Hybrid 查询超时、回滚后新增文档仍可见。
5. **性能：** 大知识库、多知识库、并发请求下的 P95 延迟和 Milvus 资源占用。

## 7. 关键决策记录

| 问题 | 本期选择 | 后续再评估 |
| --- | --- | --- |
| 稀疏表示 | Milvus 内置 BM25 | BGE-M3 learned sparse、外部搜索引擎 |
| 融合 | RRF，初始 `k=60` | 有评估集后再试 Weighted Ranker |
| Collection | 沿用每知识库一集合，创建新版集合 | 知识库规模增长后考虑共享集合与租户 Partition Key |
| 迁移 | 保留旧集合，新集合回填并逐库切换 | 完整文档管理、原文件持久化与重建流水线 |
| 二阶段模型重排 | 本期不加入 | Hybrid 质量稳定后再评估 Cross-Encoder Reranker |

## 8. 完成定义

- 已有知识库完成可核验的新版回填，新知识库能使用新版 Schema 写入；旧数据和回滚路径在保留期内可用。
- Dense、BM25 和 Hybrid 三模式均通过真实 Milvus 集成测试，中文与技术标识符检索符合评估预期。
- 默认检索模式由评估结果决定，关键质量与延迟指标可复跑、可观测。
- Agent 工具的跨知识库合并不直接比较不同检索分数，租户隔离和来源信息得到验证。

## 9. 参考资料

- [Milvus 2.5 全文检索与 BM25 Function](https://milvus.io/docs/v2.5.x/full-text-search.md)
- [Milvus 2.6 Node SDK hybridSearch API](https://milvus.io/api-reference/node/v2.6.x/Vector/hybridSearch.md)
- [Milvus 2.6 RRF Ranker](https://milvus.io/docs/v2.6.x/rrf-ranker.md)
- [Milvus 2.3.x 数据迁移指南](https://milvus.io/docs/v2.5.x/from-m2x.md)
- [Milvus 2.6 Standalone 升级指南](https://milvus.io/docs/v2.6.x/upgrade_milvus_standalone-docker.md)
- [Milvus 中文分析器选型](https://milvus.io/docs/zh/v2.6.x/choose-the-right-analyzer-for-your-use-case.md)
