import { AsyncLocalStorage } from "node:async_hooks";

const operations = new AsyncLocalStorage<AbortSignal>();
/** Cancellation follows the individual operation through shared queues and connection awaits. */
export function withOperationSignal<T>(signal: AbortSignal, run: () => T): T {
  return operations.run(signal, run);
}
export function assertOperationActive(): void {
  operations.getStore()?.throwIfAborted();
}
