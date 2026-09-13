# 对话中断（Stop Generation）功能 — 实施计划

> 目标：实现类似 DeepSeek / ChatGPT 的“生成中点击按钮中断当前对话”能力。
> 范围：`src/chat` + `src/agent`（后端）与 `web/src/pages/ChatPage.tsx` + `web/src/lib/api.ts`（前端）。
> 现状版本：SSE + AG-UI 单向流，无任何取消透传（后端跑完才停）。

---

## 1. 背景与问题

### 1.1 用户期望

1. AI 流式输出过程中，发送按钮变为“停止”（方形图标），可点击。
2. 点击后：前端立刻停止打字机效果、保留已输出的 partial 文本；后端立刻停止 LLM token 生成与工具调用，不再扣费、不再写全量回复。
3. 中断后对话仍可用：可重新提问、切换会话、刷新后看到的是被截断的 assistant 消息（而非完整回复）。
4. 中断是“正常操作”不是报错：不弹 error toast，不打 ERROR 日志。

### 1.2 现状缺口（实测代码）

| 层 | 文件 | 现状 | 缺口 |
|---|---|---|---|
| 前端发起 | `web/src/lib/api.ts → streamChat()` | 已创建 `AbortController` 并返回 | 调用方 `ChatPage.tsx` 拿到 `abortRef.current` 后**从未调用 `.abort()`**；按钮在 `streaming=true` 时 `disabled`，用户点不了 |
| 前端 abort 语义 | 同上 `.catch(err => if AbortError 不回调)` | abort 后既不调 `onDone` 也不调 `onError` | `streaming` 会永远卡 `true`，必须手动在停止 handler 里复位 |
| 前端 SSE 解析 | `streamChat` 内 `buffer.split("\n")` | 按单行切分 | 跨 chunk 的 `event:/data:` 粘包处理脆弱；abort 时未 `reader.cancel()`，底层 TCP 仍可能滞留 |
| 后端 SSE | `src/chat/chat.controller.ts → chatCompletions()` | `res.write(serializeEvent)` 循环写流 | 未监听 `req.on('close')`，前端断开后端无感知；`res.write` 在 socket 关闭后可能抛 `ERR_STREAM_WRITE_AFTER_END` |
| 后端编排 | `src/agent/agent.service.ts → execute() / processStreamEvents()` | `graph.streamEvents({messages}, {version:'v2', recursionLimit})` 无 `signal` | LangChain 不知道要停：LLM 继续生成、Tavily/Milvus 工具继续跑、25/50 轮 Supervisor 循环跑完才返回 |
| 后端持久化 | `chat.controller.ts` 内 `collectedMessages` + `for(...addMessage)` | 放在 `try` 成功路径 | 一旦抛错/中断，assistant 消息**一条不存**；若“前端假中断、后端真跑完”，刷新后会冒出一条用户没看到的完整回复（数据不一致） |
| 协议 | `src/common/interfaces/ag-ui-events.ts → EventType` | 只有 `RUN_STARTED/FINISHED/ERROR` | 无“取消”语义，前端无法区分“正常结束 vs 用户中断 vs 报错” |
| 节点函数 | `supervisor.factory.ts / dag-engine.ts` | `invoke(..., config?)` 但上层从未传 `signal` | 即使顶层 abort，`supervisorNode / responderNode / createReactAgent.invoke / tool.invoke` 照样跑 |

结论：**现在点的“中断”只能是前端自嗨，后端是孤儿运行（orphan run），浪费 token 且污染 DB。**

---

## 2. 目标与非目标

### 2.1 本期目标（Must）

- [ ] 生成中可一键停止，前端 100ms 内有视觉反馈。
- [ ] 后端 ≤1–2s 内停止 LLM 流与工具调用（允许把“正在飞的单次 LLM/tool 调用”跑完，但不开启下一轮）。
- [ ] 中断的 partial 文本正确落库，刷新一致。
- [ ] 中断走正常路径：前端不报错，后端 `logger.log`（非 `error`），AG-UI 发明确的取消事件。
- [ ] 边界安全：连点停止、切换会话、关闭页面、并发发消息都不崩。

### 2.2 非目标（Not this time）

- 多轮“暂停/继续”（resume）——只做终止，不做断点续写。
- 同一会话多 run 并行——仍保持“单会话单 active run”，新消息自动先停旧 run（见 §6.5）。
- 消息 `status` 字段大重构——先用最小侵入方案（内容后缀标记 + 可选字段，见 §5）。

---

## 3. 总体方案（推荐：双通道取消）

只用 `fetch.abort()` 不够（网关/代理可能不透传 RST，且后端拿不到 `runId→signal` 映射）。
只用“显式 cancel API”不够（多一次 RTT，中断手感慢）。

推荐两者都做，互为兜底：

```
[ChatPage 停止按钮]
   ├─① transport abort ── AbortController.abort() ──→ 浏览器关 SSE socket ──→ Nest req 'close' ──→ AbortController.abort()
   └─② explicit cancel ── DELETE /chat/runs/:runId ──→ 同一个 AbortController.abort()
                                                        │
                                                        ▼
                                              AgentService.execute({signal})
                                                        │
                              ┌─────────────────────────┼─────────────────────────┐
                              ▼                         ▼                         ▼
                    streamEvents({signal})   llm.invoke(..,{signal})   tool.invoke(..,{signal})
                                                        │
                                                        ▼
                                              抛 AbortError → 发 RUN_CANCELLED → 存 partial → 关 SSE
```

核心新增件：**后端 `RunRegistry`（`runId → AbortController` 内存 Map）**，Controller 与 AgentService 之间唯一的取消桥梁。

为什么是内存 Map 而不是 Redis：取消信号要求进程内即时可达，Redis pub/sub 太重；多实例部署时再升级（见 §8 风险）。

---

## 4. 后端改动

### 4.1 新增 `RunRegistry`（建议 `src/chat/run-registry.service.ts`）

```ts
@Injectable()
export class RunRegistry {
  private runs = new Map<string, { controller: AbortController; threadId: string; startedAt: number }>();
  create(runId: string, threadId: string): AbortSignal;
  abort(runId: string): boolean;
  abortByThread(threadId: string, excludeRunId?: string): void; // 新消息顶掉旧 run 用
  delete(runId: string): void;
  get(runId: string): AbortSignal | undefined;
}
```

- `create` 在 `chatCompletions` 发 `RUN_STARTED` 之前调用。
- `delete` 在 `finally` 中调用，防止泄漏；可加 10 分钟 TTL 定时清理兜底。
- 注意：`AbortController` 是 Node 17+ 全局可用，无需 polyfill。

### 4.2 `ChatController.chatCompletions` 改造

1. 签名加 `@Req() req`：
   ```ts
   async chatCompletions(@Body() body, @CurrentUser() user, @TenantId() tenantId, @Req() req: Request, @Res() res: Response)
   ```
2. 建 run 并监听断开：
   ```ts
   const runId = genId();
   const signal = this.runRegistry.create(runId, threadId);
   let clientAborted = false;
   req.on('close', () => {
     if (!res.writableEnded) { clientAborted = true; this.runRegistry.abort(runId); }
   });
   ```
3. `onEvent` 写流加守卫（防 close 后再写）：
   ```ts
   const onEvent = (e: AGUIEvent) => {
     if (res.writableEnded || clientAborted) return;
     res.write(serializeEvent(e));
     // ... collectedMessages 累积不变
   };
   ```
4. `execute` 传 `signal`；`catch` 区分取消：
   ```ts
   try { await this.agentService.execute({ threadId, runId, messages, workflowId, llmOptions, tenantId, onEvent, signal }); }
   catch (err) {
     if (signal.aborted || err?.name === 'AbortError' || clientAborted) {
       this.logger.log(`Run ${runId} cancelled by client`);
       safeWrite({ type: EventType.RUN_CANCELLED, threadId, runId } as any);
     } else { /* 原 RUN_ERROR 路径 */ }
   } finally {
     // ★ partial 持久化必须搬到 finally（见 §4.4），然后 runRegistry.delete(runId)
   }
   ```
5. 新增显式取消接口（与 transport abort 共用同一个 registry）：
   ```
   DELETE /chat/runs/:runId  →  { success: true, aborted: boolean }
   ```
   需同样过 `JwtAuthGuard + TenantGuard`，并校验 run 属于该 tenant/thread（registry 里存 tenantId 即可）。

### 4.3 `AgentService.execute / processStreamEvents` 透传 `signal`

- `OrchestrationRequest` 加 `signal?: AbortSignal`。
- 三处必传：
  1. `graph.streamEvents(input, { version: 'v2', recursionLimit, signal })` —— 主循环停得下来全靠它。
  2. `supervisor.factory.ts`：`supervisorNode / responderNode / reactAgent.invoke({messages}, config)` 的 `config` 需携带 `signal`（`executeSupervisor` 里 `graph.invoke/streamEvents` 的 signal 会自动向下透传到 node 的 `config.signal`，节点内再传给 `llm.withStructuredOutput().invoke(..., config)` 即可；子 `createReactAgent` 需显式把外层 `config.signal` 透给 `reactAgent.invoke(..., { signal })`）。
  3. `dag-engine.ts`：`ctx` 加 `signal`，`agent.invoke / tool.invoke` 均带 signal；`condition` 节点每次循环首行加 `ctx.signal?.throwIfAborted()`。
- `processStreamEvents` 的 `for await...` 外包 `try/catch`：
  ```ts
  try { for await (const e of eventStream) { signal?.throwIfAborted(); /* 原逻辑 */ } }
  catch (err) {
    flushTextBuffer(); // 把已收 token 先发出去，保证前端有 partial
    if (currentMessageId) onEvent({ type: TEXT_MESSAGE_END, messageId: currentMessageId });
    // 补发该 step 的 STEP_FINISHED（否则前端转圈停不下来），再 throw 让上层发 RUN_CANCELLED
    throw err;
  }
  ```
- 工具调用进行中被 abort：`on_tool_end` 可能永远不来，前端靠 `TOOL_CALL_END` 收尾——取消路径里要对未 `done` 的 toolCall 补发 `TOOL_CALL_END` 或前端超时收尾（前后端约定其一，见 §6.3）。

### 4.4 中断的持久化语义（重要）

现状坑：持久化在 `try` 成功后，取消则丢消息。

改为 `finally` 中统一落库：

```ts
const partials = [...collectedMessages.values()].filter(m => m.content?.trim());
for (const msg of partials) {
  const content = wasCancelled ? msg.content + '\n\n> ⏹ 已手动停止生成' : msg.content;
  await this.chatService.addMessage(threadId, tenantId, 'assistant', content, lastStepName);
}
```

- 是否加后缀标记：建议加（DeepSeek/ChatGPT 也是明确展示“已停止”），且让刷新前后一致。
- 进阶（可选）：`messages` 表加 `status: 'complete' | 'cancelled' | 'error'` + `run_id` 列，便于统计中断率；本期可用“后缀标记”先行， migration 后续再做（见 §9 分期）。

### 4.5 协议扩展 `ag-ui-events.ts`

```ts
export enum EventType {
  // ...原有
  RUN_CANCELLED = 'RUN_CANCELLED',
}
export interface RunCancelledEvent extends BaseEvent {
  type: EventType.RUN_CANCELLED;
  threadId: string;
  runId: string;
  reason?: 'client_abort' | 'explicit_cancel' | 'superseded';
}
```

- `serializeEvent` 不用改（已是通用 `event: ${type}`）。
- 前端 `streamChat` 的 `onEvent(eventType, data)` 天然兼容，新事件直接透出。

---

## 5. 数据模型（最小侵入）

| 改动 | 说明 | 是否本期 |
|---|---|---|
| `messages.content` 存 partial + `\n\n> ⏹ 已手动停止生成` 后缀 | 零 migration，前后一致 | ✅ 本期 |
| `messages.agent_name` 存 `lastStepName`（已有逻辑） | 中断时同样记录，便于排查停在哪一步 | ✅ 本期 |
| 新增 `messages.status / run_id` 列 | 精确统计与幂等去重 | ⬜ 下期（TypeORM migration） |
| `conversations.updatedAt` 中断后也更新 | 保证列表排序正常（`addMessage` 后 touch 一下 conversation 即可） | ✅ 本期顺手 |

---

## 6. 前端改动

### 6.1 `web/src/lib/api.ts → streamChat()` 改造

1. 返回值从 `AbortController` 改为 `{ controller, runIdPromise }` 或至少暴露 `runId`：
   - `runId` 藏在首个 `RUN_STARTED` 事件里，前端收到后存 `runIdRef`，停止时调显式接口用。
2. 加 `onCancel` / 统一 `onSettled` 回调，abort 时也要收尾：
   ```ts
   .catch(err => {
     if (err.name === 'AbortError') { options.onAbort?.(); return; } // 不再静默吞掉
     onError(err);
   });
   ```
3. abort 时 `reader.cancel()`：
   ```ts
   controller.signal.addEventListener('abort', () => reader?.cancel().catch(()=>{}));
   ```
4. 新增：
   ```ts
   export const chatRunApi = {
     cancel: (runId: string) => request(`/chat/runs/${runId}`, { method: 'DELETE' }),
   };
   ```
5. SSE 解析小修：用 `buffer.split("\n\n")` 按帧切（或保留余量行），避免 `event:` 与 `data:` 被拆到两次 `read()`。

### 6.2 `web/src/pages/ChatPage.tsx` 改造

1. 新增 `runIdRef = useRef<string|null>(null)` + `stoppedRef = useRef(false)`（区分“用户主动停”还是“报错/异常结束”，决定落库文案与 toast）。
2. 新增 `handleStop()`：
   ```ts
   const handleStop = async () => {
     stoppedRef.current = true;
     abortRef.current?.abort();                    // ① 关 transport
     if (runIdRef.current) chatRunApi.cancel(runIdRef.current).catch(()=>{}); // ② 显式 cancel（兜底，不 await）
     setStreaming(false);
     setStreamState(prev => { if (prev?.currentText) commitPartial(prev); return null; });
     // commitPartial: 把 currentText + toolCalls 快照追加为一条 assistant 消息（带“已停止”后缀），与后端 finally 落库文案保持一致
   };
   ```
3. 发送按钮语义切换：
   ```tsx
   <Button onClick={streaming ? handleStop : handleSend} disabled={!streaming && !input.trim()}>
     {streaming ? <Square/> : <Send/>}
   </Button>
   ```
   - `streaming` 时**必须可用**（现状是 `disabled`，这是最大 UX bug）。
   - `handleSend` 开头 `stoppedRef.current = false; runIdRef.current = null;`，`RUN_STARTED` 事件里 `runIdRef.current = data.runId`。
4. `onDone/onError` 里若 `stoppedRef.current` 则跳过重复 commit（abort 与 done 可能都触发）。
5. 切会话/卸载时 abort：
   ```ts
   useEffect(() => () => abortRef.current?.abort(), []);
   // setActiveId 前先 abort 旧流，防止旧流 partial 写进新会话
   ```
6. `handleSend` 发新消息前：若 `streaming`（理论上按钮已变停止，不应进来），直接 `return`；支持“排队发送”则是下期需求，本期直接禁 Enter（`handleKeyDown` 里 `if (streaming) return`）。

### 6.3 前后端收尾对齐（防“转圈永不消失”）

约定取消时后端必发的最小事件集：`TEXT_MESSAGE_END（若有）→ STEP_FINISHED（补发未完 step）→ RUN_CANCELLED → done/[DONE]`。
前端 `STREAMING` 收尾条件：收到 `RUN_CANCELLED/RUN_FINISHED/RUN_ERROR/done` 任一即 `setStreaming(false)`。工具卡 `TOOL_CALL_START` 未 `END` 的，前端见到 `RUN_CANCELLED` 直接把未 done 的 tool 标 done（灰色“已取消”态）。

---

## 7. 接口契约

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/v1/chat/completions` | POST | JWT + Tenant | body 不变；响应 SSE 新增可能的 `RUN_CANCELLED` 事件；客户端断开即取消（无需改 body） |
| `/api/v1/chat/runs/:runId` | DELETE | JWT + Tenant | 显式取消；返回 `{ success, aborted }`；run 不存在/已结束返回 `aborted:false`（幂等，不 404） |

SSE 取消帧示例：

```
event: RUN_CANCELLED
data: {"type":"RUN_CANCELLED","threadId":"...","runId":"...","reason":"client_abort","timestamp":...}

event: done
data: [DONE]
```

---

## 8. 异常与边界

| 场景 | 处理 |
|---|---|
| 用户连点停止 | `handleStop` 幂等（abort 多次无害，cancel API 幂等）；`runRegistry.abort` 对不存在 run 返回 false |
| 工具执行中（Tavily 30s）被停 | 本次 `tool.invoke` 跑完（ LangChain tool 多不支持真抢占），但 `processStreamEvents` 不再进入下一节点，直接走取消收尾 |
| LLM 首 token 还没来就停 | partial 为空 → 后端不落空 assistant 消息，只关流；前端不追加气泡 |
| 后端写流时 socket 已关 | `onEvent` 守卫 `writableEnded`，不抛；`finally` 仍落库（DB 与 socket 无关） |
| 多实例部署 | 内存 Map 只在 sticky-session/单实例有效；多实例需换 Redis pub/sub 或把 cancel 路由到 run 所在实例（本期先单实例 + 文档注明） |
| 同会话并发发消息 | 后端 `abortByThread(threadId, excludeNewRun)` 顶掉旧 run 并对其发 `reason: 'superseded'`（可选，默认开启） |
| 日志噪音 | 取消走 `logger.log/debug`，不走 `error`；`RUN_ERROR` 仅保留真异常 |

---

## 9. 分期与工作量

### Phase 0 — 文档（本文件 + 链路文档，已完成）
### Phase 1 — 最小可用中断（0.5–1 天）
- 前端：按钮切换 + `handleStop` + abort 复位 + partial 本地落气泡（不改 `api.ts` 返回值也行，先只 abort transport）。
- 后端：`req close → abort` + `signal` 进 `streamEvents` + 取消走 log + `finally` 存 partial + `RUN_CANCELLED` 事件。
- 联调：正常问答回归 + 中断后刷新一致。
### Phase 2 — 显式取消与健壮性（0.5 天）
- `RunRegistry` + `DELETE /runs/:runId` + 前端双通道 + `reader.cancel` + SSE 按帧解析 + 切会话 abort。
### Phase 3 — 可观测与 polish（可选，0.5 天）
- `messages.status/run_id` migration、中断率统计、停止按钮 loading 态、tool“已取消”灰态、E2E（Playwright：发消息→等首 token→停→断言 DB 为 partial）。

总计：**Phase 1+2 约 1–1.5 人天**（含联调），Phase 3 另计。

---

## 10. 验收标准

1. 长回复（如“写 2000 字文章”）生成 2s 内点停止，前端 200ms 内停住，页面有“已停止”气泡。
2. 后端日志出现 `cancelled`（非 error），且 2s 后无新增 `TEXT_MESSAGE_CONTENT`（tail 日志验证）。
3. 刷新页面，中断那条 assistant 消息与中断瞬间一致（含后缀），不变成完整回复。
4. 连续中断 5 次不卡死；中断后立刻追问能正常回答。
5. 正常（不中断）对话回归：工具调用（web_search/rag）+ DAG + Supervisor 全链路事件顺序不变。

---

## 11. 改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/chat/run-registry.service.ts` | **新增** |
| `src/chat/chat.controller.ts` | 加 `@Req`、registry、close 监听、守卫写流、finally 落库、`DELETE /runs/:runId` |
| `src/chat/chat.module.ts` | 注册 `RunRegistry` provider |
| `src/agent/agent.service.ts` | `OrchestrationRequest.signal`、`streamEvents({signal})`、取消收尾 |
| `src/agent/supervisor.factory.ts` | node `config.signal` 透传 |
| `src/agent/dag-engine.ts` | `ctx.signal` + `throwIfAborted` |
| `src/common/interfaces/ag-ui-events.ts` | `RUN_CANCELLED` |
| `web/src/lib/api.ts` | `onAbort/reader.cancel/按帧解析/chatRunApi.cancel` |
| `web/src/pages/ChatPage.tsx` | `handleStop`、按钮切换、`runIdRef/stoppedRef`、 unmount/切会话 abort |
