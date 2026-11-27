import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RerankOutcome = {
  /** 是否成功应用语义重排；为 false 时由调用方保留原候选顺序。 */
  applied: boolean;
  /** index 对应输入 documents 的位置，score 为统一重排分数。 */
  order: Array<{ index: number; score: number }>;
  /** 未应用重排的原因，供工具结果展示降级状态。 */
  reason?: string;
  elapsedMs: number;
};

/**
 * 对跨知识库的去重候选统一评分，不负责文档召回、来源合并或 TopK 截断。
 * 返回原候选索引而不是服务端文档，便于调用方保留本地文本及完整来源。
 */
@Injectable()
export class GlobalRerankService {
  constructor(private readonly config: ConfigService) {}

  async rank(query: string, documents: string[]): Promise<RerankOutcome> {
    const start = Date.now();
    const fallback = (reason: string): RerankOutcome => ({
      applied: false,
      order: [],
      reason,
      elapsedMs: Date.now() - start,
    });

    // 不满足请求条件时直接降级，避免无效调用；不提前截断候选池。
    if (!this.config.get<boolean>('rag.rerank.enabled')) {
      return fallback('disabled');
    }

    const baseUrl = this.config.get<string>('rag.rerank.baseUrl');
    const apiKey = this.config.get<string>('rag.rerank.apiKey');
    if (!baseUrl || !apiKey) {
      return fallback('not_configured');
    }
    if (documents.length < 2) {
      return fallback('insufficient_candidates');
    }

    const maxCandidates =
      this.config.get<number>('rag.rerank.maxCandidates') ?? 200;
    if (documents.length > maxCandidates) {
      return fallback('candidate_limit_exceeded');
    }

    try {
      const model =
        this.config.get<string>('rag.rerank.model') ||
        'BAAI/bge-reranker-v2-m3';
      const timeoutMs = this.config.get<number>('rag.rerank.timeoutMs') ?? 5000;

      // 请求全量候选的评分；最终 TopK 由调用方在全局排序之后截取。
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          query,
          documents,
          top_n: documents.length,
          return_documents: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return fallback(`http_${response.status}`);
      }

      const body = (await response.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };

      // 必须完整且一一对应，防止缺项、重复或越界索引破坏本地来源映射。
      if (
        !Array.isArray(body.results) ||
        body.results.length !== documents.length
      ) {
        return fallback('invalid_response');
      }

      const indices = new Set<number>();
      for (const result of body.results) {
        const invalidIndex =
          !Number.isInteger(result.index) ||
          result.index < 0 ||
          result.index >= documents.length ||
          indices.has(result.index);
        const invalidScore = !Number.isFinite(result.relevance_score);

        if (invalidIndex || invalidScore) {
          return fallback('invalid_response');
        }
        indices.add(result.index);
      }

      // 不依赖服务端返回顺序；同分时按输入索引排序，保证结果稳定。
      const order = body.results
        .map((result) => ({
          index: result.index,
          score: result.relevance_score,
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      return {
        applied: true,
        order,
        elapsedMs: Date.now() - start,
      };
    } catch {
      // 超时、网络或解析异常统一降级，不暴露响应正文、凭据或文档内容。
      return fallback('request_failed_or_timeout');
    }
  }
}
