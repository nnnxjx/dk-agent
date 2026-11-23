import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import { RagService } from '../rag/rag.service';
import type { KnowledgeBase } from '../entities/knowledge-base.entity';

const logger = new Logger('RagRetrievalTool');
const MAX_CONCURRENT_KB_SEARCHES = 4;
const MIN_CANDIDATES_PER_KB = 10;

type SearchHit = Awaited<ReturnType<RagService['search']>>[number];
type Source = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  chunkId: string;
  metadata: Record<string, unknown>;
  localScore: number | null;
  rankWithinKnowledgeBase: number;
};
type MergedHit = Source & {
  text: string;
  retrievalMode: 'hybrid';
  sources: Source[];
};
type SearchOutcome = {
  kb: KnowledgeBase;
  hits: SearchHit[];
  error?: unknown;
};

/** 在每个知识库内保持 Hybrid 排名，跨库按名次轮流取，不比较 Collection 之间的原始 score。 */
function mergeByLocalRank(
  outcomes: SearchOutcome[],
  topK: number,
): MergedHit[] {
  const merged: MergedHit[] = [];
  const byText = new Map<string, MergedHit>();
  const maxRank = outcomes.reduce(
    (max, { hits }) => Math.max(max, hits.length),
    0,
  );

  for (let rank = 0; rank < maxRank; rank++) {
    for (const { kb, hits } of outcomes) {
      const hit = hits[rank];
      if (!hit) continue;

      const metadata: unknown = hit.metadata;
      const localScore: unknown = hit.score;

      const source: Source = {
        knowledgeBaseId: kb.id,
        knowledgeBaseName: kb.name,
        chunkId: String(hit.id),
        metadata:
          typeof metadata === 'object' &&
          metadata !== null &&
          !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : {},
        localScore: typeof localScore === 'number' ? localScore : null,
        rankWithinKnowledgeBase: rank + 1,
      };
      const text = String(hit.text ?? '');
      const key =
        text.trim().replace(/\s+/g, ' ') || `${kb.id}:${source.chunkId}`;
      const existing = byText.get(key);
      if (existing) {
        if (
          !existing.sources.some(
            (item) =>
              item.knowledgeBaseId === kb.id && item.chunkId === source.chunkId,
          )
        ) {
          existing.sources.push(source);
        }
        continue;
      }

      const item: MergedHit = {
        ...source,
        text,
        retrievalMode: 'hybrid',
        sources: [source],
      };
      byText.set(key, item);
      merged.push(item);
    }
  }

  return merged.slice(0, topK);
}

/**
 * RAG 知识库检索工具（工厂函数）
 * 固定 Hybrid 检索；租户由服务端绑定，模型只控制 query/topK。
 */
export function createRagRetrievalTool(
  ragService: RagService,
  tenantId: string,
) {
  return tool(
    async (input: { query: string; topK: number }) => {
      try {
        const knowledgeBases = await ragService.listKnowledgeBases(tenantId);
        if (knowledgeBases.length === 0) {
          return JSON.stringify({
            results: [],
            success: true,
            partialFailure: false,
            message: 'No knowledge bases found.',
          });
        }

        const orderedKbs = [...knowledgeBases].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        const candidateK = Math.min(
          20,
          Math.max(input.topK, MIN_CANDIDATES_PER_KB),
        );
        const outcomes = new Array<SearchOutcome>(orderedKbs.length);
        let nextIndex = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(MAX_CONCURRENT_KB_SEARCHES, orderedKbs.length) },
            async () => {
              while (nextIndex < orderedKbs.length) {
                const index = nextIndex++;
                const kb = orderedKbs[index];
                try {
                  const hits = await ragService.search(
                    kb.id,
                    tenantId,
                    input.query,
                    candidateK,
                    'hybrid',
                  );
                  outcomes[index] = { kb, hits };
                } catch (error) {
                  logger.warn(
                    `KB "${kb.name}" (${kb.id}) search failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  outcomes[index] = { kb, hits: [], error };
                }
              }
            },
          ),
        );

        const failures = outcomes
          .filter((outcome) => outcome.error !== undefined)
          .map(({ kb }) => ({
            knowledgeBaseId: kb.id,
            knowledgeBaseName: kb.name,
          }));
        const success = failures.length < orderedKbs.length;
        return JSON.stringify({
          results: mergeByLocalRank(outcomes, input.topK),
          success,
          partialFailure: failures.length > 0 && success,
          failedKnowledgeBases: failures,
          mergeStrategy: 'rank_interleave',
          ...(success
            ? {}
            : { message: 'All knowledge base searches failed.' }),
        });
      } catch (error) {
        logger.error(
          `RAG retrieval error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return JSON.stringify({
          results: [],
          success: false,
          partialFailure: false,
          error: 'Knowledge base retrieval failed.',
        });
      }
    },
    {
      name: 'rag_retrieval',
      description:
        'Search ALL knowledge bases for relevant information using Hybrid retrieval. Results are merged by local rank; localScore values are not comparable across knowledge bases. Use this for domain-specific knowledge or internal documents.',
      schema: z.object({
        query: z.string().trim().min(1).max(2048).describe('The search query'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe('Number of results to return'),
      }),
    },
  );
}
