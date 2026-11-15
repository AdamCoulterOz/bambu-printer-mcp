# Current context

## Purpose and state

This Bambu-only MCP server provides printer, slicing, model and print-monitoring workflows over stdio or streamable HTTP. It originated from upstream `main` at `4cadc9f7c84138382f215b3e254094fa66c6a689` (version `1.1.94`). Preserve the upstream safety and release rules in [AGENTS.md](AGENTS.md). The current feature work is unmerged and unpublished.

Stateful Streamable HTTP serves separate client protocol sessions from one shared printer backend. Session closure does not close process-owned resources; request cancellation and elicitation remain scoped to the originating session. Use a private loopback service with bearer-token file authentication; the stdio adapter is only a relay. `MCP_HTTP_STATEFUL=false` is unsupported.

Optional signed MQTT control supports explicitly selected local and cloud routes. It uses operator-supplied application signing material, independently configured device trust and a durable local counter. The account integration is separately opt-in; its browser flow provides a private cached session for the optional cloud route. Native SDK/FULU sessions and file transfer remain separate from both account login and signing. Route and model support are not universal.

Agent guidance is available from initialization instructions, `get_agent_guide` and `bambu://workflow/` resources. `get_agent_readiness` reports only known local configuration and capabilities; unknown remains unknown. The existing `counterpart/1` setup schema is unchanged.

`get_printer_status({fresh:true})` provides read-only fresh MQTT identity/state/error telemetry through the same shared backend and requires a matching returned serial. Default display status is unchanged. This identity probe does not qualify full print readiness.

Native-print safety collection and helper execution have bounded deadlines. Expired requests cannot authorize a late dispatch, and helper errors retain allowlisted diagnostics. The native-helper deadline is not an end-to-end limit on slicing or inspection. Focused fixtures and independent review cover the repair; physical printing remains unqualified.

## Invariants

- Preserve exact-file and selected-plate inspection, fresh observed identity, nozzle, state and safety checks on print paths. File-only inspection and local configuration do not authorize dispatch.
- Act on the person's specific print request and retain existing elicitation rules. File upload, a dispatch receipt, observed job progress and physical print success are distinct evidence.
- Signed operation fails closed on missing or invalid prerequisites; never automatically fall back or replay an uncertain dispatch. Local counter reservations coordinate only processes sharing that state directory, not independent controllers.
- Browser login takes passwords and verification codes only through the temporary loopback flow. Never return account tokens or expose credentials in source, logs or tool results. Account status reports cached state, not live authentication.
- Preserve Bambu-only scope, existing public contracts, upstream authorship and licenses. Do not contact a printer during routine development.

## Validation limits

HTTP, signing, account and guide tests use isolated local fixtures, synthetic credentials, mocked boundaries and MCP protocol clients. On 15 November 2026, an authorized private X2D trial through the shared HTTP service observed matching fresh identity and one signed cloud part-fan command followed by restoration: broker acknowledgements accompanied raw fan telemetry changing from 0 to 1 and later returning to 0. The requested setting was 20%; raw values are unscaled and do not establish RPM or rotation. This bounded observation does not qualify other controls, models or firmware, a live account login, native upload or printing, heating, motion, or a physical print. The user approved private deployment while retaining the required four-client audit before an upstream PR. Consult [INTERFACE.md](INTERFACE.md) and the guides for actual configuration and route limitations.

The first private native-print attempt timed out at the client deadline without a helper receipt. A later fresh matching-printer report still showed an older completed job and an idle printer; it does not establish whether the attempted dispatch occurred. Its outcome remains unknown and does not qualify native printing or physical success.
