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

## 2026-11-16 — First private native-print attempt

The first authorized private native-print attempt reached the client deadline without a helper receipt. A later fresh matching-printer report showed an older completed job and an idle printer; neither that observation nor a missing flight record proves whether the dispatch occurred. The outcome remains unknown and no physical-print qualification is claimed.

The accepted lifecycle repair bounds fresh safety collection and native helper execution, prevents late authorization, and records dispatch bookkeeping synchronously at the final authorization boundary. Success requires an unambiguous receipt for the latest authorized attempt; uncertain outcomes are not replayed. Focused fixtures and independent review support the change; physical-print qualification remains unestablished.


## 2026-11-16 — Bounded MQTT connection diagnostics

A private native-print attempt returned an MQTT offline error before recorded dispatch. An independent in-memory MQTT fixture reproduced a 2-second transport timeout before a deliberately delayed 2.5-second CONNACK; the outer connection deadline was already 10 seconds. The transport timeout now matches that outer bound, and sanitized connection diagnostics distinguish the initial and confirmation safety stages. The fixture proves a possible mechanism, not the cause of that live attempt. No retry, safety-check bypass or physical-print qualification follows.

## 2026-11-16 — Explicit signed project route

Added a candidate capability-driven direct internal-storage 3MF transfer and readback path coupled to the existing signed MQTT project command, with explicit TLS trust and no fallback or replay. It reuses the prior Android-derived signing work; it does not use or repair the vendor native SDK's separate -26 readiness gate. Independent published protocol research informed the design without copying its implementation. Focused synthetic and MCP tests do not establish a live upload or physical print; private deployment and qualification remain pending.

## 2026-11-16 — Storage login interoperability

The first private signed-route upload-only attempt failed in login framing before an upload receipt. A subsequent strict-TLS login probe returned the expected acknowledgement magic, length and sequence with a nonzero opaque reserved field. The receiver now permits that field while retaining the other login and transport checks; outgoing reserved fields remain zero. Focused fixtures cover the correction and typed failure diagnostics without retry. This observation does not qualify an upload or physical print.

## 2026-11-16 — Storage list interoperability

A strict-TLS read-only session authenticated, completed setup, reported internal and external storage capabilities, and listed files through the supported selectors. Valid correlated list replies had a varying opaque header byte, which the initial parser rejected before upload. The receiver now treats that byte as opaque while retaining marker, channel and inner reply validation; transmitted framing and other security checks remain unchanged. The initial upload-only request stopped before writing a file, and this read-only evidence does not qualify an upload or print.

## 2026-11-16 — Private signed project trial

A normal MCP upload-only request transferred a checked 3MF to internal storage over TLS and verified the complete readback by byte length and SHA-256. A subsequent signed-cloud project request uploaded and verified a new copy, and the matching X2D job on firmware 01.02.00.00 reached FINISH at 100%, 40 of 40 layers, with no reported print or HMS errors. Camera images showed first-layer material in the expected footprint and the completed fixture on the plate. Hands-on physical quality and fit remain unverified; this is evidence for one printer and firmware, not universal support. The route reuses the Android-derived signing work; the earlier vendor SDK print path did not use that signer. Uncertain prior native attempts remain uncertain and are not automatically replayed. The four-client audit remains required before an upstream PR.
