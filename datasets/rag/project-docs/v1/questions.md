# 有答案题库阅读版

由 questions.jsonl 生成，便于审核；执行脚本只读取 JSONL。不得上传本文件到被测知识库。测试集展示仅便于审核，不表示已运行评测。

## project-001 · dev · 事实问答

问题：平台支持哪两种 Agent 编排模式？

参考答案：Supervisor 自动路由和 DAG 自定义工作流。

固定评分要点：
- Supervisor 自动路由和 DAG 自定义工作流。

原文证据：
- [corpus/overview.md:3](corpus/overview.md)：支持 Supervisor 自动路由和 DAG 自定义工作流两种模式

## project-002 · dev · 事实问答

问题：Supervisor 模式中 Agent 完成后会回到哪里？

参考答案：回到主管，直到任务结束。

固定评分要点：
- 回到主管，直到任务结束。

原文证据：
- [corpus/overview.md:9](corpus/overview.md)：Agent 完成后回到主管，直到任务结束

## project-003 · dev · 事实问答

问题：DAG 工作流支持哪些节点类型？

参考答案：支持 agent、tool、condition 等节点类型。

固定评分要点：
- 支持 agent、tool、condition 等节点类型。

原文证据：
- [corpus/overview.md:10](corpus/overview.md)：支持 agent、tool、condition 等节点类型，按图执行

## project-004 · test · 事实问答

问题：文本消息的三段式事件顺序是什么？

参考答案：TEXT_MESSAGE_START、TEXT_MESSAGE_CONTENT、TEXT_MESSAGE_END。

固定评分要点：
- TEXT_MESSAGE_START、TEXT_MESSAGE_CONTENT、TEXT_MESSAGE_END。

原文证据：
- [corpus/overview.md:16](corpus/overview.md)：`TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT`(增量) → `TEXT_MESSAGE_END`

## project-005 · dev · 事实问答

问题：工具调用的四段式事件顺序是什么？

参考答案：TOOL_CALL_START、TOOL_CALL_ARGS、TOOL_CALL_END、TOOL_CALL_RESULT。

固定评分要点：
- TOOL_CALL_START、TOOL_CALL_ARGS、TOOL_CALL_END、TOOL_CALL_RESULT。

原文证据：
- [corpus/overview.md:17](corpus/overview.md)：`TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` → `TOOL_CALL_RESULT`

## project-006 · dev · 事实问答

问题：网页内容抓取使用哪个库？

参考答案：cheerio。

固定评分要点：
- cheerio。

原文证据：
- [corpus/overview.md:32](corpus/overview.md)：支持 URL 网页抓取（cheerio）

## project-007 · dev · 事实问答

问题：文档使用哪个分块器？

参考答案：RecursiveCharacterTextSplitter。

固定评分要点：
- RecursiveCharacterTextSplitter。

原文证据：
- [corpus/overview.md:33](corpus/overview.md)：文档分块（RecursiveCharacterTextSplitter）

## project-008 · test · 事实问答

问题：项目的 Embedding 模型及维度是什么？

参考答案：BAAI/bge-m3，1024 维。

固定评分要点：
- BAAI/bge-m3，1024 维。

原文证据：
- [corpus/overview.md:34](corpus/overview.md)：BAAI/bge-m3 Embedding 向量化（1024 维，通过 OpenAI 兼容 API）

## project-009 · dev · 事实问答

问题：一次批量上传最多几个文件？

参考答案：最多 10 个。

固定评分要点：
- 最多 10 个。

原文证据：
- [corpus/overview.md:37](corpus/overview.md)：批量上传（最多 10 个）

## project-010 · dev · 事实问答

问题：web_search 使用哪个搜索服务？

参考答案：Tavily API。

固定评分要点：
- Tavily API。

原文证据：
- [corpus/overview.md:43](corpus/overview.md)：基于 Tavily API 的实时网页搜索

## project-011 · dev · 事实问答

问题：谁决定 Agent 何时调用哪个工具？

参考答案：由 LLM 自主决定。

固定评分要点：
- 由 LLM 自主决定。

原文证据：
- [corpus/overview.md:46](corpus/overview.md)：Agent 由 LLM 自主决定何时调用工具、调用哪个工具。

## project-012 · test · 事实问答

问题：滑动窗口记忆策略保留什么？

参考答案：最近 N 条消息。

固定评分要点：
- 最近 N 条消息。

原文证据：
- [corpus/overview.md:50](corpus/overview.md)：保留最近 N 条消息作为上下文

## project-013 · dev · 事实问答

问题：什么时候自动摘要早期对话？

参考答案：消息超过阈值时。

固定评分要点：
- 消息超过阈值时。

原文证据：
- [corpus/overview.md:51](corpus/overview.md)：消息超过阈值时，自动调 LLM 对早期对话生成摘要

## project-014 · dev · 事实问答

问题：会话消息用什么缓存以减少数据库查询？

参考答案：Redis 缓存。

固定评分要点：
- Redis 缓存。

原文证据：
- [corpus/overview.md:52](corpus/overview.md)：会话消息缓存，减少数据库查询

## project-015 · dev · 事实问答

问题：多租户隔离使用什么认证和守卫？

参考答案：JWT 认证与 TenantGuard，按 tenantId 隔离。

固定评分要点：
- JWT 认证与 TenantGuard，按 tenantId 隔离。

原文证据：
- [corpus/overview.md:56](corpus/overview.md)：JWT 认证 + TenantGuard，所有数据按 tenantId 隔离。

## project-016 · test · 事实问答

问题：Docker 一键启动时应用默认端口是多少？

参考答案：3000。

固定评分要点：
- 3000。

原文证据：
- [corpus/overview.md:121](corpus/overview.md)：应用本身（前后端一体，端口 3000）

## project-017 · dev · 事实问答

问题：本地开发 MySQL 映射到宿主机的端口是多少？

参考答案：3307。

固定评分要点：
- 3307。

原文证据：
- [corpus/overview.md:140](corpus/overview.md)：MYSQL_PORT=3307（docker-compose 映射到宿主机的端口）

## project-018 · dev · 事实问答

问题：本地开发 Redis 映射到宿主机的端口是多少？

参考答案：6380。

固定评分要点：
- 6380。

原文证据：
- [corpus/overview.md:141](corpus/overview.md)：REDIS_PORT=6380（docker-compose 映射到宿主机的端口）

## project-019 · dev · 事实问答

问题：本地开发前端在哪个端口运行，代理什么路径？

参考答案：5173，/api 代理到 localhost:3000。

固定评分要点：
- 5173，/api 代理到 localhost:3000。

原文证据：
- [corpus/overview.md:150](corpus/overview.md)：http://localhost:5173，自动代理 /api → localhost:3000

## project-020 · test · 事实问答

问题：生产环境必须配置哪个 JWT 变量？

参考答案：JWT_SECRET。

固定评分要点：
- JWT_SECRET。

原文证据：
- [corpus/overview.md:157](corpus/overview.md)：`JWT_SECRET` | 生产必填 | JWT 签名密钥

## project-021 · dev · 事实问答

问题：CORS 允许域名的环境变量是什么？

参考答案：CORS_ORIGIN，默认 *。

固定评分要点：
- CORS_ORIGIN，默认 *。

原文证据：
- [corpus/overview.md:165](corpus/overview.md)：`CORS_ORIGIN` | 否 | CORS 允许域名，默认 `*`

## project-022 · dev · 事实问答

问题：知识库搜索 API 不传 retrievalMode 时用哪种模式？

参考答案：dense_v2。

固定评分要点：
- dense_v2。

原文证据：
- [corpus/overview.md:187](corpus/overview.md)：不传时默认 `dense_v2`

## project-023 · dev · 事实问答

问题：Agent 检索工具允许调用者指定检索模式吗？

参考答案：不允许，固定 Hybrid。

固定评分要点：
- 不允许，固定 Hybrid。

原文证据：
- [corpus/overview.md:187](corpus/overview.md)：固定使用 Hybrid，不接受模式参数

## project-024 · dev · 事实问答

问题：跨知识库检索最多并发查询几个库？

参考答案：4 个。

固定评分要点：
- 4 个。

原文证据：
- [corpus/overview.md:189](corpus/overview.md)：Agent 跨知识库检索最多并发查询 4 个知识库

## project-025 · test · 事实问答

问题：当前默认的全局重排模型是什么？

参考答案：BAAI/bge-reranker-v2-m3。

固定评分要点：
- BAAI/bge-reranker-v2-m3。

原文证据：
- [corpus/overview.md:189](corpus/overview.md)：默认模型为 `BAAI/bge-reranker-v2-m3`

## project-026 · test · 事实问答

问题：全局重排使用什么兼容接口？

参考答案：SiliconFlow 兼容的 /rerank 接口。

固定评分要点：
- SiliconFlow 兼容的 /rerank 接口。

原文证据：
- [corpus/overview.md:189](corpus/overview.md)：使用 SiliconFlow 兼容的 `/rerank` 接口

## project-027 · dev · 事实问答

问题：localScore 和 rerankScore 各解释什么？

参考答案：localScore 表示单库排序，rerankScore 表示统一重排分数。

固定评分要点：
- localScore 表示单库排序，rerankScore 表示统一重排分数。

原文证据：
- [corpus/overview.md:189](corpus/overview.md)：`localScore` 只解释单库排序，统一重排分数为 `rerankScore`

## project-028 · dev · 事实问答

问题：跨库检索的重复文本怎样保留来源？

参考答案：重复文本保留全部来源。

固定评分要点：
- 重复文本保留全部来源。

原文证据：
- [corpus/overview.md:189](corpus/overview.md)：重复文本保留全部来源，部分知识库失败单独标记

## project-029 · dev · 精确字段

问题：API 文档规定的基础路径是什么？

参考答案：/api/v1。

固定评分要点：
- /api/v1。

原文证据：
- [corpus/api.md:3](corpus/api.md)：基础路径：`/api/v1`

## project-030 · test · 精确字段

问题：受保护接口需要什么认证请求头？

参考答案：Authorization: Bearer <token>。

固定评分要点：
- Authorization: Bearer <token>。

原文证据：
- [corpus/api.md:4](corpus/api.md)：`Authorization: Bearer <token>`

## project-031 · dev · 精确字段

问题：注册账号调用哪个接口？

参考答案：POST /api/v1/auth/register。

固定评分要点：
- POST /api/v1/auth/register。

原文证据：
- [corpus/api.md:15](corpus/api.md)：POST /api/v1/auth/register

## project-032 · dev · 精确字段

问题：注册密码的最小长度是多少？

参考答案：6 位。

固定评分要点：
- 6 位。

原文证据：
- [corpus/api.md:23](corpus/api.md)：最少 6 位

## project-033 · dev · 精确字段

问题：登录调用哪个接口？

参考答案：POST /api/v1/auth/login。

固定评分要点：
- POST /api/v1/auth/login。

原文证据：
- [corpus/api.md:44](corpus/api.md)：POST /api/v1/auth/login

## project-034 · test · 精确字段

问题：流式聊天的核心请求方法和路径是什么？

参考答案：POST /api/v1/chat/completions。

固定评分要点：
- POST /api/v1/chat/completions。

原文证据：
- [corpus/api.md:63](corpus/api.md)：POST /api/v1/chat/completions

## project-035 · dev · 精确字段

问题：聊天请求不传 conversationId 会怎样？

参考答案：自动创建会话。

固定评分要点：
- 自动创建会话。

原文证据：
- [corpus/api.md:71](corpus/api.md)：会话 ID，不传则自动创建

## project-036 · dev · 精确字段

问题：聊天请求传 workflowId 会进入哪种编排模式？

参考答案：DAG 编排模式。

固定评分要点：
- DAG 编排模式。

原文证据：
- [corpus/api.md:72](corpus/api.md)：工作流 ID，传入则走 DAG 编排模式

## project-037 · dev · 0 到 2。

问题：llmOptions.temperature 的允许范围是多少？

参考答案： 2 |

固定评分要点：
-  2 |

原文证据：
- [corpus/api.md:76](corpus/api.md)：| llmOptions.temperature | number | 否 | 0 

## project-038 · test · 精确字段

问题：流式聊天响应的 Content-Type 是什么？

参考答案：text/event-stream。

固定评分要点：
- text/event-stream。

原文证据：
- [corpus/api.md:78](corpus/api.md)：**响应：** `text/event-stream`，AG-UI 事件流

## project-039 · dev · 精确字段

问题：创建会话调用哪个接口？

参考答案：POST /api/v1/chat/conversations。

固定评分要点：
- POST /api/v1/chat/conversations。

原文证据：
- [corpus/api.md:121](corpus/api.md)：POST /api/v1/chat/conversations

## project-040 · dev · 精确字段

问题：会话列表按什么顺序返回？

参考答案：按更新时间倒序。

固定评分要点：
- 按更新时间倒序。

原文证据：
- [corpus/api.md:139](corpus/api.md)：`Conversation[]`，按更新时间倒序

## project-041 · dev · 精确字段

问题：查询会话消息使用哪个接口？

参考答案：GET /api/v1/chat/conversations/:id/messages。

固定评分要点：
- GET /api/v1/chat/conversations/:id/messages。

原文证据：
- [corpus/api.md:144](corpus/api.md)：GET /api/v1/chat/conversations/:id/messages

## project-042 · test · 精确字段

问题：会话消息列表按什么顺序返回？

参考答案：按创建时间正序。

固定评分要点：
- 按创建时间正序。

原文证据：
- [corpus/api.md:147](corpus/api.md)：`Message[]`，按创建时间正序

## project-043 · dev · 精确字段

问题：删除会话使用哪个接口？

参考答案：DELETE /api/v1/chat/conversations/:id。

固定评分要点：
- DELETE /api/v1/chat/conversations/:id。

原文证据：
- [corpus/api.md:152](corpus/api.md)：DELETE /api/v1/chat/conversations/:id

## project-044 · dev · 精确字段

问题：创建工作流使用哪个接口？

参考答案：POST /api/v1/workflows。

固定评分要点：
- POST /api/v1/workflows。

原文证据：
- [corpus/api.md:164](corpus/api.md)：POST /api/v1/workflows

## project-045 · dev · 精确字段

问题：WorkflowNode 的 type 有哪些可选值？

参考答案：agent、tool、condition、start、end。

固定评分要点：
- agent、tool、condition、start、end。

原文证据：
- [corpus/api.md:182](corpus/api.md)：`agent` / `tool` / `condition` / `start` / `end`

## project-046 · test · 接口字段

问题：WorkflowEdge 的 source 字段表示什么？

参考答案：source 是源节点 ID。

固定评分要点：
- source 是源节点 ID。

原文证据：
- [corpus/api.md:190](corpus/api.md)：| source | string | 源节点 ID |

## project-047 · dev · 精确字段

问题：WorkflowEdge 的 condition 字段表示什么？

参考答案：条件节点的可选匹配关键词。

固定评分要点：
- 条件节点的可选匹配关键词。

原文证据：
- [corpus/api.md:192](corpus/api.md)：可选，条件节点的匹配关键词

## project-048 · dev · 精确字段

问题：更新工作流使用哪个接口？

参考答案：PUT /api/v1/workflows/:id。

固定评分要点：
- PUT /api/v1/workflows/:id。

原文证据：
- [corpus/api.md:226](corpus/api.md)：PUT /api/v1/workflows/:id

## project-049 · dev · 精确字段

问题：更新工作流时字段是否都必须提供？

参考答案：所有字段均可选。

固定评分要点：
- 所有字段均可选。

原文证据：
- [corpus/api.md:229](corpus/api.md)：同创建，所有字段均可选

## project-050 · test · 精确字段

问题：创建知识库使用哪个接口？

参考答案：POST /api/v1/knowledge-bases。

固定评分要点：
- POST /api/v1/knowledge-bases。

原文证据：
- [corpus/api.md:246](corpus/api.md)：POST /api/v1/knowledge-bases

## project-051 · dev · 精确字段

问题：创建知识库时 chunkSize 默认是多少？

参考答案：1000。

固定评分要点：
- 1000。

原文证据：
- [corpus/api.md:255](corpus/api.md)：文档分块大小，默认 1000

## project-052 · dev · 精确字段

问题：创建知识库时 chunkOverlap 默认是多少？

参考答案：200。

固定评分要点：
- 200。

原文证据：
- [corpus/api.md:256](corpus/api.md)：分块重叠大小，默认 200

## project-053 · dev · 精确字段

问题：给知识库添加文本资料的接口是什么？

参考答案：POST /api/v1/knowledge-bases/:id/documents。

固定评分要点：
- POST /api/v1/knowledge-bases/:id/documents。

原文证据：
- [corpus/api.md:267](corpus/api.md)：POST /api/v1/knowledge-bases/:id/documents

## project-054 · dev · 精确字段

问题：添加文档时 documents[].metadata 是否必填？

参考答案：不是必填，是可选对象。

固定评分要点：
- 不是必填，是可选对象。

原文证据：
- [corpus/api.md:276](corpus/api.md)：| documents[].metadata | object | 否 | 元数据 |

## project-055 · test · 精确字段

问题：知识库搜索接口的路径是什么？

参考答案：POST /api/v1/knowledge-bases/:id/search。

固定评分要点：
- POST /api/v1/knowledge-bases/:id/search。

原文证据：
- [corpus/api.md:287](corpus/api.md)：POST /api/v1/knowledge-bases/:id/search

## project-056 · dev · 精确字段

问题：知识库搜索默认返回几条？

参考答案：5 条。

固定评分要点：
- 5 条。

原文证据：
- [corpus/api.md:295](corpus/api.md)：返回条数，默认 5

## project-057 · dev · 精确字段

问题：知识库搜索支持哪些 retrievalMode？

参考答案：dense_v2、bm25、hybrid。

固定评分要点：
- dense_v2、bm25、hybrid。

原文证据：
- [corpus/api.md:296](corpus/api.md)：`dense_v2` / `bm25` / `hybrid`，默认 `dense_v2`

## project-058 · dev · 精确字段

问题：RUN_ERROR 事件有哪些关键字段？

参考答案：message 和可选的 code。

固定评分要点：
- message 和可选的 code。

原文证据：
- [corpus/api.md:322](corpus/api.md)：| `RUN_ERROR` | 运行出错 | message, code? |

## project-059 · test · 精确字段

问题：STEP_STARTED 事件使用什么字段标识步骤？

参考答案：stepName。

固定评分要点：
- stepName。

原文证据：
- [corpus/api.md:323](corpus/api.md)：| `STEP_STARTED` | 步骤/Agent 开始 | stepName |

## project-060 · dev · 精确字段

问题：TEXT_MESSAGE_CONTENT 使用什么字段携带增量文本？

参考答案：delta，另含 messageId。

固定评分要点：
- delta，另含 messageId。

原文证据：
- [corpus/api.md:326](corpus/api.md)：| `TEXT_MESSAGE_CONTENT` | 文本消息增量内容 | messageId, delta |

## project-061 · dev · 精确字段

问题：TOOL_CALL_RESULT 使用哪些关键字段？

参考答案：toolCallId 和 content。

固定评分要点：
- toolCallId 和 content。

原文证据：
- [corpus/api.md:331](corpus/api.md)：| `TOOL_CALL_RESULT` | 工具调用结果 | toolCallId, content |

## project-062 · dev · 精确字段

问题：参数校验失败对应哪个 HTTP 状态码？

参考答案：400。

固定评分要点：
- 400。

原文证据：
- [corpus/api.md:353](corpus/api.md)：| 400 | 参数校验失败（Zod） |

## project-063 · test · 精确字段

问题：未认证或 Token 无效对应哪个状态码？

参考答案：401。

固定评分要点：
- 401。

原文证据：
- [corpus/api.md:354](corpus/api.md)：| 401 | 未认证 / Token 无效 |

## project-064 · dev · 精确字段

问题：租户校验失败对应哪个状态码？

参考答案：403。

固定评分要点：
- 403。

原文证据：
- [corpus/api.md:355](corpus/api.md)：| 403 | 租户校验失败 |

## project-065 · dev · 精确字段

问题：资源不存在对应哪个 HTTP 状态码？

参考答案：404。

固定评分要点：
- 404。

原文证据：
- [corpus/api.md:356](corpus/api.md)：| 404 | 资源不存在 |

## project-066 · dev · 精确字段

问题：邮箱已经注册对应哪个 HTTP 状态码？

参考答案：409。

固定评分要点：
- 409。

原文证据：
- [corpus/api.md:357](corpus/api.md)：| 409 | 邮箱已注册 |

## project-067 · test · 事实问答

问题：MCP Server 的租户与别名如何约束唯一性？

参考答案：tenantId 与 alias 组合唯一。

固定评分要点：
- tenantId 与 alias 组合唯一。

原文证据：
- [corpus/management.md:10](corpus/management.md)：`tenantId + alias` 唯一

## project-068 · dev · 事实问答

问题：MCP 请求头使用什么算法加密落库？

参考答案：AES-256-GCM，存入 headers_encrypted。

固定评分要点：
- AES-256-GCM，存入 headers_encrypted。

原文证据：
- [corpus/management.md:11](corpus/management.md)：AES-256-GCM 加密后存 `headers_encrypted`

## project-069 · dev · 事实问答

问题：哪些 MCP 配置更新会递增 configVersion？

参考答案：URL、headers、超时变更。

固定评分要点：
- URL、headers、超时变更。

原文证据：
- [corpus/management.md:25](corpus/management.md)：URL/headers/超时变更递增 configVersion

## project-070 · dev · 事实问答

问题：MCP 测试连接后如何释放连接？

参考答案：一次性连接，用完 close。

固定评分要点：
- 一次性连接，用完 close。

原文证据：
- [corpus/management.md:27](corpus/management.md)：一次性连接测试，用完 close

## project-071 · test · 事实问答

问题：刷新 MCP 工具时如何处理远端缺失的工具？

参考答案：事务 upsert，缺失工具标记 stale。

固定评分要点：
- 事务 upsert，缺失工具标记 stale。

原文证据：
- [corpus/management.md:28](corpus/management.md)：事务刷新：upsert + 缺失标 stale

## project-072 · dev · 事实问答

问题：MCP 凭据密钥的环境变量及格式是什么？

参考答案：MCP_CREDENTIALS_KEY，64 位十六进制。

固定评分要点：
- MCP_CREDENTIALS_KEY，64 位十六进制。

原文证据：
- [corpus/management.md:38](corpus/management.md)：`MCP_CREDENTIALS_KEY`（64 hex）

## project-073 · dev · 事实问答

问题：MCP 密文的落库格式是什么？

参考答案：v<version>:<iv>:<tag>:<cipher>。

固定评分要点：
- v<version>:<iv>:<tag>:<cipher>。

原文证据：
- [corpus/management.md:39](corpus/management.md)：`v<version>:<iv>:<tag>:<cipher>`

## project-074 · dev · 事实问答

问题：MCP Server 的非本地 URL 有什么协议限制？

参考答案：必须使用 HTTPS。

固定评分要点：
- 必须使用 HTTPS。

原文证据：
- [corpus/management.md:41](corpus/management.md)：非本地强制 https

## project-075 · dev · 事实问答

问题：MCP 连接池缓存键由什么组成？

参考答案：tenantId、serverId、configVersion。

固定评分要点：
- tenantId、serverId、configVersion。

原文证据：
- [corpus/pool.md:9](corpus/pool.md)：`tenantId + serverId + configVersion`

## project-076 · test · 事实问答

问题：并发 acquire 同一 MCP 连接时会重复建连吗？

参考答案：不会，共用 in-flight 建连。

固定评分要点：
- 不会，共用 in-flight 建连。

原文证据：
- [corpus/pool.md:10](corpus/pool.md)：并发 acquire 共用 in-flight 建连，不重复建连

## project-077 · test · 事实问答

问题：MCP 连接 release 时会立即关闭吗？

参考答案：不会，release 只归还；空闲超过 TTL 后由 sweep 关闭。

固定评分要点：
- 不会，release 只归还；空闲超过 TTL 后由 sweep 关闭。

原文证据：
- [corpus/pool.md:11](corpus/pool.md)：release 只归还不关闭；idle 超 TTL 后台 sweep 关闭

## project-078 · dev · 事实问答

问题：MCP test、refresh 和探活使用连接池吗？

参考答案：不使用，走一次性连接。

固定评分要点：
- 不使用，走一次性连接。

原文证据：
- [corpus/pool.md:12](corpus/pool.md)：test/refresh/探活用一次性连接，不走池

## project-079 · dev · 事实问答

问题：池化 callTool 失败时会立即重试本次调用吗？

参考答案：不会，下次调用重建连接。

固定评分要点：
- 不会，下次调用重建连接。

原文证据：
- [corpus/pool.md:13](corpus/pool.md)：下次重建，不重试本次调用

## project-080 · dev · 事实问答

问题：MCP 哪些管理操作会立即失效连接？

参考答案：禁用、删除、更新配置。

固定评分要点：
- 禁用、删除、更新配置。

原文证据：
- [corpus/pool.md:14](corpus/pool.md)：禁用/删除/更新配置时 `invalidateServer` 即刻失效

## project-081 · dev · 事实问答

问题：MCP 健康探测连续失败几次会标为 unhealthy？

参考答案：连续 3 次。

固定评分要点：
- 连续 3 次。

原文证据：
- [corpus/pool.md:22](corpus/pool.md)：连续 3 次失败标 unhealthy 并失效

## project-082 · test · 事实问答

问题：应用销毁时如何清理 MCP 池？

参考答案：onModuleDestroy 关闭全部连接与定时器。

固定评分要点：
- onModuleDestroy 关闭全部连接与定时器。

原文证据：
- [corpus/pool.md:15](corpus/pool.md)：`onModuleDestroy` 关闭全部连接与定时器

## project-083 · dev · 事实问答

问题：MCP 管理页面在哪个前端路径？

参考答案：/mcp。

固定评分要点：
- /mcp。

原文证据：
- [corpus/ui.md:12](corpus/ui.md)：`/mcp` 路由

## project-084 · dev · 事实问答

问题：MCP 前端凭据输入框如何展示？

参考答案：使用 password 输入，不回显。

固定评分要点：
- 使用 password 输入，不回显。

原文证据：
- [corpus/ui.md:10](corpus/ui.md)：Authorization、X-API-Key（password 输入，不回显）

## project-085 · dev · 事实问答

问题：MCP 页面哪些操作需要二次确认？

参考答案：禁用、删除、修改 URL。

固定评分要点：
- 禁用、删除、修改 URL。

原文证据：
- [corpus/ui.md:11](corpus/ui.md)：禁用、删除、修改 URL 有二次确认

## project-086 · dev · 事实问答

问题：MCP 凭据会保存到前端 localStorage 吗？

参考答案：不会，也不记日志。

固定评分要点：
- 不会，也不记日志。

原文证据：
- [corpus/ui.md:18](corpus/ui.md)：前端不存 localStorage、不记日志

## project-087 · test · 事实问答

问题：MCP Agent 授权记录用什么组合约束唯一性？

参考答案：tenantId、agentName、qualifiedName。

固定评分要点：
- tenantId、agentName、qualifiedName。

原文证据：
- [corpus/grants.md:5](corpus/grants.md)：`tenantId + agentName + qualifiedName` 唯一

## project-088 · dev · 事实问答

问题：未建立 grant 的 Agent 默认能用 MCP 工具吗？

参考答案：不能，默认无 MCP 工具。

固定评分要点：
- 不能，默认无 MCP 工具。

原文证据：
- [corpus/grants.md:6](corpus/grants.md)：未建 grant 的 Agent 默认无 MCP 工具

## project-089 · dev · 事实问答

问题：内置 web_search 和 rag_retrieval 受 MCP 白名单约束吗？

参考答案：不受 MCP 授权约束。

固定评分要点：
- 不受 MCP 授权约束。

原文证据：
- [corpus/grants.md:7](corpus/grants.md)：内置工具（`web_search`、`rag_retrieval`）不受授权约束

## project-090 · dev · 事实问答

问题：Server 处于哪些状态时不满足授权条件？

参考答案：disabled 或 unhealthy，且需要启用。

固定评分要点：
- disabled 或 unhealthy，且需要启用。

原文证据：
- [corpus/grants.md:12](corpus/grants.md)：Server 已启用且状态非 `disabled`/`unhealthy`

## project-091 · dev · 事实问答

问题：stale 的 MCP 工具即使有 grant 还能调用吗？

参考答案：不能，要求工具已启用且非 stale。

固定评分要点：
- 不能，要求工具已启用且非 stale。

原文证据：
- [corpus/grants.md:13](corpus/grants.md)：Tool 已启用且非 `stale`

## project-092 · test · 事实问答

问题：MCP 授权在工具调用前由哪个方法二次校验？

参考答案：McpAuthorizationService.checkToolCall。

固定评分要点：
- McpAuthorizationService.checkToolCall。

原文证据：
- [corpus/grants.md:21](corpus/grants.md)：`McpAuthorizationService.checkToolCall` 二次校验

## project-093 · dev · 事实问答

问题：如何查看某个 Agent 的 MCP 授权清单？

参考答案：GET /mcp/agents/:agentName/grants。

固定评分要点：
- GET /mcp/agents/:agentName/grants。

原文证据：
- [corpus/grants.md:26](corpus/grants.md)：`GET /mcp/agents/:agentName/grants`

## project-094 · dev · 事实问答

问题：授权接口是增量追加还是全量替换？

参考答案：全量替换，空数组收回全部。

固定评分要点：
- 全量替换，空数组收回全部。

原文证据：
- [corpus/grants.md:27](corpus/grants.md)：全量替换；空数组收回全部

## project-095 · dev · 事实问答

问题：刷新工具被标记 stale 后授权是否仍然生效？

参考答案：不再生效，检查会拦截。

固定评分要点：
- 不再生效，检查会拦截。

原文证据：
- [corpus/grants.md:38](corpus/grants.md)：`refresh` 标 `stale` 的工具自动失去授权

## project-096 · test · 事实问答

问题：Agent 授权页面默认 Agent 名是什么？

参考答案：researcher。

固定评分要点：
- researcher。

原文证据：
- [corpus/grants.md:31](corpus/grants.md)：默认 `researcher`

## project-097 · dev · 事实问答

问题：MCP 工具的限定名称格式是什么？

参考答案：mcp__<alias>__<tool>，各段小写归一化。

固定评分要点：
- mcp__<alias>__<tool>，各段小写归一化。

原文证据：
- [corpus/adapter.md:10](corpus/adapter.md)：`mcp__<alias>__<tool>`，分段小写归一化

## project-098 · dev · 事实问答

问题：远端 inputSchema 大小上限是多少？

参考答案：32KB。

固定评分要点：
- 32KB。

原文证据：
- [corpus/adapter.md:23](corpus/adapter.md)：大小上限（32KB）

## project-099 · dev · 事实问答

问题：MCP 工具描述超多少字符会截断？

参考答案：2000 字符。

固定评分要点：
- 2000 字符。

原文证据：
- [corpus/adapter.md:29](corpus/adapter.md)：描述超 2000 字符截断并标注

## project-100 · test · 多处证据

问题：项目 Embedding 和全局重排分别使用哪个模型？

参考答案：BAAI/bge-m3，1024 维。 BAAI/bge-reranker-v2-m3。

固定评分要点：
- BAAI/bge-m3，1024 维。
- BAAI/bge-reranker-v2-m3。

原文证据：
- [corpus/overview.md:34](corpus/overview.md)：BAAI/bge-m3 Embedding 向量化（1024 维，通过 OpenAI 兼容 API）
- [corpus/overview.md:189](corpus/overview.md)：默认模型为 `BAAI/bge-reranker-v2-m3`

## project-101 · dev · 多处证据

问题：Agent 知识库检索使用什么模式，跨库查询并发上限是多少？

参考答案：不允许，固定 Hybrid。 4 个。

固定评分要点：
- 不允许，固定 Hybrid。
- 4 个。

原文证据：
- [corpus/overview.md:187](corpus/overview.md)：固定使用 Hybrid，不接受模式参数
- [corpus/overview.md:189](corpus/overview.md)：Agent 跨知识库检索最多并发查询 4 个知识库

## project-102 · dev · 多处证据

问题：知识库默认分块大小和重叠大小分别是多少？

参考答案：1000。 200。

固定评分要点：
- 1000。
- 200。

原文证据：
- [corpus/api.md:255](corpus/api.md)：文档分块大小，默认 1000
- [corpus/api.md:256](corpus/api.md)：分块重叠大小，默认 200

## project-103 · dev · 多处证据

问题：MCP 凭据在后端如何加密，在前端是否持久保存？

参考答案：AES-256-GCM，存入 headers_encrypted。 不会，也不记日志。

固定评分要点：
- AES-256-GCM，存入 headers_encrypted。
- 不会，也不记日志。

原文证据：
- [corpus/management.md:11](corpus/management.md)：AES-256-GCM 加密后存 `headers_encrypted`
- [corpus/ui.md:18](corpus/ui.md)：前端不存 localStorage、不记日志

## project-104 · dev · 多处证据

问题：MCP 连接池如何区分配置版本，哪些配置变更会递增该版本？

参考答案：tenantId、serverId、configVersion。 URL、headers、超时变更。

固定评分要点：
- tenantId、serverId、configVersion。
- URL、headers、超时变更。

原文证据：
- [corpus/pool.md:9](corpus/pool.md)：`tenantId + serverId + configVersion`
- [corpus/management.md:25](corpus/management.md)：URL/headers/超时变更递增 configVersion

## project-105 · dev · 多处证据

问题：MCP 管理侧测试是否用连接池，测试结束如何释放连接？

参考答案：一次性连接，用完 close。 不使用，走一次性连接。

固定评分要点：
- 一次性连接，用完 close。
- 不使用，走一次性连接。

原文证据：
- [corpus/management.md:27](corpus/management.md)：一次性连接测试，用完 close
- [corpus/pool.md:12](corpus/pool.md)：test/refresh/探活用一次性连接，不走池

## project-106 · dev · 多处证据

问题：未授权 Agent 能否使用 MCP 工具，内置检索和搜索工具是否同样受限？

参考答案：不能，默认无 MCP 工具。 不受 MCP 授权约束。

固定评分要点：
- 不能，默认无 MCP 工具。
- 不受 MCP 授权约束。

原文证据：
- [corpus/grants.md:6](corpus/grants.md)：未建 grant 的 Agent 默认无 MCP 工具
- [corpus/grants.md:7](corpus/grants.md)：内置工具（`web_search`、`rag_retrieval`）不受授权约束

## project-107 · test · 多处证据

问题：MCP 同键并发借用如何建连，归还后何时关闭？

参考答案：不会，共用 in-flight 建连。 不会，release 只归还；空闲超过 TTL 后由 sweep 关闭。

固定评分要点：
- 不会，共用 in-flight 建连。
- 不会，release 只归还；空闲超过 TTL 后由 sweep 关闭。

原文证据：
- [corpus/pool.md:10](corpus/pool.md)：并发 acquire 共用 in-flight 建连，不重复建连
- [corpus/pool.md:11](corpus/pool.md)：release 只归还不关闭；idle 超 TTL 后台 sweep 关闭
