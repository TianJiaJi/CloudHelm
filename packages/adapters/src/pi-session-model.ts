import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SessionProfile } from '@cloudhelm/core';
import { createModelCatalog } from './model-catalog.js';

export function resolveSessionModel(profile: SessionProfile) {
  if (!profile.apiKey.trim()) throw new Error('模型 API Key 未配置');
  const catalog = createModelCatalog(profile);
  const model = catalog.getModel(profile.provider, profile.modelId);
  const provider = catalog.getProvider(profile.provider);
  if (!model || !provider) throw new Error('所选模型不在 Pi 模型目录中');
  return { profile: { ...profile }, model, provider, catalog };
}
export async function isolatedModelRuntime(profile: SessionProfile) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  const auth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (model, overrides) => typeof model === 'string'
    ? auth(model, { ...overrides, env: {} }) : auth(model, { ...overrides, env: {} });
  await installSessionModel(runtime, profile);
  return runtime;
}
export async function installSessionModel(runtime: ModelRuntime, profile: SessionProfile) {
  const resolved = resolveSessionModel(profile);
  runtime.registerNativeProvider(resolved.provider);
  await runtime.setRuntimeApiKey(profile.provider, profile.apiKey);
  return resolved;
}
export async function testModelConnection(profile: SessionProfile): Promise<{ latencyMs: number }> {
  const { catalog, model } = resolveSessionModel(profile);
  const start = Date.now();
  const result = await catalog.completeSimple(model, {
    messages: [{ role: 'user', content: 'Reply with OK.', timestamp: start }]
  }, { apiKey: profile.apiKey, env: {}, maxRetries: 0, maxTokens: 64, signal: AbortSignal.timeout(20_000) });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('模型连接测试失败，请检查 Key、地址和模型权限');
  return { latencyMs: Date.now() - start };
}
