# Public-gateway contract

The public Caddy virtual host is `YOUR_MCP_HOST`. Its deployed route sends
every path to the private authentication gateway at `127.0.0.1:8188`, preserving
`Host: YOUR_MCP_HOST`; Caddy itself does not forward the printer or Orca
Unix socket. The authentication gateway owns both resource matching and the
credential translation boundary. Its portable source/configuration is maintained
in [`auth/`](auth/), not duplicated here.

The route must be TLS-terminated by the existing Caddy global policy and must:

- return a generic `503 Service unavailable` on proxy failures, rather than
  backend or token details;
- retain the exact public Host when proxying to the gateway;
- pass the full URI unrewritten, so the gateway can distinguish the printer MCP
  resource from `/3d-printing/slicer` and its OAuth protected-resource,
  authorization-server, and OpenID discovery documents;
- never expose port 8189, port 8188, the Orca UDS, or the Orca bearer token.

The gateway then reaches the printer's loopback endpoint and the Orca socket
under its own least-privilege mounts. OAuth issuer/discovery metadata and client
registration are gateway configuration: provide secret files by private mounts,
not Compose environment values or repository files. Verify all advertised
issuer/resource URLs, callback routes, `Host`, forwarded HTTPS scheme and both
resource discovery endpoints after any proxy change.

The live Caddyfile was inspected on 2026-11-21 through the running Caddy
container. It contains an explicit `YOUR_MCP_HOST` catch-all route to
`127.0.0.1:8188` with `header_up Host YOUR_MCP_HOST` and generic 503 error
handling. It has no OAuth2-proxy forwarding rule for this virtual host; the
dedicated authentication gateway supplies the OAuth surface. This is route
evidence only, not a deployment qualification.
