import type { Static } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { remoteFileEditParameters } from './remote-file-edit-schema.js';

/** Legacy callers must fail before a read, terminal allocation or approval. Keep
 * the schema only for compatibility; it cannot bypass C02's replacement refusal. */
export function createRemoteFileEditTool(_deps: RemoteToolDependencies, _gate: SafetyGate): BusinessTool<Static<typeof remoteFileEditParameters>> {
  return { name: 'edit_remote_file', label: 'Unavailable legacy file replacement', replay: 'never',
    available: () => false, parameters: remoteFileEditParameters,
    description: 'Unavailable: existing-file replacement lacks a metadata-preserving backend. Use prepare_remote_edit for a read-only diff, not a commit. Hashes, root/session changes, shell staging and delete/recreate are not exceptions.',
    execute: async (id) => blockedOperationFeedback(id, 'remote-edit-unsupported',
      'Existing-file commit is unavailable: ACL/xattr preservation cannot be verified. Use prepare_remote_edit only to preview; wait for a supported transaction or explicit manual handling. Do not bypass with shell staging, identity changes or delete/recreate. Nothing read or written.')
  };
}
