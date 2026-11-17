# Decision history

## 2026-11-21 — Managed account and fork checkpoint

Managed account authority supports private refresh material and journaled rotation. Authenticated account and printer reads passed for one selected printer; an actual refresh exchange remains unqualified. The Linux suite passed 1,879 tests with 39 skips, followed by five focused opaque-account tests. This checkpoint is not an upstream release.

## 2026-11-20 — Completed-job references and account expansion

Added bounded printer-filtered history pages, owned-task thumbnails, account filament operations and an explicitly confirmed completed-job reference print. The reference route requires verified ownership, original nozzle bindings, fresh printer/material/mapping checks and human confirmation; it does not reslice or claim byte inspection. Durable serial-scoped holds prevent new starts after an uncertain handoff until explicitly recovered. Cloud task, reference-print and remote write qualification remains separate from synthetic tests.

## 2026-11-20 — Direct remote networking

Replaced the proposed companion-service boundary with in-process TUTK networking and standard runtime cryptography. The remote path retains account binding, application proof, shared locking, bounded media and artifact checks. Out-of-order completed CTRL frames motivated bounded ordered reassembly without skipping gaps or replaying requests. Camera, file listing and checked download passed normal read paths on one selected printer; this is not universal device qualification.

## 2026-11-20 — Signing and cloud dispatch

Added provisioning from an exactly reviewed official Handy package while retaining manual PEM import, independent device trust and persistent counters. Optional cloud dispatch uploads a selected-plate configuration and preview with the checked print file and sends a single task POST; it does not add an MQTT dispatch or replay uncertain mutations. Automatic package acquisition, cloud dispatch and server cover processing remain unqualified by live execution.

## 2026-11-18 — Inventory and status

Separated account library data from printer-reported filament slots and represented uncertain matches and quantities explicitly. Compact status became the default; callers needing legacy detailed telemetry must request it. Fresh observed identity remains distinct from display status and print readiness.

## 2026-11-17 — Operation and workspace ownership

Superseded the earlier stateful HTTP session design with operation-scoped protocol contexts over a shared backend; continuation, cancellation and cleanup do not create per-agent printer sessions. The optional artifact store and separately owned Orca service use explicit shared workspace IDs with independent ledgers, isolated lifecycles and data-only exchange. File adoption does not authorize a print. Isolated slice, export, adoption, checkpoint and restore were exercised; fresh-client attachment handoff remains unverified.

## 2026-11-16 — Signed project route and safety

Added capability-gated internal-storage transfer and exact readback before signed MQTT project dispatch. One X2D upload and a signed-cloud MQTT job reached completion with camera evidence; physical fit and support on other configurations remain unverified. Native-helper timeouts remain uncertain without an unambiguous receipt. Fresh identity, error, hardware and material gates remain authoritative and uncertain dispatches are not automatically replayed.

## 2026-11-15 — Fork, signing and agent discovery

Forked `DMontgomery40/bambu-printer-mcp` at upstream commit `4cadc9f7c84138382f215b3e254094fa66c6a689`, preserving upstream authorship, Bambu-only scope and GPL-2.0-only licensing. Added opt-in signed MQTT control, local readiness and focused agent guidance without changing the existing `counterpart/1` setup contract. Application and device trust remain independent; counter coordination covers only participating processes sharing the same state.
