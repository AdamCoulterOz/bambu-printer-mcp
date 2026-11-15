# Integration interface

This repository owns the Bambu-only MCP server, its tools and Bambu printer, slicer and native-helper integrations. It does not own printer firmware, Bambu account services, installed vendor software or client applications.

## MCP and agent discovery

Clients connect over stdio or streamable HTTP. Stdout carries only MCP protocol messages; diagnostics go to stderr. Tool definitions and schemas describe their arguments and model-specific availability. `get_agent_guide` serves a task index and focused topics, including signing and printing, to tools-only clients; `bambu://workflow/` resources serve the same guide text. The signing guide supplies optional configuration descriptors, including a secret marker, without configured values. `get_agent_readiness` returns local configuration and capability states, named blockers and next actions with `dispatch_authorized: false`; it performs no live printer or physical readiness check.

A stateful HTTP session owns its protocol server and transport; all sessions share one process backend. Session deletion or idle expiry closes that session, while full backend cleanup occurs at process shutdown. Elicitation and cancellation are routed to the originating request. HTTP validates Host, Origin and optional bearer authentication and bounds sessions, idle time and request bodies. Non-loopback requires bearer authentication and separate TLS protection. An explicit Host allowlist is recommended for every non-loopback bind and required for hostname or wildcard binds; a literal IP bind otherwise enforces its exact Host. `MCP_HTTP_STATEFUL=false` fails startup. `bambu-printer-mcp-http-client` is a stdio-to-HTTP relay with a private bearer-token file, HTTPS or loopback HTTP, and no automatic replay; it does not start a printer backend.

`counterpart/1` remains a separate existing contract. The existing `counterpart_setup_fields` schema and field roles are unchanged. Changes to public tools, printer models, status semantics or `counterpart/1` require owner review and downstream impact analysis.

## Printer operations and optional authentication

Printer status and commands use MQTT; supported file transfers use FTPS or a separate native route. Printing retains inspection of the exact dispatched snapshot and selected plate, fresh printer safety checks and existing human-authorization semantics. Upload and dispatch are separate; a publisher acknowledgement or helper receipt does not establish device acceptance or physical success. Uncertain dispatches are not automatically replayed.

Signed controls are opt-in with explicit local or cloud transport and require an operator-provided application key, certificate chain and current CRL, independently configured device CA, OpenSSL 3 and a private initialized persistent sequence store. Optional local broker TLS trust is a separate boundary. Selected signed controls fail closed if prerequisites fail; signed project dispatch does not upload files, and legacy `gcode_file` dispatch is blocked on that route. The typed LED protocol has its own deterministic unsigned route, not a fallback from failed signing. Counter reservations cover only processes using the same store, not other applications or hosts.

Optional account tools provide local status, browser login, cancellation, live bound-printer listing and local logout. Login accepts only the region and uses a short-lived loopback browser for credentials and verification codes; account tokens are not returned. Cached readiness does not prove live authentication. Cloud account use verifies the selected printer binding, and complete explicit cloud credentials take precedence; partial explicit credentials fail. Account login does not create or substitute for the application signing bundle, native SDK or FULU sessions. Logout removes the local session and does not claim remote revocation.

## Evidence and compatibility

Synthetic tests and mocked or local protocol checks do not establish live service authentication, device acceptance, a physical print or universal model/firmware support. The source repository declares GPL-2.0-only; do not incorporate AGPL code without a compatible licensing basis.
