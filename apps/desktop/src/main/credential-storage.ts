import { safeStorage } from 'electron';
import type { SqliteStore } from '@cloudhelm/adapters';

type SecretRecords = Pick<SqliteStore, 'get'>;

/** Configuration presence is not proof that the OS can decrypt or the provider accepts a key. */
export function secretConfigured(store: SecretRecords, id: string): boolean {
  const ciphertext = store.get<unknown>('secrets', id);
  return typeof ciphertext === 'string' && ciphertext.length > 0;
}

export class CredentialUnavailableError extends Error {
  constructor() {
    super('OS credential decryption is unavailable; re-enter the credential in settings');
    this.name = 'CredentialUnavailableError';
  }
}

export function encryptSecret(value: string): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable');
    return safeStorage.encryptString(value).toString('base64');
  } catch {
    // Native errors may contain platform or credential details. Never forward them to logs/IPC.
    throw new Error('OS credential encryption is unavailable');
  }
}

export function decryptSecret(store: SecretRecords, id: string): string | undefined {
  const ciphertext = store.get<string>('secrets', id);
  if (!ciphertext) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new CredentialUnavailableError();
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  } catch {
    throw new CredentialUnavailableError();
  }
}
