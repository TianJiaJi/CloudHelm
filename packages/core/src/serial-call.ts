/**
 * Runs async calls strictly one at a time in arrival order. A second call waits
 * for the first to fully finish before it starts, so remote proposals, reviews
 * and executions never overlap even when the model emits parallel tool calls.
 */
export function serialCall<Args extends unknown[], T>(
  call: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (...args: Args) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await call(...args);
    } finally {
      release();
    }
  };
}
