import { AsyncLocalStorage } from "node:async_hooks";
import { withOperationSignal } from "./operation-context.js";
const requests = new AsyncLocalStorage();
const cancellations = new WeakMap();
export function trackRequest(server, id) {
    let tracked = cancellations.get(server);
    if (!tracked) {
        tracked = new Map();
        cancellations.set(server, tracked);
    }
    tracked.set(id, new AbortController());
}
export function aliasRequest(server, original, internal) {
    const tracked = cancellations.get(server);
    const controller = tracked?.get(original);
    if (controller)
        tracked.set(internal, controller);
}
export function cancelTrackedRequest(server, id) {
    cancellations.get(server)?.get(id)?.abort(new Error("MCP request cancelled."));
}
export function forgetRequest(server, id) {
    cancellations.get(server)?.delete(id);
}
export function cancelSessionRequests(server) {
    for (const controller of cancellations.get(server)?.values() ?? [])
        controller.abort(new Error("MCP session closed."));
    cancellations.delete(server);
}
/** One shared backend, with ownership retained through queues and asynchronous callbacks. */
export function withRequestOwner(server, extra, run) {
    const own = cancellations.get(server)?.get(extra.requestId)?.signal;
    // Every HTTP operation combines its own lifetime with SDK/session cancellation.
    if (own)
        extra.signal = AbortSignal.any([extra.signal, own]);
    const signal = extra.signal;
    return requests.run({ server, signal, requestId: extra.requestId }, () => withOperationSignal(signal, run));
}
export function requestOwner() {
    const owner = requests.getStore();
    if (!owner)
        throw new Error("No requesting MCP client owns this confirmation. No command was sent.");
    owner.signal.throwIfAborted();
    return owner;
}
