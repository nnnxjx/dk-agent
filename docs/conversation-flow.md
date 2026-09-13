# 整体逻辑链路整理（对话 / Agent / 流式 / 记忆 / 工具 / RAG）

> 目的：把“一次对话从前端输入到 assistant 落库”的全链路讲清楚，作为后续加“中断生成”与一切对话相关需求的基准文档。
> 代码基准：`src/chat/*`、`src/agent/*`、`src/common/interfaces/ag-ui-events.ts`、`src/llm/*`、`src/tools/*`、`src/rag/*`、`web/src/pages/ChatPage.tsx`、`web/src/lib/api.ts`。
> 配套文档：中断功能实施计划见 `stop-generation-plan.md`。

---

## 1. 系统全景

```
浏览器 (React 18 + Vite + shadcn/ui)
  │  POST /api/v1/chat/completions (SSE)  +  CRUD /chat/conversations
  ▼
NestJS (src/)
  ├─ chat/      会话 CRUD + SSE 建流 + 消息持久化 + 记忆策略入口
  ├─ agent/     编排入口：Supervisor(默认) / DAG(带 workflowId) 二选一 + streamEvents 转 AG-UI
  ├─ llm/       多供应商工厂 (openai / anthropic / dashscope，兼容 SiliconFlow/DeepSeek)
  ├─ tools/     ToolRegistry：web_search (Tavily) + rag_retrieval (Milvus)
  ├─ rag/       知识库：分块 + Embedding + Milvus 写入/检索
  ├─ auth/      JWT + TenantGuard，多租户隔离
  ├─ redis/     会话/消息缓存
  └─ common/    AG-UI 事件定义 + serializeEvent(SSE 帧)
MySQL (conversations / messages / workflows / knowledge-bases) + Redis + Milvus + 外部 LLM/Tavily
```

关键约定：

- 流式协议 = **SSE + AG-UI 事件**，帧格式 `event: <TYPE>\ndata: <JSON>\n\n`，结束帧 `event: done\ndata: [DONE]`。
- 后端是“编排器”，真正的 token 流来自 LangChain `graph.streamEvents(..., { version: 'v2' })` 的 `on_chat_model_stream`。
- 前端是“渲染器”，只按 `eventType` 做 reducer 式拼装，不解析 LangChain 语义。

---

## 2. 前端链路（`web/`）

### 2.1 页面状态（`ChatPage.tsx`）

| state | 用途 |
|---|---|
| `conversations / activeId / messages` | 会话列表、当前会话、已落库消息（`GET conversations/:id/messages`） |
| `input / streaming / streamState` | 输入框、是否生成中、当前 run 的流式拼装态（steps/toolCalls/currentText/messageId） |
| `workflows / selectedWorkflowId` | 可选 DAG 工作流；有值 → 后端走 DAG，无值 → Supervisor |
| `abortRef (AbortController)` | `streamChat()` 返回的控制器，现状**只存不用**（中断缺口，见 plan） |
| `scrollRef` | 消息追加自动滚底 |

### 2.2 发一次消息（`handleSend`）

```
用户输入 → 乐观追加 user 气泡 → setStreaming(true) → streamChat(body, onEvent, onDone, onError)
body = { message, conversationId?: activeId, workflowId?: selectedWorkflowId }
```

`onEvent(eventType, data)` 是纯 reducer：

| AG-UI 事件 | 前端动作 |
|---|---|
| `RUN_STARTED` | 若是新会话（`!activeId`）用 `data.threadId` 置 `activeId` + 刷新会话列表 |
| `STEP_STARTED / STEP_FINISHED` | steps 数组 push / 标 done（展示 “Agent: researcher” 转圈→对勾） |
| `TOOL_CALL_START / ARGS / END / RESULT` | toolCalls 数组 push / 拼 args / 标 done / 存 result（展示工具卡片） |
| `TEXT_MESSAGE_START / CONTENT` | `messageId` + `currentText += delta`（打字机 + Markdown 实时渲染） |
| `TEXT_MESSAGE_END` | 现状空操作（收尾靠 `onDone`） |

`onDone`：把 `streamState.currentText` commit 成一条 assistant `Message` 气泡 → `setStreamState(null)` → `setStreaming(false)` → 刷新会话列表（拿后端生成的标题）。
`onError`：`console.error` + 复位（现状中断/报错共用此路径是坑，plan 里拆分为 `onAbort`）。

### 2.3 SSE 接收（`api.ts → streamChat`）

```
fetch POST /api/v1/chat/completions {signal}
 → res.body.getReader() → TextDecoder → buffer.split("\n") → event:/data: 行解析
 → data=="[DONE]" → onDone()；否则 JSON.parse → onEvent(type, payload)
```

- 鉴权：`Authorization: Bearer <localStorage token>`。
- 取消：返回 `AbortController`；`.catch` 里 `AbortError` 静默吞掉（现状导致 `streaming` 卡死，plan 修）。
- 脆弱点：按单 `\n` 切行，`event:`/`data:` 跨 chunk 粘包会错位；abort 时未 `reader.cancel()`。

---

## 3. 后端链路（`src/`）

### 3.1 入口：`POST /chat/completions`（`chat.controller.ts`）

```
① Zod 校验 (ChatRequestSchema: message必填, conversationId/workflowId可选uuid, llmOptions可选)
② 定会话：无 conversationId → createConversation(标题"New Conversation") + needsTitle=true；
              有 → getConversation，若标题仍是默认值也置 needsTitle=true
③ 写 SSE 头 (text/event-stream, no-cache, keep-alive, X-Accel-Buffering: no) + flushHeaders
④ addMessage(user) 落库 → getContextMessages(threadId) 取上下文
⑤ runId = genId() → agentService.execute({ threadId, runId, messages, workflowId, llmOptions, tenantId, onEvent })
   onEvent：res.write(serializeEvent(e)) + 累积 collectedMessages(TEXT_START/CONTENT) + 记录 lastStepName(STEP_STARTED)
⑥ 成功后：collectedMessages 中 role=assistant 且非空 → addMessage(assistant, content, lastStepName)
⑦ needsTitle → generateTitle(异步不阻塞)
⑧ 异常 → 发 RUN_ERROR；finally → 写 done/[DONE] + res.end()
```

现状特征（中断相关缺口）：无 `req close` 监听、无 `signal`、持久化只在成功路径、无 `RUN_CANCELLED`——详见 plan §1.2。

### 3.2 会话与消息（`chat.service.ts` + entities）

- `conversations`：`id(uuid) / userId / tenantId / title / workflowId? / summary? / summaryUntilMessageId? / timestamps`；Redis `conv:{id}` 缓存 3600s。
- `messages`：`id / conversationId / tenantId / role(user|assistant|system|tool) / content(text) / agentName? / createdAt`；Redis `conv_msgs:{id}` 全量数组缓存，`addMessage` 后追加回写。
- `createConversation / getConversation(缓存优先+tenant校验) / listConversations(按updatedAt倒序) / deleteConversation(删消息+会话+清缓存)`。
- `generateTitle`：首条 user 消息后调 LLM（temperature 0.3）生成 ≤15 字标题，失败静默（catch 空）。
- 记忆策略 `getContextMessages`（见 §5）。

### 3.3 编排入口：`AgentService.execute`（`agent.service.ts`）

```
onEvent(RUN_STARTED{threadId,runId})
 → workflowId ? executeDag : executeSupervisor
 → onEvent(RUN_FINISHED)；catch → onEvent(RUN_ERROR)
```

两种模式共享同一个 `processStreamEvents(graph, messages, onEvent, recursionLimit)` 把 LangChain 事件翻译成 AG-UI。

### 3.4 Supervisor 模式（默认，`supervisor.factory.ts`）

```
START → supervisor(LLM结构化路由 {next, reason}) → researcher | responder | END
researcher(createReactAgent: rag_retrieval + web_search) → 回 supervisor（最多25轮）
responder(直接 LLM 回答) → END
```

- 路由 schema：`next ∈ {researcher, RESPOND→responder, __end__→END}`。
- `supervisorNode` 发一条 `[Supervisor] Routing to ...` 的 assistant 消息进 state（下游会被 responder 过滤掉）。
- `researcher` prompt 强制“先 rag_retrieval，后 web_search，注明来源”；`agentToolMapping = { researcher: ['web_search','rag_retrieval'] }`，其中 rag 是按 tenant 动态 `createRagRetrievalTool(ragService, tenantId)` 的。
- `responderNode` 用通用 system prompt 直接 `llm.invoke`。
- recursionLimit = 25（防死循环）。

### 3.5 DAG 模式（`dag-engine.ts`，带 `workflowId` 时）

```
compile(nodes, edges, {llm, tools, onEvent, threadId}):
 邻接表 adjacency；跳过 start/end；每节点按出边声明 ends；START→start的后继
节点执行 createNodeFn：
 agent   → createReactAgent({llm, tools: config.tools, prompt}) + STEP_STARTED/FINISHED 包裹
 tool    → tool.invoke(config.input) 结果包 HumanMessage("[Tool 名]: 输出") 追加
 condition → 读最后一条消息文本，首个 condition 子串命中即 goto 该分支，否则走第一条边
 单出边 → Command(goto target)；多出边靠 condition 返回的 goto
recursionLimit = 50
```

节点类型表：`start(入口) / end(出口) / agent(可调工具) / tool(直调) / condition(关键词路由)`。

### 3.6 流翻译核心：`processStreamEvents`（token 级）

输入 `graph.streamEvents({messages: toLangChainMessages}, {version:'v2', recursionLimit})`，按 `eventName` 分流：

| LangChain 事件 | 动作 |
|---|---|
| `on_chat_model_stream`（`data.chunk`） | 跳过 supervisor 节点；`effectiveNode(checkpoint_ns首段‖langgraph_node)` 未见过 → `STEP_STARTED`；`tool_call_chunks` 非空 → 刷文本缓冲、`TOOL_CALL_START/ARGS`、置 `inToolCall`；纯文本 token → XML `<tool_call>` 过滤（qwen 类模型）→ 嵌套子 agent 未完工则暂存 `pendingTextPerNode`（过滤复述 prompt 的思考）→ 否则 `TEXT_MESSAGE_START/CONTENT` |
| `on_chat_model_end` | 刷缓冲；`output.tool_calls` → `TOOL_CALL_END`；关 `TEXT_MESSAGE_END` |
| `on_tool_end` | `TOOL_CALL_RESULT{content}`（string 或 output.content 或 JSON），`nodeToolsDone.add(node)`（此后该节点文本可直发） |
| `on_chain_end`（顶层） | 刷缓冲、关文本、`STEP_FINISHED`、移出 activeSteps |

配套状态机：`currentMessageId / activeSteps / emittedToolCalls / emittedToolResults / inToolCall / textBuffer / nodeHasToolCall / nodeToolsDone / pendingTextPerNode` + 正则 `TOOL_CALL_XML_RE / TOOL_CALL_BLOCK_RE` + `extractText(content)`（string 或 `[{type:'text',text}]` 数组）。

结束兜底：循环后 `flushTextBuffer + 关 TEXT_MESSAGE_END`，保证不丢尾。

### 3.7 LLM 工厂（`llm.service.ts`）

`createModel({provider?, model?, temperature?, streaming})`：

- `openai → ChatOpenAI(gpt-4o)`，支持 `OPENAI_BASE_URL` → 兼容 SiliconFlow / DeepSeek / vLLM 等 OpenAI-compatible 服务。
- `anthropic → ChatAnthropic(claude-sonnet)`。
- `dashscope → ChatOpenAI(qwen-max, baseURL=dashscope)`。
- 全局默认 `DEFAULT_LLM_PROVIDER/MODEL`；编排内一律 `streaming: true`，标题/摘要用 `streaming:false`。

### 3.8 工具（`tools/`）

- `ToolRegistry` 全局单例，`getByNames/getAll` 供 Agent 声明可用工具；LLM 自主决定调不调、调哪个。
- `web_search`：Tavily API，输入 `{query, maxResults?}`，输出标题+URL+摘要。
- `rag_retrieval`：输入 `{query, topK?, knowledgeBaseId?}`，经 `RagService` 做 Milvus 向量检索，输出相似片段（tenant 隔离）。

### 3.9 RAG（`rag/`）

- 入库：上传 PDF/TXT/MD/CSV/HTML/JSON 或 URL 抓取（cheerio）→ `RecursiveCharacterTextSplitter(chunkSize=1000, overlap=200)` → OpenAI Embeddings(`text-embedding-3-small`) → Milvus（collection 按 tenant 隔离）。
- 查询：query→embedding→Milvus ANN→Top-K。
- 接口：知识库 CRUD + `documents(文本) / upload(单文件) / upload-batch(≤10) / load-url / search`。

---

## 4. AG-UI 事件字典（现状）

生命周期：`RUN_STARTED{threadId,runId} → STEP_STARTED{stepName} → … → STEP_FINISHED → RUN_FINISHED{threadId,runId}`，异常 `RUN_ERROR{message,code?}`。
文本三段：`TEXT_MESSAGE_START{messageId,role} → TEXT_MESSAGE_CONTENT{messageId,delta}×N → TEXT_MESSAGE_END{messageId}`。
工具四段：`TOOL_CALL_START{toolCallId,toolCallName,parentMessageId?} → TOOL_CALL_ARGS{toolCallId,delta}×N → TOOL_CALL_END{toolCallId} → TOOL_CALL_RESULT{messageId,toolCallId,role:'tool',content}`。
状态/自定义：`STATE_SNAPSHOT/STATE_DELTA/MESSAGES_SNAPSHOT/CUSTOM` 已定义、现状未使用。
序列化：`serializeEvent = event: <type>\ndata: <JSON+timestamp>\n\n`；`genId() = randomUUID()`。
状态图见 `架构.md §9`。

---

## 5. 记忆与缓存

```
getContextMessages：
 all = getMessages（Redis conv_msgs:{id} 优先，否则 MySQL createdAt ASC + 回填）
 all ≤ windowSize(10, 默认) → 全量
 windowSize < all ≤ summaryThreshold(20) → 最近 windowSize 条
 all > summaryThreshold → generateSummary(早期 all[:-windowSize] + 旧summary → LLM压缩 → conversations.summary/summaryUntilMessageId) + [system: 对话历史摘要] + 最近 windowSize 条
```

- `generateSummary` 走小 temperature LLM，失败只记 error，不阻断对话。
- Redis TTL 3600s；`addMessage` 追加写缓存；`deleteConversation` 双清。
- 配置源：`memory.windowSize / memory.summaryThreshold`（`common/config`）。

---

## 6. 认证与多租户

```
请求 → JwtAuthGuard(验 Bearer，注入 request.user{id,email,tenantId,role})
     → TenantGuard(校验 tenantId，注入 query)
     → Controller(@CurrentUser/@TenantId) → Service(所有查询带 tenantId)
```

`POST /chat/completions` 同样双 Guard；`createRagRetrievalTool(ragService, tenantId)` 保证向量检索不出租户。

---

## 7. 时序（一次典型 Supervisor 对话）

```
FE: handleSend → streamChat POST
BE: 校验 → 定会话 → SSE建流 → 存user → 取上下文 → RUN_STARTED
    → supervisor路由(researcher) → STEP_STARTED(researcher)
    → TOOL_CALL_START/ARGS(web_search或rag) → tool.invoke → TOOL_CALL_END/RESULT
    → TEXT_MESSAGE_START/CONTENT…/END → STEP_FINISHED → RUN_FINISHED
    → 存assistant → 异步标题 → done/[DONE]
FE: onEvent拼装 → onDone commit气泡 → 刷新列表
```

`架构.md §2` 有带阶段着色的完整 sequence 版本，本文件以代码符号为准。

---

## 8. 配置与启动（摘要）

- 本地：`docker-compose up mysql/redis/etcd/minio/milvus` → `pnpm install` → `.env`(MYSQL_PORT=3307, REDIS_PORT=6380, OPENAI_API_KEY/BASE_URL, TAVILY_API_KEY) → `pnpm dev(:3000)` + `pnpm dev:web(:5173→代理/api)`。
- 生产：`docker-compose up -d` 前后端一体 :3000。
- 必填 env：`OPENAI_API_KEY`；生产另需 `JWT_SECRET`。

---

## 9. 已知链路短板（→ plan 对应节）

| 短板 | 后果 | plan 对策 |
|---|---|---|
| 前端停止按钮 disabled、无 abort 调用 | 用户停不掉 | ChatPage 按钮切换 + handleStop（plan §6.2） |
| abort 后无 onAbort/onSettled | streaming 卡死 | api.ts 加 onAbort + reader.cancel（plan §6.1） |
| 后端无 req close、无 signal | 孤儿 run 烧 token | RunRegistry + signal 透传 streamEvents/llm/tool（plan §4.2–4.3） |
| 持久化只在成功路径 | 中断丢消息/刷新冒完整回复 | finally 落 partial + 后缀标记（plan §4.4） |
| 无 RUN_CANCELLED | 无法区分停/错 | 协议扩展（plan §4.5） |
| 多实例内存 Map | cancel 跨实例失效 | 单实例先行 + 文档注明（plan §8） |

---

## 10. 文件索引

| 文件 | 职责 |
|---|---|
| `web/src/pages/ChatPage.tsx` | 会话列表/消息气泡/流态拼装/发送（中断按钮宿主） |
| `web/src/lib/api.ts` | `chatApi/workflowApi/kbApi` + `streamChat(SSE)` + 待加 `chatRunApi.cancel` |
| `src/chat/chat.controller.ts` | SSE 建流 + 编排调用 + 落库 + 待加 `DELETE /runs/:runId` |
| `src/chat/chat.service.ts` | 会话/消息 CRUD + 标题 + 记忆策略 + 缓存 |
| `src/chat/run-registry.service.ts` | 待新增：runId→AbortController |
| `src/agent/agent.service.ts` | Supervisor/DAG 二选 + streamEvents→AG-UI |
| `src/agent/supervisor.factory.ts` | Supervisor 图 + researcher/responder |
| `src/agent/dag-engine.ts` | 工作流编译执行 |
| `src/common/interfaces/ag-ui-events.ts` | AG-UI 类型 + 序列化（待加 RUN_CANCELLED） |
| `src/llm/llm.service.ts` | 三供应商工厂 |
| `src/tools/*` | web_search / rag_retrieval + 注册表 |
| `src/rag/*` | 知识库入库/检索/Milvus |
| `src/entities/{conversation,message}.entity.ts` | 表结构 |
| `README.md / 架构.md` | 项目总览与架构图（本文件不重复贴，以代码为准） |
