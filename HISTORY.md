# Decision history

## 2026-11-15 — Created the Bambu printer MCP fork

Created the `AdamCoulterOz/bambu-printer-mcp` fork from `DMontgomery40/bambu-printer-mcp` at upstream commit `4cadc9f7c84138382f215b3e254094fa66c6a689` (package version `1.1.94`). The fork preserves the upstream Bambu-only architecture and safety rules.

At fork creation the planned direction was signed LAN/cloud X2D controls, self-documenting MCP behavior, and retiring A1 from Codex and Claude printer surfaces. That initial plan did not establish API contracts, hardware compatibility, or implementation completion. No AGPL Home Assistant signing code was copied. The repository declares GPL-2.0-only.

## 2026-11-15 — Added opt-in signing and agent discovery

Implemented optional local and cloud signed MQTT controls with independent application and device trust, a persistent shared local counter, fail-closed selection and no automatic replay. The browser-based Bambu account session is an optional cloud credential source; it does not provide the application signing bundle or native file transfer. Preserved the existing `counterpart/1` setup contract and added standalone MCP guide and local-readiness tools and resources instead. The A1 retirement mentioned above is a local deployment decision, not a model-wide removal from this fork. Synthetic and mocked validation does not establish live device or physical-print success.

## 2026-11-15 — Shared stateful HTTP backend

Changed Streamable HTTP to give each client a separate stateful MCP protocol session over one process-owned printer backend. Session deletion no longer tears down shared backend resources; request-bound elicitation and cancellation remain isolated. The earlier stateless option is explicitly unsupported. Added a private-token stdio-to-HTTP relay for clients that cannot connect directly. Local protocol and mocked validation do not establish live printer behavior.

## 2026-11-15 — Exposed an explicit fresh identity read

Added optional `fresh: true` to `get_printer_status` using the existing shared backend and fresh MQTT collector. This mode waits for a matching printer-returned serial even when a model-only status arrives first. Existing display behavior and default internal print safety reads remain unchanged. The read does not authorize printing or establish complete print readiness; synthetic tests do not prove live identity or signed-control acceptance.

## 2026-11-15 — Bounded private signed-control trial

After expanding the separate device trust-bundle cap to eight CA certificates while retaining the six-certificate chain limit and existing strict checks, operator-provided application and device trust validated. Fresh X2D status returned a matching identity, with observation age 11 ms, FINISH at 100%, zero print error and no HMS entries. An authorized signed cloud 20% part-fan request received broker acknowledgement and fresh raw fan telemetry changed from 0 to 1. Acknowledged 0% restoration initially reported 2 and subsequently returned to 0 with matching fresh identity, zero error and no HMS entries. Raw values are unscaled: neither the requested percentage nor a broker acknowledgement proves fan RPM or rotation. No print, heater, axis, native upload or native print was tested; the next print remains subject to a fresh preflight. This private trial does not qualify other models or firmware or satisfy the upstream four-client audit.
