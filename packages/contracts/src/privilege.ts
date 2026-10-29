/** IPC projection only; backend owns classification, routing and recovery. */
export interface PrivilegeFeedbackView {
  method: 'sudo' | 'ssh' | 'su';
  stage: 'preparation' | 'authentication' | 'authorization' | 'execution';
  code: 'authentication-required' | 'authentication-rejected' | 'authentication-unconfirmed' | 'authorization-denied'
    | 'sudo-unavailable' | 'cancelled' | 'timeout' | 'attempts-exhausted' | 'transport-unavailable' | 'unsupported';
  source: 'transport' | 'output-inference';
  businessCommand: 'not-started' | 'unknown';
  recovery: 'private-input' | 'confirm-alternative' | 'user-action' | 'verify';
}
