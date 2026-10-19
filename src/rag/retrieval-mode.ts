import { z } from 'zod';

export const RetrievalModeSchema = z.enum(['dense_v2', 'bm25', 'hybrid']);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = 'dense_v2';
