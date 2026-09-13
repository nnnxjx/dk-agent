import { Injectable, Logger } from '@nestjs/common';

interface RunEntry {
  controller: AbortController;
  threadId: string;
  tenantId: string;
  startedAt: number;
}

/**
 * 运行中的 Agent Run 注册表：runId → AbortController
 * - SSE transport 中断（req close）与显式 DELETE /runs/:runId 共用同一个取消桥梁
 * - 内存 Map，单实例有效；多实例需升级为 Redis pub/sub（见 stop-generation-plan §8）
 */
@Injectable()
export class RunRegistry {
  private readonly logger = new Logger(RunRegistry.name);
  private readonly runs = new Map<string, RunEntry>();
  /** 兜底 TTL，防止异常路径泄漏（10 分钟） */
  private readonly ttlMs = 10 * 60 * 1000;

  create(runId: string, threadId: string, tenantId: string): AbortSignal {
    const controller = new AbortController();
    this.runs.set(runId, { controller, threadId, tenantId, startedAt: Date.now() });
    return controller.signal;
  }

  get(runId: string): AbortSignal | undefined {
    return this.runs.get(runId)?.controller.signal;
  }

  /** 取消指定 run；不存在/已结束返回 false（幂等） */
  abort(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    if (entry.controller.signal.aborted) return false;
    entry.controller.abort();
    this.logger.log(`Run ${runId} (thread ${entry.threadId}) aborted`);
    return true;
  }

  /** 顶掉同一会话的旧 run（新消息自动停旧，reason=superseded 由调用方发事件） */
  abortByThread(threadId: string, excludeRunId?: string): string[] {
    const aborted: string[] = [];
    for (const [runId, entry] of this.runs) {
      if (entry.threadId === threadId && runId !== excludeRunId && !entry.controller.signal.aborted) {
        entry.controller.abort();
        aborted.push(runId);
      }
    }
    return aborted;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  /** 定时清理过期条目（可选调用，或由模块 onModuleInit 起 timer） */
  sweep(): void {
    const now = Date.now();
    for (const [runId, entry] of this.runs) {
      if (now - entry.startedAt > this.ttlMs) {
        this.runs.delete(runId);
      }
    }
  }

  belongsTo(runId: string, tenantId: string): boolean {
    const entry = this.runs.get(runId);
    return !!entry && entry.tenantId === tenantId;
  }
}
