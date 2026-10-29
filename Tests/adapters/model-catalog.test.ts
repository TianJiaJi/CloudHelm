import { describe, expect, it } from 'vitest';
import { createModelCatalog, listModelProviders, modelCapacity, modelThinking } from '../../packages/adapters/src/model-catalog.js';

describe('Pi model catalog settings', () => {
  it('uses explicit custom capacity and rejects invalid or fabricated limits', () => {
    const selection = { provider: 'cloudhelm-custom', modelId: 'large', baseUrl: 'https://example.com/v1' };
    expect(createModelCatalog({ ...selection, contextWindow: 1_000_000, maxTokens: 384_000 })
      .getModel('cloudhelm-custom', 'large')).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 });
    expect(createModelCatalog(selection).getModel('cloudhelm-custom', 'large'))
      .toMatchObject({ contextWindow: 32_000, maxTokens: 8192 });
    for (const [contextWindow, maxTokens] of [[10, 11], [0, 1], [10, -1], [Number.NaN, 1], [10, 1.5]]) {
      expect(() => createModelCatalog({ ...selection, contextWindow, maxTokens })).toThrow('容量无效');
    }
  });

  it('reports real capacity provenance without inferring custom reasoning support from its name', () => {
    const selection = { provider: 'cloudhelm-custom', modelId: 'deep-reasoning-pro', baseUrl: 'https://example.com/v1' };
    expect(modelCapacity(selection)).toEqual({ contextWindow: 32000, maxOutputTokens: 8192, source: 'custom-settings' });
    expect(modelCapacity({ ...selection, contextWindow: 64000, maxTokens: 16000 })).toEqual({ contextWindow: 64000, maxOutputTokens: 16000, source: 'custom-settings' });
    expect(modelThinking(selection, 'high').levels).toEqual([]);
    const provider = listModelProviders().find((item) => item.id === 'deepseek')!;
    const builtin = modelCapacity({ provider: provider.id, modelId: provider.models[0]!.id });
    expect(builtin.source).toBe('catalog'); expect(builtin.contextWindow).toBeGreaterThan(0); expect(builtin.maxOutputTokens).toBeGreaterThan(0);
  });
  it('provides a prefilled URL and uses a provider-specific override for model requests', () => {
    const provider = listModelProviders().find((item) => item.id === 'deepseek');
    expect(provider?.defaultBaseUrl).toBe('https://api.deepseek.com');
    const modelId = provider?.models[0]?.id;
    expect(modelId).toBeTruthy();
    const configured = createModelCatalog({ provider: 'deepseek', modelId: modelId!, baseUrl: 'https://proxy.example/v1' });
    expect(configured.getModel('deepseek', modelId!)?.baseUrl).toBe('https://proxy.example/v1');
    expect(createModelCatalog({ provider: 'deepseek', modelId: modelId! }).getModel('deepseek', modelId!)?.baseUrl)
      .toBe('https://api.deepseek.com');
  });
});
