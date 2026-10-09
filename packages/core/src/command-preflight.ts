/** Transport explicitly confirmed that the business command was never dispatched. */
export class CommandNotStartedError extends Error {
  constructor(message: string) { super(message); this.name = 'CommandNotStartedError'; }
}
