export interface ClarificationQuestion {
  id: string;
  prompt: string;
  options?: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
}
export interface ClarificationAnswer { id: string; value: string; custom?: boolean }
export interface ClarificationRequest {
  id: string; taskId: string; toolCallId: string; generation: string;
  questions: ClarificationQuestion[]; createdAt: number; expiresAt: number;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  answers?: ClarificationAnswer[];
}
export interface ClarificationPort {
  ask(toolCallId: string, questions: ClarificationQuestion[], signal?: AbortSignal): Promise<ClarificationAnswer[]>;
}

const credentialQuestion = /(?:password|passphrase|验证码|密码|私钥|密钥|口令|one.time.password|api[ _-]?key|access[ _-]?token)/iu;
const secretValue = /(?:-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|(?:password|api_key|access_token)\s*[:=])/iu;
export function validateQuestions(input: unknown): asserts input is ClarificationQuestion[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error('每次需要 1–3 个问题');
  const ids = new Set<string>();
  for (const q of input) {
    if (!q || typeof q.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(q.id) || ids.has(q.id)
      || typeof q.prompt !== 'string' || !q.prompt.trim() || q.prompt.length > 1000) throw new Error('问题格式无效或 ID 重复');
    ids.add(q.id);
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5) throw new Error('选项需要 2–5 项');
      const values = new Set<string>();
      for (const option of q.options) {
        if (!option || typeof option.value !== 'string' || !option.value.trim() || option.value.length > 100 || values.has(option.value)
          || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 150
          || (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 500))
          || (option.recommended !== undefined && typeof option.recommended !== 'boolean')) throw new Error('选项格式无效或值重复');
        values.add(option.value);
      }
      if (q.options.filter((o: { recommended?: boolean }) => o.recommended).length > 1) throw new Error('只能推荐一个选项');
    }
    if (credentialQuestion.test(JSON.stringify(q))) throw new Error('需求澄清不能索取凭据，请使用独立认证流程');
  }
}

export function normalizeAnswers(questions: ClarificationQuestion[], input: unknown): ClarificationAnswer[] {
  if (!Array.isArray(input) || input.length !== questions.length) throw new Error('请回答每个问题');
  const ids = new Set<string>();
  for (const answer of input) {
    if (!answer || typeof answer.id !== 'string' || ids.has(answer.id) || !questions.some((q) => q.id === answer.id)
      || typeof answer.value !== 'string' || !answer.value.trim() || answer.value.length > 4000
      || (answer.custom !== undefined && typeof answer.custom !== 'boolean')) throw new Error('回答格式无效');
    if (secretValue.test(answer.value)) throw new Error('请勿在需求回答中填写密码、验证码或密钥');
    ids.add(answer.id);
  }
  return questions.map((question) => {
    const answer = input.find((a) => a.id === question.id)!;
    if (question.options?.length && !answer.custom && !question.options.some((option) => option.value === answer.value)) throw new Error('选项已失效，请重新选择');
    return { id: question.id, value: answer.value.trim(), custom: !question.options?.length || !!answer.custom };
  });
}
