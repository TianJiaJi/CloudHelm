import { createProvider, envApiKeyAuth, type Model, type MutableModels } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai/compat';
import type { ThinkingLevel } from '@cloudhelm/core';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export interface ModelSelection { provider: string; modelId: string; baseUrl?: string; contextWindow?: number; maxTokens?: number }

/** A compatible endpoint cannot reliably advertise its model limits; use explicit, validated metadata. */
export function customModelLimits(selection: ModelSelection): { contextWindow: number; maxTokens: number } {
  if (selection.provider !== 'cloudhelm-custom') {
    if (selection.contextWindow !== undefined || selection.maxTokens !== undefined) throw new Error('内置模型容量由 Pi 模型目录提供');
    throw new Error('仅自定义模型可设置容量');
  }
  const contextWindow = selection.contextWindow ?? 32_000;
  const maxTokens = selection.maxTokens ?? 8192;
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens)
    || contextWindow < 2 || maxTokens < 1 || maxTokens > contextWindow) throw new Error('自定义模型容量无效');
  return { contextWindow, maxTokens };
}

/** The visible API-key catalog comes from the same Pi registry used at runtime. */
export function listModelProviders(): Array<{ id: string; name: string; defaultBaseUrl?: string; models: Array<{ id: string; name: string }> }> {
  const catalog = builtinModels();
  const providers = catalog.getProviders().filter((provider) => provider.auth.apiKey && catalog.getModels(provider.id).length);
  return [...providers.map((provider) => {
    const models = catalog.getModels(provider.id);
    return {
      id: provider.id, name: provider.name,
      defaultBaseUrl: provider.baseUrl || models[0]?.baseUrl || undefined,
      models: models.map((model) => ({ id: model.id, name: model.name }))
    };
  }), { id: 'cloudhelm-custom', name: '自定义 OpenAI 兼容', models: [] }];
}

export function createModelCatalog(selection: ModelSelection): MutableModels {
  const models = builtinModels();
  if (selection.provider !== 'cloudhelm-custom') {
    const provider = models.getProvider(selection.provider);
    if (provider && selection.baseUrl) {
      const baseUrl = validModelUrl(selection.baseUrl);
      models.setProvider({
        ...provider, baseUrl,
        getModels: () => provider.getModels().map((model) => ({ ...model, baseUrl })),
        getAllModels: provider.getAllModels
          ? () => provider.getAllModels!().map((model) => ({ ...model, baseUrl }))
          : undefined
      });
    }
    return models;
  }
  if (!selection.baseUrl) throw new Error('Custom model URL is required');
  const baseUrl = validModelUrl(selection.baseUrl);
  const model: Model<'openai-completions'> = {
    id: selection.modelId, name: selection.modelId, provider: 'cloudhelm-custom', api: 'openai-completions',
    baseUrl, input: ['text'], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...customModelLimits(selection)
  };
  models.setProvider(createProvider({ id: 'cloudhelm-custom', name: 'Custom OpenAI compatible',
    baseUrl: model.baseUrl, auth: { apiKey: envApiKeyAuth('Custom API Key', []) }, models: [model], api: openAICompletionsApi() }));
  return models;
}

export function modelThinking(selection: ModelSelection, preferred: ThinkingLevel = 'off') {
  const model = createModelCatalog(selection).getModel(selection.provider, selection.modelId);
  if (!model) throw new Error('所选模型不可用');
  return { levels: model.reasoning ? getSupportedThinkingLevels(model) : [], selected: clampThinkingLevel(model, preferred) };
}

export function validModelUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Model API address must use HTTPS or local HTTP');
  }
  return url.toString().replace(/\/$/u, '');
}
