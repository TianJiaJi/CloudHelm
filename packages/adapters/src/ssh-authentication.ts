import { readFile } from 'node:fs/promises';
import ssh2, { type AnyAuthMethod, type AuthHandlerMiddleware, type ParsedKey } from 'ssh2';

export interface SshLoginPrompt {
  hostId: string;
  username: string;
  text: string;
  echo: boolean;
  kind?: 'password' | 'key-passphrase' | 'keyboard-interactive';
  attempt?: number;
}
export type SshLoginChallenge = (prompt: SshLoginPrompt) => Promise<string | null>;
export class SshAuthenticationError extends Error {
  constructor(readonly code: 'cancelled' | 'attempts-exhausted' | 'authentication-rejected' | 'authentication-unconfirmed') {
    super(`SSH authentication stopped (${code})`);
  }
}

/** Used only by explicitly selected on-demand connections. 'none' is tried first;
 * configured credentials are candidates, never a reason to prompt in advance.
 * Auth callbacks run after SSH's host-key verification and method negotiation. */
export function onDemandAuthHandler(options: {
  host: { id: string; username: string; auth: 'agent' | 'private-key' | 'password'; privateKeyPath?: string;
    connection?: { authOrder?: Array<'private-key' | 'password' | 'keyboard-interactive'> } };
  material: { password?: string; passphrase?: string };
  challenge?: SshLoginChallenge;
  assertActive(): void;
  fail(error: Error): void;
}): AuthHandlerMiddleware {
  const { host } = options;
  let initial = true, keyTried = false, passwords = 0, keyboardRounds = 0, keyboardPrompts = 0;
  const ask = async (kind: NonNullable<SshLoginPrompt['kind']>, attempt: number, text: string, echo = false) => {
    options.assertActive();
    if (!options.challenge) throw new SshAuthenticationError('authentication-unconfirmed');
    const answer = await options.challenge({ hostId: host.id, username: host.username, text, echo, kind, attempt });
    options.assertActive();
    if (answer === null) throw new SshAuthenticationError('cancelled');
    if (answer.length > 4096) throw new SshAuthenticationError('authentication-unconfirmed');
    return answer;
  };
  const readKey = async (): Promise<ParsedKey> => {
    if (!host.privateKeyPath) throw new SshAuthenticationError('authentication-unconfirmed');
    options.assertActive();
    const bytes = await readFile(host.privateKeyPath);
    try {
      options.assertActive();
      const parse = (phrase?: string) => {
        // ssh2 is CommonJS: utils is not a native ESM named export.
        const result = ssh2.utils.parseKey(bytes, phrase);
        return Array.isArray(result) ? result[0] : result;
      };
      let parsed = parse();
      if (parsed && !(parsed instanceof Error)) return parsed;
      // A local parser's specific encrypted-key result is the challenge, not host.auth.
      if (!(parsed instanceof Error) || !/encrypted.*no passphrase/iu.test(parsed.message))
        throw new SshAuthenticationError('authentication-unconfirmed');
      for (let attempt = 1; attempt <= 3; attempt++) {
        const phrase = attempt === 1 && options.material.passphrase !== undefined ? options.material.passphrase
          : await ask('key-passphrase', attempt, 'Encrypted SSH private key requires its passphrase');
        parsed = parse(phrase);
        options.assertActive();
        if (parsed && !(parsed instanceof Error)) return parsed;
      }
      throw new SshAuthenticationError('attempts-exhausted');
    } finally { bytes.fill(0); }
  };
  const choose = async (methods: string[] | null): Promise<AnyAuthMethod> => {
    options.assertActive();
    if (initial) { initial = false; return { type: 'none', username: host.username }; }
    if (!Array.isArray(methods)) throw new SshAuthenticationError('authentication-unconfirmed');
    const defaults = host.auth === 'password' ? ['password', 'keyboard-interactive', 'private-key'] : ['private-key', 'password', 'keyboard-interactive'];
    const order = [...new Set([...(host.connection?.authOrder ?? []), ...defaults])];
    const selected = order.find((method) => method === 'private-key'
      ? !keyTried && methods.includes('publickey') && (host.auth === 'private-key' || !!host.privateKeyPath && !!host.connection?.authOrder?.includes('private-key'))
      : methods.includes(method));
    if (selected === 'private-key') {
      keyTried = true;
      return { type: 'publickey', username: host.username, key: await readKey() };
    }
    if (selected === 'password') {
      if (++passwords > 3) throw new SshAuthenticationError('attempts-exhausted');
      const password = passwords === 1 && options.material.password !== undefined ? options.material.password
        : await ask('password', passwords, 'SSH server requested password authentication');
      return { type: 'password', username: host.username, password };
    }
    if (selected === 'keyboard-interactive') {
      if (++keyboardRounds > 3) throw new SshAuthenticationError('attempts-exhausted');
      return { type: 'keyboard-interactive', username: host.username, prompt(_name, _instructions, _lang, prompts, finish) {
        void (async () => {
          if (prompts.length > 3) throw new SshAuthenticationError('authentication-unconfirmed');
          const answers: string[] = [];
          for (const prompt of prompts) {
            if (++keyboardPrompts > 3) throw new SshAuthenticationError('attempts-exhausted');
            answers.push(await ask('keyboard-interactive', keyboardPrompts, prompt.prompt, !!prompt.echo));
          }
          options.assertActive(); finish(answers);
        })().catch((error: unknown) => options.fail(error instanceof SshAuthenticationError ? error : new SshAuthenticationError('authentication-unconfirmed')));
      } };
    }
    throw new SshAuthenticationError('authentication-rejected');
  };
  return (methods, _partial, next) => {
    void choose(methods).then((method) => { options.assertActive(); next(method); })
      .catch((error: unknown) => options.fail(error instanceof SshAuthenticationError ? error : new SshAuthenticationError('authentication-unconfirmed')));
  };
}
