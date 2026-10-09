import { documentText, type ContentModelPort, type MessageDocument, type ReferenceBody } from '@cloudhelm/core';

/** Compress only when the assembled request exceeds the available model budget. */
export async function prepareMessage(document: MessageDocument, originals: ReferenceBody[], model: ContentModelPort,
  usedTokens: number, signal: AbortSignal, progress: (id: string) => void = () => {}) {
  const bodies = new Map(originals.map((body) => [body.reference.id, { ...body, summary: undefined as string | undefined }]));
  const budget = Math.floor(model.contextWindow - model.reserveTokens - Math.max(0, usedTokens));
  if (budget < 256) throw new Error('当前对话上下文不足，请先整理上下文或开始新对话');
  const question = document.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
  const textOnly = model.estimate(question);
  if (textOnly >= budget) throw new Error('问题文字超过模型上下文容量，请缩短问题');
  const candidates = [...bodies.values()].sort((a, b) => model.estimate(b.original) - model.estimate(a.original));
  for (const body of candidates) {
    signal.throwIfAborted();
    if (model.estimate(documentText(document.parts, bodies)) <= budget) break;
    progress(body.reference.id);
    const other = model.estimate(documentText(document.parts, new Map([...bodies].map(([id, item]) => [id,
      id === body.reference.id ? { ...item, original: '', summary: '' } : item]))));
    const target = Math.max(128, Math.min(Math.floor((budget - textOnly) / Math.max(1, bodies.size) / 2), budget - other - 128));
    body.summary = await summarizeChunks(body.original, question, target, model, signal);
  }
  signal.throwIfAborted();
  const text = documentText(document.parts, bodies);
  if (model.estimate(text) > budget) throw new Error('压缩后仍超过上下文容量，请缩小引用范围或开始新对话');
  // Terminal evidence must never enter the SafetyGate's user-intent field.
  const intent = document.parts.map((part) => part.type === 'text' ? part.text : part.reference.kind === 'paste'
    ? bodies.get(part.reference.id)!.summary ?? bodies.get(part.reference.id)!.original : '').join('').trim() || '请分析这段终端输出';
  return { text, intent, bodies: [...bodies.values()], document: { ...document, parts: document.parts.map((part) => part.type === 'text' ? part : {
    type: 'reference' as const, reference: { ...bodies.get(part.reference.id)!.reference, summarized: !!bodies.get(part.reference.id)!.summary }
  }) } };
}

async function summarizeChunks(original: string, question: string, target: number, model: ContentModelPort, signal: AbortSignal): Promise<string> {
  const capacity = Math.floor(model.contextWindow - model.reserveTokens - model.estimate(question) - 1024);
  if (capacity < 256) throw new Error('模型上下文不足以压缩这份资料');
  let text = original;
  for (let round = 0; round < 8; round++) {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let lo = start + 1, hi = text.length, end = start;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (model.estimate(text.slice(start, mid)) <= capacity) { end = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (end === start) throw new Error('无法将内容拆分到模型容量内');
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      chunks.push(text.slice(start, end)); start = end;
    }
    const summaries: string[] = [];
    for (const chunk of chunks) {
      signal.throwIfAborted();
      const summary = await model.summarize(chunk, question, target, signal);
      if (!summary.trim()) throw new Error('模型未返回有效总结，请重试');
      summaries.push(summary);
    }
    const combined = summaries.join('\n\n');
    if (model.estimate(combined) <= target) return combined;
    if (model.estimate(combined) >= model.estimate(text)) throw new Error('模型未有效压缩内容，请重试');
    text = combined;
  }
  throw new Error('内容过大，压缩未能完成，请缩小范围');
}
