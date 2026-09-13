import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Res,
  Req,
  UseGuards,
  HttpCode,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { z } from 'zod';
import { ChatService } from './chat.service';
import { AgentService } from '../agent/agent.service';
import { RunRegistry } from './run-registry.service';
import { JwtAuthGuard, TenantGuard } from '../auth/guards';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantId } from '../common/decorators/tenant.decorator';
import { AGUIEvent, EventType, serializeEvent, genId } from '../common/interfaces/ag-ui-events';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

const ChatRequestSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  llmOptions: z
    .object({
      provider: z.enum(['openai', 'anthropic', 'dashscope']).optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
});

const CreateConvSchema = z.object({
  title: z.string().optional(),
  workflowId: z.string().uuid().optional(),
});

/** 中断 partial 落库时的后缀标记（前后端保持一致） */
export const CANCEL_SUFFIX = '\n\n> ⏹ 已手动停止生成';

function isAbortError(error: any): boolean {
  if (!error) return false;
  if (error?.name === 'AbortError') return true;
  // LangChain / undici 在 abort 时可能抛不同形态
  const msg = String(error?.message || '');
  return /aborted|abort|canceled|cancelled/i.test(msg) && /abort|cancel/i.test(msg);
}

@Controller('chat')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly agentService: AgentService,
    private readonly runRegistry: RunRegistry,
  ) {}

  /**
   * AG-UI 流式对话接口
   * POST /chat/completions
   */
  @Post('completions')
  @HttpCode(200)
  async chatCompletions(
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
    @TenantId() tenantId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const dto = ChatRequestSchema.parse(body);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 获取或创建会话（threadId）
    let threadId = dto.conversationId;
    let needsTitle = false;
    if (!threadId) {
      const conv = await this.chatService.createConversation(user.id, tenantId, undefined, dto.workflowId);
      threadId = conv.id;
      needsTitle = true;
    } else {
      // 已有对话但标题还是默认值，说明是首次发送消息
      const conv = await this.chatService.getConversation(threadId, tenantId);
      if (conv && conv.title === 'New Conversation') {
        needsTitle = true;
      }
    }

    const runId = genId();
    const signal = this.runRegistry.create(runId, threadId, tenantId);

    // 同一会话的新 run 顶掉旧 run（单会话单 active run）
    const superseded = this.runRegistry.abortByThread(threadId, runId);
    if (superseded.length > 0) {
      this.logger.log(`Run ${runId} superseded ${superseded.length} older run(s) in thread ${threadId}`);
    }

    // 客户端断开（transport abort）→ 取消 run
    let clientAborted = false;
    const onClose = () => {
      if (!res.writableEnded) {
        clientAborted = true;
        this.runRegistry.abort(runId);
      }
    };
    req.on('close', onClose);

    await this.chatService.addMessage(threadId, tenantId, 'user', dto.message);
    const messages = await this.chatService.getContextMessages(threadId, tenantId);

    // 收集 assistant 回复用于持久化
    const collectedMessages: Map<string, { content: string; role: string }> = new Map();
    let lastStepName = 'assistant';

    const safeWrite = (event: AGUIEvent) => {
      if (res.writableEnded || clientAborted) return;
      try {
        res.write(serializeEvent(event));
      } catch {
        // socket 已关，忽略；持久化不受影响
      }
    };

    const onEvent = (event: AGUIEvent) => {
      safeWrite(event);

      // 收集 TextMessage 内容
      if (event.type === EventType.TEXT_MESSAGE_START) {
        collectedMessages.set(event.messageId, { content: '', role: event.role });
      }
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        const msg = collectedMessages.get(event.messageId);
        if (msg) msg.content += event.delta;
      }
      if (event.type === EventType.STEP_STARTED) {
        lastStepName = event.stepName;
      }
    };

    let wasCancelled = false;

    try {
      await this.agentService.execute({
        threadId,
        runId,
        messages,
        workflowId: dto.workflowId,
        llmOptions: dto.llmOptions,
        tenantId,
        onEvent,
        signal,
      });
    } catch (error: any) {
      const cancelled = signal.aborted || clientAborted || isAbortError(error);
      if (cancelled) {
        // 正常操作：用户中断，不记 error
        wasCancelled = true;
        this.logger.log(`Run ${runId} cancelled by client (thread ${threadId})`);
        safeWrite({
          type: EventType.RUN_CANCELLED,
          threadId,
          runId,
          reason: clientAborted ? 'client_abort' : 'explicit_cancel',
        } as any);
      } else {
        this.logger.error(`Chat completion error: ${error.message}`, error.stack);
        const errEvent: AGUIEvent = {
          type: EventType.RUN_ERROR,
          message: error.message,
        };
        safeWrite(errEvent);
      }
    } finally {
      // 中断也要落库 partial（与正常路径统一，保证刷新一致）
      try {
        for (const [, msg] of collectedMessages) {
          if (msg.content && msg.content.trim() && msg.role === 'assistant') {
            const content = wasCancelled ? msg.content + CANCEL_SUFFIX : msg.content;
            await this.chatService.addMessage(threadId, tenantId, 'assistant', content, lastStepName);
          }
        }
        // touch 会话，保证列表排序
        await this.chatService.touchConversation(threadId, tenantId).catch(() => {});
      } catch (persistErr: any) {
        this.logger.error(`Persist assistant message failed: ${persistErr.message}`);
      }

      // 新对话首条消息后自动生成标题（异步，不阻塞响应；取消时也生成，标题来自 user 消息不受影响）
      if (needsTitle) {
        this.chatService.generateTitle(threadId, tenantId, dto.message).catch(() => {});
      }

      this.runRegistry.delete(runId);
      req.off?.('close', onClose);
      if (!res.writableEnded) {
        try {
          res.write('event: done\ndata: [DONE]\n\n');
        } catch {
          // ignore
        }
        res.end();
      }
    }
  }

  /**
   * 显式取消正在运行的 run（与 transport abort 共用 RunRegistry）
   * DELETE /chat/runs/:runId —— 幂等，不存在/已结束返回 aborted:false
   */
  @Delete('runs/:runId')
  async cancelRun(@Param('runId') runId: string, @TenantId() tenantId: string) {
    if (!this.runRegistry.belongsTo(runId, tenantId)) {
      return { success: true, aborted: false };
    }
    const aborted = this.runRegistry.abort(runId);
    return { success: true, aborted };
  }

  @Post('conversations')
  async createConversation(
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
    @TenantId() tenantId: string,
  ) {
    const dto = CreateConvSchema.parse(body);
    return this.chatService.createConversation(user.id, tenantId, dto.title, dto.workflowId);
  }

  @Get('conversations')
  async listConversations(@CurrentUser() user: AuthenticatedUser, @TenantId() tenantId: string) {
    return this.chatService.listConversations(user.id, tenantId);
  }

  @Get('conversations/:id/messages')
  async getMessages(@Param('id') id: string, @TenantId() tenantId: string) {
    return this.chatService.getMessages(id, tenantId);
  }

  @Delete('conversations/:id')
  async deleteConversation(@Param('id') id: string, @TenantId() tenantId: string) {
    await this.chatService.deleteConversation(id, tenantId);
    return { success: true };
  }
}
