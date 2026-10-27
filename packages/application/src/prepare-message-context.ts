import { documentText, type ContentModelPort, type InputPreparationContext, type MessageDocument, type ReferenceBody } from '@cloudhelm/core';
import { prepareMessage } from './prepare-message.js';

/** One bounded preparation on the existing send path; no queue, turn replay,
 * task-state promotion or implicit budget replenishment. */
export async function prepareMessageWithContext(document: MessageDocument, bodies: ReferenceBody[], model: ContentModelPort,
  context: InputPreparationContext, signal: AbortSignal, progress: (id: string) => void = () => {}) {
  signal.throwIfAborted();
  let snapshot = structuredClone(context.snapshot());
  const assertCapacity = () => {
    if (model.contextWindow !== snapshot.budget.contextWindow || model.reserveTokens !== snapshot.budget.outputReserve)
      throw new Error('模型容量已变化，请重新准备消息');
  };
  assertCapacity();
  const requested = model.estimate(documentText(document.parts, new Map(bodies.map((body) => [body.reference.id, { ...body, summary: undefined }]))));
  if (requested > snapshot.budget.availableInput && (!snapshot.modelIdle || !snapshot.remoteIdle))
    throw new Error('会话或远端仍在运行，消息暂时放不下；请稍后发送或缩小引用范围');
  const substantialHistory = snapshot.historyTokens >= Math.max(2048, snapshot.budget.contextWindow / 4)
    && snapshot.budget.usedTokens >= snapshot.budget.contextWindow / 4;
  if (requested > snapshot.budget.availableInput && snapshot.hasHistory && substantialHistory && snapshot.modelIdle && snapshot.remoteIdle) {
    await context.compact(signal);
    signal.throwIfAborted();
    const after = structuredClone(context.snapshot());
    if (after.revision === snapshot.revision) throw new Error('上下文整理未产生可核验的变化');
    snapshot = after;
    assertCapacity();
    if (snapshot.budget.availableInput < 256) throw new Error('整理后输入空间仍不足，请缩小引用范围或开始新对话');
  }
  const prepared = await prepareMessage(document, bodies, model, snapshot.budget.usedTokens + snapshot.budget.safetyMargin, signal, progress);
  signal.throwIfAborted();
  const current = context.snapshot();
  if (current.revision !== snapshot.revision || current.budget.contextWindow !== snapshot.budget.contextWindow
    || current.budget.outputReserve !== snapshot.budget.outputReserve) throw new Error('活动上下文已变化，消息未投递，请重新发送');
  return { ...prepared, contextRevision: current.revision };
}
