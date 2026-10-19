# RAG 混合检索改造计划

## 1. 目标与边界

本文档规划将现有的 BGE-M3 Dense 向量检索，升级为 **Dense 向量检索 + Milvus 内置 BM25 全文检索 + RRF 排名融合**。目标是保留自然语言语义召回能力，同时改善错误码、接口名、版本号和领域专有词的精确召回。**项目已决定不迁移旧 Milvus 数据：新部署使用全新数据卷，新知识库重新上传文档；旧卷暂时保留，但不作为业务回滚目标。**

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
| `docker-compose.yml` | Milvus Server `v2.3.3` | 新部署改为 2.6.24 与全新数据卷；不把旧卷直接挂到新版容器 |
| `package.json` | `@zilliz/milvus2-sdk-node: ^2.6.0`；当前安装为 `2.6.17` | 可以基于当前 SDK 类型规划，但必须与目标服务端联调 |
| `src/rag/milvus.service.ts` | `id/text/vector/metadata/knowledge_base_id`，`IVF_FLAT + COSINE`，只有 Dense `search()` | 新建包含 analyzer、BM25 Function 与双索引的 Collection Schema；不用旧 Collection 数据 |
| `src/rag/rag.service.ts` | BGE-M3 生成 1024 维向量，按文档切块后写入；搜索只调用 `embedQuery()` + Dense Search | 新知识库写入新版 Schema；保留新版集合内的 Dense Only 作为降级模式 |
| `src/tools/rag-retrieval.tool.ts` | 按租户依次检索所有知识库，直接按 `score` 排序 | 不同知识库、不同检索模式的分数不可直接当作同一量纲比较 |
| `src/entities/knowledge-base.entity.ts` | 只记录 `collectionName`，不维护 Schema 版本字段 | 默认所有有效知识库指向 Milvus 2.6 Hybrid Collection；旧 MySQL 记录需人工核对和重建 |

Milvus 2.5 文档已提供内置 BM25 全文检索；项目目前使用的 Server 2.3.3 不具备这条链路。[Milvus 2.5 全文检索文档](https://milvus.io/docs/v2.5.x/full-text-search.md)

## 3. 实施原则与验收口径

1. **全新部署，不复用旧卷。** 新 Milvus、etcd、MinIO 使用独立命名卷；旧卷暂时保留。应用不区分知识库 Schema 版本，旧 MySQL 记录必须在使用前核对并重建。
2. **先建立可复跑评估集，再宣称收益。** 用新上传的同一批文档比较 Dense Only、BM25 Only 和 Hybrid 的 Recall@5、MRR、精确词召回率、P50/P95。没有数据时只描述“增加混合检索能力”，不写“提升 X%”。
3. **租户和知识库范围由服务端决定。** 继续从 `tenantId + knowledgeBaseId` 查 MySQL，并由服务端拼接/参数化 Milvus 过滤条件；客户端不直接传 Collection 名。
4. **不混排原始分数。** Dense Cosine、BM25 和 RRF 分数含义不同。API 的 `score` 应明确为当前模式的排序分数，并增加 `retrievalMode`；跨知识库汇总另行处理。
5. **每个阶段设通过条件。** 一旦版本、召回质量或延迟不达标，在同一新版 Collection 上切回 Dense Only；不能依赖没有同步数据的旧集合回滚。

## 4. 分步实施

### 步骤 0：盘点环境和建立检索基线

**要做什么**

- 确认新版 Milvus Server 与 SDK 版本、数据卷和依赖服务版本。
- 重新上传一批固定测试文档，整理至少 50 条带标准答案位置的测试问题，分别覆盖同义改写、中文专有名词、中英文混合、错误码、接口路径、数字版本号及无答案问题。为每题标记正确 `knowledgeBaseId` 和 Chunk ID。
- 在同一新版集合上用 Dense Only 跑基线，保存每条问题的命中 Chunk、名次、得分、耗时与错误。记录 Recall@1/5、MRR、P50/P95、Embedding 调用耗时。

**为什么**

混合检索可能提升精确词召回，也可能让常见词噪声进入结果。如果没有基线，无法判断新逻辑改善了什么，或是否以不可接受的延迟换取了小幅收益。

**交付与通过条件**

- 一份固定的评估数据集与可复跑脚本/命令，结果按版本保存。
- 能准确区分“问题没有相关文档”和“相关文档未被召回”。

### 步骤 1：部署全新 Milvus 2.6 实例（不迁移旧数据）

**要做什么**

- 使用固定 Milvus `2.6.24`、etcd `v3.5.25`、MinIO `RELEASE.2024-12-18T13-15-44Z`，先在隔离 Compose 项目与全新卷中完成联调。仓库当前安装的 Node SDK 为 `2.6.17`。
- 正式开发环境也使用**新的** Milvus、etcd、MinIO 卷；不要把旧 `dk-agent_*` 卷挂到新版容器。旧卷暂时不删除，方便发现误判时人工核查。
- 不执行 2.3.3 原地升级、数据导出复制或恢复演练。新知识库从原始文档重新上传。若某些原始文件已丢失，其旧 Milvus Chunk 将不会进入新系统，必须在启用前明确接受这个缺口。
- 盘点 MySQL 的 `knowledge_bases` 记录：旧 `collection_name` 指向的集合在新实例中不存在。决定保留元数据并重建文档，或清理旧知识库记录；**清理 MySQL 记录是独立的数据变更，不在本步骤自动执行**。

**为什么**

放弃旧数据后，不需要走官方针对**保留数据原地升级**的 2.5.16 中间版本路径；但必须使用全新卷，不能仅改镜像标签后让 2.6 容器读取 2.3 的 etcd/MinIO/Milvus 数据。[2.6 升级指南](https://milvus.io/docs/v2.6.x/upgrade_milvus_standalone-docker.md)

**交付与通过条件**

- 隔离 Milvus 2.6.24 已健康运行，并完成含 BM25 Function 的 Collection 创建、插入、Dense Search、BM25 Search、Hybrid Search。2026-10-18 的实际烟测均通过，详见 `docs/rag-hybrid-step1-runbook.md`。
- 正式开发环境的全新卷及 MySQL 旧知识库记录处理方式明确后，才能将应用默认连接切到新实例；旧卷不删除，也不作为自动回滚路径。

### 步骤 2：设计并验证新版 Collection Schema

**要做什么**

新 Collection 至少包含下列字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | `VarChar` 主键 | 新 Chunk 的稳定 ID，便于去重与引用 |
| `text` | `VarChar`，启用 analyzer | 原文、BM25 输入与返回的证据内容 |
| `dense_vector` | `FloatVector(1024)` | BGE-M3 Dense 检索；需与实际模型维度一致 |
| `sparse_vector` | `SparseFloatVector` | BM25 Function 输出；插入时不由应用传值 |
| `metadata` | `JSON` | 来源等现有元数据 |
| `knowledge_base_id` | `VarChar` | 知识库范围过滤；仍需校验租户归属 |

- 创建时在 `text` 开启 analyzer，定义 `text → sparse_vector` 的 BM25 Function。分别给 `dense_vector` 建 `COSINE` 索引、给 `sparse_vector` 建 `SPARSE_INVERTED_INDEX + BM25` 索引，完成后加载 Collection。
- 中文内容先测试目标版本的 `chinese` analyzer。样例必须同时包含中文短语、`RUN_CANCELLED`、`AbortController`、`/chat/runs/:runId` 等技术标识符。若分词导致标识符失真，评估自定义 analyzer、另存关键词字段或查询规范化。
- `collectionName` 直接指向新集合；不增加知识库 Schema 版本字段。旧 MySQL 记录若指向不存在的 Collection，使用前须人工核对并重建。

**为什么**

BM25 Function 与 analyzer 是 Collection Schema 的一部分，旧集合无法仅通过给现有 `vector` 添加索引就获得全文检索能力。中文与英文技术标识符混用时，分词质量直接决定 BM25 召回。[Milvus BM25 Schema](https://milvus.io/docs/v2.5.x/full-text-search.md) · [中文 analyzer 选型](https://milvus.io/docs/zh/v2.6.x/choose-the-right-analyzer-for-your-use-case.md)

**交付与通过条件**

- 对同一条测试 Chunk，插入请求只包含 `text + dense_vector + 其他标量字段`，Milvus 自动生成 BM25 稀疏表示。
- 用原始查询文本进行 BM25 搜索，中文词和精确标识符各有可解释的命中；同一新版 Collection 仍能进行 Dense Only 搜索。

**2026-10-19 验证记录：** `scripts/rag/hybrid-schema-smoke.mjs` 在隔离 Milvus 2.6.24 上以 1024 维和完整字段实测通过：中文“一键中断”、`RUN_CANCELLED`、`AbortController`、`/chat/runs/:runId` 的 BM25 召回，以及知识库过滤和 Dense 查询。`chinese` analyzer 把 `RUN_CANCELLED` 分成 `RUN`/`CANCELLED`，路径分成 `chat`/`runs`/`runId`；当前只验证可召回，**不保证字面完全匹配或同形词不会误召回**，需在步骤 6 评估是否增设专门关键词字段。

复跑命令：`pnpm build` → `docker compose -f docker-compose.rag-hybrid-smoke.yml up -d` → `node scripts/rag/hybrid-schema-smoke.mjs` → `docker compose -f docker-compose.rag-hybrid-smoke.yml down`。最后一步不加 `-v`，保留测试卷。

### 步骤 3：修改新知识库写入路径并重新上传文档

**要做什么**

- 在 `MilvusService` 增加 `createHybridCollection()`、`insertHybridChunks()` 等独立方法，先在测试入口验证，不直接改变旧 `createCollection()` 和 `insert()` 的语义。
- 应用连接新 Milvus 后，新知识库默认创建新版 Collection；写入 `id/text/dense_vector/metadata/knowledge_base_id`，由 Milvus 根据文本生成 `sparse_vector`。
- 从原始文档重新上传到新知识库；明确旧 MySQL 知识库的处理方式，避免列表显示可点开但对应 Collection 缺失。不得在未核对引用关系前直接清空整库 MySQL。
- 核对新知识库的文档数、Chunk 数、向量维度、来源元数据和抽样检索结果。现有系统没有独立的原始文件持久化；若原始文件已丢失，本计划不承诺重建对应内容。

**为什么**

放弃旧 Milvus 数据后不再需要回填、断点续跑或双写，但必须确保新上传的文档真实进入新 Schema，并防止旧 MySQL 元数据指向不存在的 Collection。

**交付与通过条件**

- 新创建的知识库全部使用新版 Schema，插入不传 `sparse_vector`，查询可同时走 Dense 与 BM25。
- 对旧 MySQL 知识库有明确的重建或隔离规则；不存在“记录可见但集合缺失”造成的误导性成功响应。

**当前实现进度：** `docker-compose.yml` 已改用新 Milvus/etcd/MinIO 卷；新建知识库写当前 Hybrid Schema，上传走 `dense_vector + text`。应用不再按 Schema 版本阻断旧 MySQL 记录，也不需要新增版本列；旧记录若仍指向已丢失的 Collection，需人工重建。完整的 MySQL + 应用端到端上传验收仍待运行。

### 步骤 4：实现单库 Dense、BM25、Hybrid 三种检索模式

**要做什么**

- 在新版集合上实现 `searchDenseV2()`、`searchBm25()`、`searchHybrid()`，三者返回统一的结果类型：`id/text/metadata/score/retrievalMode/knowledgeBaseId`。
- `RagService.search()` 先检查 `tenantId + knowledgeBaseId` 归属，再根据开关选择 Dense、BM25 或 Hybrid。对 `query` 长度、`topK` 范围做 Zod 限制，避免过大搜索请求。
- 对同一个新版 Collection，Hybrid 子请求分别传入 `embedQuery(query)` 的 Dense 向量与**原始 query 字符串**。两个子请求采用相同的知识库过滤范围；先取候选 Top N，通过 RRF 排序后在应用层截取最终 Top K。当前安装的 SDK 类型没有在子请求上声明 `limit`，其实现会把顶层 `limit` 继承到各子请求，因此顶层先传候选数。
- 调用接口按当前安装的 SDK `2.6.17` 类型编写：`hybridSearch({ collection_name, data: [{ anns_field, data, ... }], rerank, limit })`。官网其他版本示例有使用 `requests` 的写法，本项目必须以锁定版本的类型定义和集成测试为准。[Node SDK 2.6 hybridSearch API](https://milvus.io/api-reference/node/v2.6.x/Vector/hybridSearch.md)

**接口草图（实际参数以联调为准）**

```ts
import { RRFRanker } from '@zilliz/milvus2-sdk-node';

const candidateK = Math.max(topK, 20);
const response = await client.hybridSearch({
  collection_name: kb.collectionName,
  data: [
    {
      anns_field: 'dense_vector',
      data: denseQueryVector,
      expr: kbFilter,
    },
    {
      anns_field: 'sparse_vector',
      data: query,
      expr: kbFilter,
    },
  ],
  rerank: RRFRanker(60),
  limit: candidateK,
  output_fields: ['id', 'text', 'metadata', 'knowledge_base_id'],
});
const hits = response.results.slice(0, topK);
```

具体 SDK 类型里子请求使用 `expr`，而官方网页对不同版本可能展示 `filter`；实施时以本仓库已安装包的类型和真实查询结果校验过滤确实在**两路召回之前**生效。不要仅依赖融合后的过滤来保证范围。

**交付与通过条件**

- 同一问题能分别得到 Dense、BM25、Hybrid 结果；精确标识符可从 BM25 路径命中。
- 不属于当前租户/知识库的数据在三种模式下均不可见；无结果时返回空数组，错误有可追踪日志。

**当前实现进度：** `MilvusService` 已实现三模式；知识库搜索与流式对话按请求中的 `retrievalMode` 选择，未传时默认 `dense_v2`，不再依赖环境变量。前端两个入口均可选择模式，Agent 工具继承本次对话的选择。输入限制为 1–2048 字符、`topK` 1–20。隔离 Milvus 已验证双路 Hybrid 过滤；仍需 MySQL + 应用端到端验证，以及更多租户/无结果场景测试。

### 步骤 5：处理 Agent 工具的跨知识库结果

**要做什么**

- `rag_retrieval` 仍只列出租户可访问的知识库，但给每个结果补上 `knowledgeBaseId`、`knowledgeBaseName`、`chunkId` 与 `retrievalMode`。
- 当前工具逐库串行搜索且直接按 `score` 排序。改为受控并发查询，并在汇总时避免直接比较不同 Collection 的原始分数。首版可先选择相关知识库，或每库取固定候选后使用应用层的排名融合/配额策略，再做全局去重与截取。
- 工具返回中保留来源和检索模式，便于 Agent 引用和后续排障。混合召回失败时只在明确配置的降级策略下回到**同一新集合**的 Dense Only 路径，并记录降级原因。

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

- 用请求参数选择 `dense_v2 / bm25 / hybrid`，未传时使用服务端默认 Dense。先用非关键知识库试用，再按知识库逐步扩大；正式灰度权限控制尚待设计。
- 观测 `tenantId/knowledgeBaseId/retrievalMode/queryId`（查询文本须按隐私要求处理）、结果数量、零结果率、耗时、错误率、降级次数和索引/Collection 状态。
- 检索异常时先切回**同一新版集合**的 Dense Only；这不会丢失灰度期间写入的新文档。若需要回退 Milvus Server 本身，则需单独设计数据导出与版本兼容路径，不能假设旧 2.3 卷能承载新文档。
- 旧卷清理另开任务，在用户确认无保留价值后执行；本计划不自动删除。

**为什么**

新集合内同时有 Dense 和 BM25 索引，因此检索策略可以从 Hybrid 降级到 Dense，而不依赖已经放弃的旧集合。

**交付与通过条件**

- 单库开关切换与 Dense Only 降级演练成功；切换前后知识库数据量和结果可见性一致。
- 无跨租户结果、无异常升高、性能达到步骤 6 的预算，再扩大范围。

## 5. 建议的代码改动清单

| 文件/模块 | 计划改动 |
| --- | --- |
| `docker-compose.yml` | 已改默认部署为 Milvus 2.6.24 及全新卷；不挂载旧 Milvus/etcd/MinIO 卷 |
| `src/rag/milvus.service.ts` | 新版 Schema、双索引、BM25/Hybrid 查询、版本检测与明确的错误处理 |
| `src/rag/rag.service.ts` | 知识库模式选择、写入新版 Collection、三模式搜索及结果归一化 |
| `src/entities/knowledge-base.entity.ts` | 只保留 `collectionName`，不增加 Schema 版本字段或配套 SQL |
| `src/rag/rag.controller.ts`、`src/chat/chat.controller.ts` | 已接收并校验本次请求的检索模式；灰度权限控制尚未实现 |
| `src/tools/rag-retrieval.tool.ts` | 跨知识库召回的并发控制、合并策略、来源字段与降级记录 |
| `src/rag/*.spec.ts`、集成测试 | 已有 Hybrid 创建/写入/无版本字段检索单测和真实 Milvus Schema 烟测；后续补业务端到端与三模式测试 |
| 重新上传与评估数据 | 固定文档集、标注问题集和三模式评估 |

## 6. 必测场景

1. **功能：** 中英文自然语言、错误码、API 路径、版本号、无匹配词、空知识库；Dense/BM25/Hybrid 的返回字段一致。
2. **安全：** 其他租户知识库 ID、伪造过滤条件、非法/极大 `topK`、旧 MySQL 记录指向不存在的集合。
3. **数据：** 重新上传、重复写入、Chunk 主键与文本一致、旧知识库元数据隔离。
4. **可靠性：** Milvus 不可用、BM25 索引未加载、Embedding 失败、Hybrid 查询超时、Dense Only 降级后新增文档仍可见。
5. **性能：** 大知识库、多知识库、并发请求下的 P95 延迟和 Milvus 资源占用。

## 7. 关键决策记录

| 问题 | 本期选择 | 后续再评估 |
| --- | --- | --- |
| 稀疏表示 | Milvus 内置 BM25 | BGE-M3 learned sparse、外部搜索引擎 |
| 融合 | RRF，初始 `k=60` | 有评估集后再试 Weighted Ranker |
| Collection | 沿用每知识库一集合，创建新版集合 | 知识库规模增长后考虑共享集合与租户 Partition Key |
| 旧数据 | 不迁移；新知识库重新上传文档，旧卷暂存不删除 | 完整文档管理、原文件持久化与重建流水线 |
| 二阶段模型重排 | 本期不加入 | Hybrid 质量稳定后再评估 Cross-Encoder Reranker |

## 8. 完成定义

- 新知识库能使用新版 Schema 写入；旧 MySQL 知识库记录已重建或隔离，不会错误指向不存在的 Collection。
- Dense、BM25 和 Hybrid 三模式均通过真实 Milvus 集成测试，中文与技术标识符检索符合评估预期。
- 默认检索模式由评估结果决定，关键质量与延迟指标可复跑、可观测。
- Agent 工具的跨知识库合并不直接比较不同检索分数，租户隔离和来源信息得到验证。

## 9. 参考资料

- [Milvus 2.5 全文检索与 BM25 Function](https://milvus.io/docs/v2.5.x/full-text-search.md)
- [Milvus 2.6 Node SDK hybridSearch API](https://milvus.io/api-reference/node/v2.6.x/Vector/hybridSearch.md)
- [Milvus 2.6 RRF Ranker](https://milvus.io/docs/v2.6.x/rrf-ranker.md)
- [Milvus 2.6 Standalone 升级指南](https://milvus.io/docs/v2.6.x/upgrade_milvus_standalone-docker.md)
- [Milvus 中文分析器选型](https://milvus.io/docs/zh/v2.6.x/choose-the-right-analyzer-for-your-use-case.md)
