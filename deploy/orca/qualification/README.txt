Offline-safe Orca gateway qualification packet

This packet is an operator-run, synthetic qualification aid. It makes one
request per invocation to the supplied private gateway Unix socket. The helper
does not contact a printer or cloud service itself; retain the deployment's
no-network isolation so the gateway cannot do so either. Keep receipts and
runtime profiles outside the repository; do not commit them.

Inputs are intentionally generic and private:

    SOCKET_PATH=/private/deployment/orca.sock
    TOKEN_FILE=/private/deployment/orca.token
    HOST_NAME=the-configured-gateway-host
    RECEIPTS=/private/deployment/receipts

The gateway endpoint is `POST /3d-printing/slicer` over the Unix socket. The
token file must contain the gateway's separate 64-character lowercase hex
bearer token and be readable only by the authorized deployment account. Set
`umask 077`, create the receipt directory with mode 0700, and use a new
receipt filename for every request. Do not print, copy, or commit token,
profile, credential, or receipt contents.

Examples (run from this directory):

    Q="$PWD/mcp_once.py"
    call() { python3 "$Q" --socket "$SOCKET_PATH" --token-file "$TOKEN_FILE" --host "$HOST_NAME" "$@"; }
    call --receipt "$RECEIPTS/01-initialize.json" initialize
    call --receipt "$RECEIPTS/02-tools.json" tools/list
    call --modern --receipt "$RECEIPTS/03-discover.json" server/discover

Inspect both tool catalogs before using a tool. The helper allowlist is
limited to the workspace, preset, object, slicing, wait, export and read-only
qualification operations; it permits only a 20 mm synthetic cube action and a
non-overwriting `sliced_3mf` export. `inspect_export.py` checks bounded ZIP
size, duplicate/case-colliding names, CRCs, non-empty G-code, plate members,
metadata members and selected headers. Those checks are evidence only: they
do not authorize a print or establish physical fit, printer compatibility,
live authentication, or a user-client attachment handoff.

The helper writes the full response only to the new mode-0600 receipt and
prints a concise status line; failures do not echo request or response data.

`cube20.stl` is a closed 12-triangle 20 mm cube, SHA-256
`9b40d6688d2932d21643c136d75108a8d6cb117584e2e4b5fed7d6d6f09ae0d7`.
Use a private disposable workspace and preserve the no-network, no-printer,
no-credential isolation boundary. Stop on dialogs, schema changes, timeouts,
transport failures, nonterminal jobs, or unclear outcomes; do not retry a
mutation automatically.

## Public-safe artifact provenance

The historical verified Linux amd64 artifact is `orca-dev-linux-amd64.tar.gz`
(91 manifest entries, manifest verified). Its public provenance is:

* repository commit: `309e42d6b746bbc9c45a67739d9b9a43e0f42fc5`
* upstream Orca commit: `8cccdf82d00381942d9b664750457da318e7d068`
* archive: 219782060 bytes, SHA-256
  `57508f46473434e39e111ad1c617bd7d0bd7636a42e3dfb006095c7e849c2d95`
* AppImage: `build/OrcaSlicer_Linux_V2.6.0-dev.AppImage`, 220269048 bytes,
  SHA-256 `5bdf4c2a6cda2bfdb9c16ace1d159ef005f6ecf6b0b55f226a46cae54e371ee2`

These hashes identify the historical verified artifact; they do not replace
independent download provenance or target-host verification.
