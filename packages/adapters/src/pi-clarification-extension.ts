import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createEventBus, DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, wrapRegisteredTools } from '@earendil-works/pi-coding-agent';
import type { ClarificationPort } from '@cloudhelm/core';
import askUser, { ASK_CHANNEL, type AskBridgeEvent } from './pi-extensions/ask-user/index.js';

/** Only the bundled extension is loaded. No user/project Pi config, tools or credentials are inherited. */
export async function loadClarificationExtension(port: ClarificationPort) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-pi-'));
  try {
    const bus = createEventBus();
    bus.on(ASK_CHANNEL, (data: unknown) => {
      const event = data as AskBridgeEvent;
      event.response = port.ask(event.toolCallId, event.questions, event.signal);
    });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
      settingsManager: SettingsManager.inMemory({ packages: [] }), eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: '@cloudhelm/pi-ask-user', factory: askUser }] });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length) throw new Error(`Pi 澄清插件加载失败：${loaded.errors.map((error) => error.error).join('; ')}`);
    const registered = loaded.extensions.flatMap((extension) => [...extension.tools.values()]);
    if (registered.length !== 1 || registered[0]?.definition.name !== 'ask_user') throw new Error('Pi 澄清插件工具注册不完整');
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, SessionManager.inMemory(directory), new ModelRegistry(models));
    return { tools: wrapRegisteredTools(registered, runner),
      prompt: registered.flatMap(({ definition }) => [definition.promptSnippet ?? '', ...(definition.promptGuidelines ?? [])]).join('\n') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
