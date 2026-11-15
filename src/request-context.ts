import { AsyncLocalStorage } from "node:async_hooks";
import { withOperationSignal } from "./operation-context.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

const requests = new AsyncLocalStorage<{ server: Server; signal: AbortSignal }>();
const cancellations = new WeakMap<Server, Map<RequestId, AbortController>>();
export function trackRequest(server: Server, id: RequestId): void {
  let tracked = cancellations.get(server);
  if (!tracked) { tracked = new Map(); cancellations.set(server, tracked); }
  tracked.set(id, new AbortController());
}
export function aliasRequest(server: Server, original: RequestId, internal: RequestId): void {
  const tracked = cancellations.get(server);
  const controller = tracked?.get(original);
  if (controller) tracked!.set(internal, controller);
}
export function cancelTrackedRequest(server: Server, id: RequestId): void {
  cancellations.get(server)?.get(id)?.abort(new Error("MCP request cancelled."));
}
export function forgetRequest(server: Server, id: RequestId): void {
  cancellations.get(server)?.delete(id);
}
export function cancelSessionRequests(server: Server): void {
  for (const controller of cancellations.get(server)?.values() ?? []) controller.abort(new Error("MCP session closed."));
  cancellations.delete(server);
}
/** One shared backend, with ownership retained through queues and asynchronous callbacks. */
export function withRequestOwner<T>(server: Server, extra: { signal: AbortSignal; requestId: RequestId }, run: () => T): T {
  const own = cancellations.get(server)?.get(extra.requestId)?.signal;
  // Every HTTP operation combines its own lifetime with SDK/session cancellation.
  if (own) extra.signal = AbortSignal.any([extra.signal, own]);
  const signal = extra.signal;
  return requests.run({ server, signal }, () => withOperationSignal(signal, run));
}
export function requestOwner(): { server: Server; signal: AbortSignal } {
  const owner = requests.getStore();
  if (!owner) throw new Error("No requesting MCP client owns this confirmation. No command was sent.");
  owner.signal.throwIfAborted();
  return owner;
}
