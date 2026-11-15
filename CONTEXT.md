# Current context

## Purpose and state

This Bambu-only MCP server provides printer, slicing, model and print-monitoring workflows over stdio or streamable HTTP. It originated from upstream `main` at `4cadc9f7c84138382f215b3e254094fa66c6a689` (version `1.1.94`). Preserve the upstream safety and release rules in [AGENTS.md](AGENTS.md). The current feature work is unmerged and unpublished.

Stateful Streamable HTTP serves separate client protocol sessions from one shared printer backend. Session closure does not close process-owned resources; request cancellation and elicitation remain scoped to the originating session. Use a private loopback service with bearer-token file authentication; the stdio adapter is only a relay. `MCP_HTTP_STATEFUL=false` is unsupported.

Optional signed MQTT control supports explicitly selected local and cloud routes. It uses operator-supplied application signing material, independently configured device trust and a durable local counter. The account integration is separately opt-in; its browser flow provides a private cached session for the optional cloud route. Native SDK/FULU sessions and file transfer remain separate from both account login and signing. Route and model support are not universal.

Agent guidance is available from initialization instructions, `get_agent_guide` and `bambu://workflow/` resources. `get_agent_readiness` reports only known local configuration and capabilities; unknown remains unknown. The existing `counterpart/1` setup schema is unchanged.

## Invariants

- Preserve exact-file and selected-plate inspection, fresh observed identity, nozzle, state and safety checks on print paths. File-only inspection and local configuration do not authorize dispatch.
- Act on the person's specific print request and retain existing elicitation rules. File upload, a dispatch receipt, observed job progress and physical print success are distinct evidence.
- Signed operation fails closed on missing or invalid prerequisites; never automatically fall back or replay an uncertain dispatch. Local counter reservations coordinate only processes sharing that state directory, not independent controllers.
- Browser login takes passwords and verification codes only through the temporary loopback flow. Never return account tokens or expose credentials in source, logs or tool results. Account status reports cached state, not live authentication.
- Preserve Bambu-only scope, existing public contracts, upstream authorship and licenses. Do not contact a printer during routine development.

## Validation limits

HTTP, signing, account and guide tests use isolated local fixtures, synthetic credentials, mocked boundaries and MCP protocol clients. They do not establish a live Bambu account session, firmware acceptance, a working native helper session, a physical print, or compatibility across models. Consult [INTERFACE.md](INTERFACE.md) and the guides for actual configuration and route limitations.
