# ZimaOS authentication gateway checkpoint

This directory is the safe, deployable-source checkpoint for the authentication
gateway that protects the printer MCP and the separately owned Orca slicer MCP.
It intentionally contains no live identifiers, domain, tenant, app ID, secret,
state, proxy configuration, or service-manager wrapper.

## What was recovered

On 2026-11-21, read-only inspection found a running dual-resource gateway built
from the pinned Python 3.12 Alpine base in `Dockerfile`, with `fastmcp` 4.2.0
and `httpx2` 2.16.2. Its four build inputs matched the reviewed staging source:

| input | SHA-256 |
| --- | --- |
| `bridge.py` | `e1695436d1679069c33d0bfaeedf8a0206104f752c7d7982be868d75056a77af` |
| printer factory | `5155c6c403528f6dba332130b76d918b0fcc1c654c882488d3b4d9ef0a0804f7` |
| dual factory | `d2d41433f54eed0cc05a79234bc76d75e8c5f5299b4a396b5b48fc18bf989650` |
| lockfile | `c1ca91d49d1c2cea02e5a814abb001d8a8aa96bbd66f85959287e07f81e0f3fd` |

The source here replaces deployment-specific literals with required environment
configuration. It preserves the security properties: HTTPS public origin and
exact Host, fixed loopback/Unix-socket backends, separate printer and slicer
state/keys/bearers, exact tenant/operator checks, expiring tokens, PKCE/consent,
disabled CIMD, filtered headers, no redirect following, and no TCP fallback for
the slicer socket.

The lockfile hash above identifies the verified live build input. The committed
copy differs only in its generated-command comment, which was rewritten to
remove a machine-specific staging path; every dependency pin and SHA-256 hash
is retained unchanged.

## Required operator configuration

Copy `.env.example` outside the repository to a protected local file, then
replace every dummy value. It is the complete input map for `auth.compose.yaml`;
the names ending in `_HOST_FILE` are host paths, while the container receives
only fixed private mount targets. Supply secret *file paths* through that
host-owned runtime mechanism; every secret file must be a regular,
runtime-UID-owned `0600` file. Printer and slicer states must be separate `0700`
runtime-UID-owned directories. The slicer socket must be a canonical non-Docker
Unix socket, mounted read-only, and only its intended supplementary group may
connect. Use independent slicer JWT, Fernet and backend bearer material.

`auth.compose.yaml` is the complete service template. It runs as UID/GID 1000,
adds only the slicer socket group, uses host networking but binds Uvicorn to
loopback `8188`, has a read-only root, drops all capabilities and sets
no-new-privileges. It mounts two separate writable state directories, the
read-only socket directory, and seven individually read-only secret files. The
portable `launch.sh` replaces the live host adapter's environment-loading hook:
it only requires its named inputs and executes the exact factory arguments from
the running service. The separately owned Orca container remains
network-isolated and receives no printer credentials. Its gateway token and
socket are host configuration, not source.

The socket directory must be `0750` and the socket `0660`, both owned by the
Orca runtime UID/GID. The gateway's UID 1000 needs that single supplementary
group; this is why `SLICER_SOCKET_GID` is required. A `0600` token file in the
socket directory is not mounted or consumed by this service.

The host binds have deliberately narrow trust: the two state directories are
the only writable mounts; the seven named secret files and the socket directory
are read-only. The printer upstream URL must remain the fixed loopback MCP path.
The external proxy is configured separately by the deployment owner; it must
route only the approved public host to this loopback listener and must not pass
public authorization headers to the printer or slicer backends.

## Host configuration deliberately not recovered

The existing reverse proxy, OAuth proxy, ZimaOS adapter launcher, network names,
actual directories, private keys, encrypted registrations and backend bearer
files are upstream host configuration. They are neither copied nor replaced by
this checkpoint. The live adapter currently supplies printer environment inputs
before Uvicorn starts; the template makes those inputs explicit instead. A proxy
route template is intentionally absent: it is owned by the deployment route
configuration and must not forward public `Authorization` to either backend.

The Docker build context is allowlisted by `.dockerignore`; only the Dockerfile,
runtime modules, launcher and hash-locked requirements can enter the image.

Build and static test only with a fully reviewed deployment context:

```sh
docker build -t <local-auth-image> deploy/zimaos/auth
python3 -m py_compile deploy/zimaos/auth/{bridge,runtime,dual_runtime}.py
docker compose --env-file <protected-local-env-file> -f deploy/zimaos/auth/auth.compose.yaml config --quiet
```

For a non-secret template-only check, use:

```sh
docker compose --env-file deploy/zimaos/auth/.env.example -f deploy/zimaos/auth/auth.compose.yaml config --quiet
```

This source has not performed a live login, proxy stream, printer action,
slicer action, deployment, or cutover.
