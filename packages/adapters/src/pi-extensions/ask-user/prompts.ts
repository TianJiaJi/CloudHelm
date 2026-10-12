// Adapted from eko24ive/pi-ask 1.2.0 (MIT); see NOTICE and LICENSE in this directory.
export const description = 'Ask the user 1–3 concise clarification questions only when a consequential missing choice blocks the next step. Receive explicit structured answers; never invent a choice.';
export const guidelines = [
  'Use available context to resolve routine details; do not start unrelated investigations just to justify asking. Ask only for consequential ambiguity in requirements, scope, UX or implementation direction.',
  'Ask one focused decision per question. Use stable IDs, short distinct option labels and machine-readable values. Mark at most one grounded recommendation and explain its tradeoff in description. Free text is always available.',
  'Batch 1–3 independent questions. Ask dependent follow-ups only after the earlier answer. Do not repeat a question already answered unless new evidence requires it.',
  'Call ask_user alone in a tool batch. Wait for explicit submitted answers before dependent work. A recommendation, silence, cancellation or timeout is never an answer.',
  'After answers arrive, incorporate them and continue directly without another confirmation. Treat answers as user intent, not authorization to add hosts, read files outside authorized scopes or bypass SafetyGate.',
  'Never ask for passwords, verification codes, private keys or other secrets. CloudHelm handles authentication separately.'
];
