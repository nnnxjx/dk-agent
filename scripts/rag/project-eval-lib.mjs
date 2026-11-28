import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const datasetDir = resolve('datasets/rag/project-docs/v1');
export const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export async function writeJson(path, data) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

// 标准来自事先标注的原文，绝不从当前检索结果反向生成。
export async function loadDataset() {
  const manifest = await readJson(resolve(datasetDir, 'manifest.json'));
  const raw = await readFile(resolve(datasetDir, 'questions.jsonl'), 'utf8');
  const questions = raw.trim().split(/\r?\n/).map(JSON.parse);
  const documents = [];
  for (const source of manifest.sources) {
    const content = await readFile(resolve(datasetDir, source.path), 'utf8');
    if (hash(content) !== source.sha256) throw new Error(`Source changed: ${source.path}`);
    documents.push({ ...source, content });
  }
  if (questions.length !== manifest.questionCount || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Question count/IDs changed');
  const families = new Map();
  for (const q of questions) {
    if (q.noAnswer !== false || !q.expectedAnswer || !q.points?.length || !q.evidence?.length || !['dev', 'test'].includes(q.split)) throw new Error(`Invalid answerable label: ${q.id}`);
    if (families.has(q.familyId) && families.get(q.familyId) !== q.split) throw new Error(`Family split leakage: ${q.familyId}`);
    families.set(q.familyId, q.split);
    for (const evidence of q.evidence) {
      const source = documents.find(d => d.path === evidence.source);
      if (!source || !evidence.quote.trim() || !normalize(source.content).includes(normalize(evidence.quote))) throw new Error(`Missing source evidence: ${q.id}`);
      if (!source.content.split('\n')[evidence.line - 1]?.includes(evidence.quote)) throw new Error(`Evidence line mismatch: ${q.id}`);
    }
  }
  for (const split of ['dev', 'test']) if (questions.filter(q => q.split === split).length !== manifest.split[split]) throw new Error('Split count changed');
  return { manifest, documents, questions, signature: hash(JSON.stringify({ manifest, raw })) };
}

// 来源与原文必须同时匹配。重复内容合并后检查 sources 中的原始来源。
export function evidenceCoverage(question, hits) {
  return question.evidence.map(e => ({ ...e, found: hits.some(h => {
    const sources = h.sources || [{ metadata: h.metadata }];
    return sources.some(s => s.metadata?.source === basename(e.source)) && normalize(h.text).includes(normalize(e.quote));
  }) }));
}
export function retrievalMetrics(rows) {
  const mean = (key) => rows.length ? rows.reduce((sum, r) => sum + (r.error ? 0 : Number(r[key])), 0) / rows.length : null;
  const times = rows.filter(r => !r.error).map(r => r.elapsedMs).sort((a,b) => a-b);
  return { questionCount: rows.length, failedCount: rows.filter(r => r.error).length, hitRate: mean('hit'), evidenceRecall: mean('evidenceRecall'), completeEvidenceRate: mean('completeEvidence'), mergeLostCases: rows.filter(r => r.mergeLostEvidence).map(r => r.id), p95Ms: times.length ? times[Math.ceil(times.length*.95)-1] : null };
}
