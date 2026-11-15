# Decision history

## 2026-11-15 — Created the Bambu printer MCP fork

Created the `AdamCoulterOz/bambu-printer-mcp` fork from `DMontgomery40/bambu-printer-mcp` at upstream commit `4cadc9f7c84138382f215b3e254094fa66c6a689` (package version `1.1.94`). The fork preserves the upstream Bambu-only architecture and safety rules.

At fork creation the planned direction was signed LAN/cloud X2D controls, self-documenting MCP behavior, and retiring A1 from Codex and Claude printer surfaces. That initial plan did not establish API contracts, hardware compatibility, or implementation completion. No AGPL Home Assistant signing code was copied. The repository declares GPL-2.0-only.

## 2026-11-15 — Added opt-in signing and agent discovery

Implemented optional local and cloud signed MQTT controls with independent application and device trust, a persistent shared local counter, fail-closed selection and no automatic replay. The browser-based Bambu account session is an optional cloud credential source; it does not provide the application signing bundle or native file transfer. Preserved the existing `counterpart/1` setup contract and added standalone MCP guide and local-readiness tools and resources instead. The A1 retirement mentioned above is a local deployment decision, not a model-wide removal from this fork. Synthetic and mocked validation does not establish live device or physical-print success.
