# Current context

This Bambu-only MCP server provides printer, account, slicing, model and monitoring workflows over stdio or streamable HTTP. This fork is based on upstream `4cadc9f7c84138382f215b3e254094fa66c6a689` (version `1.1.94`); its current work is unreleased. Follow [AGENTS.md](AGENTS.md), the public contracts in [INTERFACE.md](INTERFACE.md), and the decision record in [HISTORY.md](HISTORY.md).

## Runtime and account

Streamable HTTP uses bounded per-request protocol contexts over one shared backend. Cancellation is operation-scoped; shutdown does not guarantee a global drain, and uncertain mutations are not replayed. The optional stdio relay uses a private bearer and does not own the backend. The separately packaged Orca workspace and printer artifact store share an opaque workspace ID, but retain independent state and lifecycles. A workspace or an adopted artifact does not authorize printing.

The checkpoint branch also holds the [3D Printing plugin and shared skill](plugins/3d-printing/) and the [ZimaOS deployment source](deploy/zimaos/). The deployment describes the configured printer and slicer services, OAuth gateway, and data-only mounts. Its credential inputs and mutable volumes remain operator-owned.

Managed account login may store refresh credentials privately. Refresh is serialized and journaled before exchange; uncertain outcomes require a new login. Access-only sessions require a new sign-in to obtain refresh material. Independent installations must not share a rotating refresh pair. A complete explicit cloud credential tuple takes precedence and is not automatically refreshed. Managed account and shared-workspace locks require Python 3 and POSIX `fcntl`; no cross-host filesystem locking is promised. Actual account-token refresh has not been live-qualified.

## Printing and media

Signed MQTT control is opt-in, with separate application and device trust and persistent local counters. Managed signing provisioning supports a reviewed operator-supplied or automatically acquired official Handy package and preserves counters; automatic acquisition is not live-qualified. Account login does not supply application signing or native SDK sessions. See [signing provisioning](docs/signing-provisioning.md).

File-based print routes inspect the exact dispatched snapshot and selected plate, enforce fresh identity and hardware/material/safety checks, and preserve human-authorization rules. The signed MQTT route verifies uploaded size and SHA-256 before dispatch. The separately enabled cloud route uploads selected-plate project configuration and preview alongside the unchanged checked print file; cloud task creation and server-side cover processing have not been live-qualified. A selected X2D signed-cloud MQTT job reached completion with camera evidence; physical fit and wider compatibility remain unverified.

The explicitly confirmed completed-job reference route validates an owned successful original job, same printer, original nozzle assignments, fresh material/mapping and printer state. It does not reslice, inspect G-code bytes or establish byte identity. A durable printer-serial hold blocks subsequent starts or resume after dispatch until explicit human recovery; stop and heater-off remain available. No automatic hold clearance is claimed without stable collector epoch evidence. This reference route is not live-qualified.

Direct remote camera and file operations use packaged in-process TUTK networking, Node crypto, local media decoding and a shared operation lock. One selected printer has passed normal camera, listing and verified download reads. These do not prove broad device support or print readiness; remote mutations remain unqualified. See [remote media](docs/TUTK.md) and [wire references](docs/protocol/tutk-wire.md).

`get_printer_status` defaults to compact; `detail: "full"` requests the earlier detailed view. A fresh identity read is not a print preflight. Filament inventory separates account declarations, observed slots and uncertain matches; it does not measure physical stock. Agent guidance is available through `get_agent_guide` and `bambu://workflow/`; readiness describes prerequisites, not dispatch authorization.

## Evidence and constraints

The latest Linux full suite passed 1,879 tests with 39 skips; five additional focused opaque-account tests passed. These results and individual live reads do not establish a live refresh exchange, remote write, cloud-task dispatch, reference reprint, physical fit, or universal model and firmware support. A fresh-client slicer invocation and attachment handoff remain unverified. Public upstream integration requires the four-client Scan-to-Make impact audit.

Keep secrets and temporary login input private; never commit local account, signing or printer state. Preserve upstream authorship, Bambu-only scope and GPL-2.0-only licensing. Routine development does not operate a printer.
