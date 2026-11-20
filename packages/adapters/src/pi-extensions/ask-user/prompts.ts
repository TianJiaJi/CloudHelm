// Adapted from eko24ive/pi-ask 1.2.0 (MIT); see NOTICE and LICENSE in this directory.
export const description = 'Ask the user 1–3 concise clarification questions only when a consequential missing choice blocks the next step. Receive explicit structured answers and act only on what the user actually chose.';
export const guidelines = [
  'Use available context to resolve routine details, and keep questions to consequential ambiguity in requirements, scope, UX or implementation direction.',
  'Ask one focused decision per question. Use stable IDs, short distinct option labels and machine-readable values. Mark at most one grounded recommendation and explain its tradeoff in description. Free text is always available.',
  'Batch 1–3 independent questions. Ask dependent follow-ups only after the earlier answer, and revisit an answered question only when new evidence requires it.',
  'Call ask_user alone in a tool batch. Wait for explicit submitted answers before dependent work. Treat a recommendation, silence, cancellation or timeout as unanswered.',
  'After answers arrive, incorporate them and continue directly without another confirmation. Treat answers as user intent; authorization for hosts, scopes and SafetyGate review comes only from the backend projection.',
  'CloudHelm handles authentication separately: direct the user to the private authentication channel for passwords, verification codes, private keys or other secrets.'
];
