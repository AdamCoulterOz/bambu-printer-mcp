import { AsyncLocalStorage } from "node:async_hooks";
const operations = new AsyncLocalStorage();
/** Cancellation follows the individual operation through shared queues and connection awaits. */
export function withOperationSignal(signal, run) {
    return operations.run(signal, run);
}
export function assertOperationActive() {
    operations.getStore()?.throwIfAborted();
}
