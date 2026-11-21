# ZimaOS deployment checkpoint

This directory records a portable reconstruction of the configured ZimaOS
printing deployment as observed on 2026-11-21. It is not a CasaOS export, a
backup, or authority to restart, pull, apply or publish anything. No private
launcher, account material, certificate, bearer, session, filesystem identifier
or appliance state is stored here.

## Observed topology

`YOUR_MCP_HOST` terminates at Caddy, which proxies all paths to the
authenticated gateway on host loopback port 8188. The gateway owns OAuth and
routes printer versus Orca requests. The printer binds only
`127.0.0.1:8189 -> 3000/tcp`; Orca publishes no TCP port and exposes only the
private shared Unix socket. See [gateway-contract.md](gateway-contract.md) and
the separately owned [`auth/`](auth/) deployment material.

The active printer container uses image
`sha256:7144ac0001d10de14335950464fc563eea8ebd60aef6c4faf5c1a61779f99c7e`,
created 2026-11-20, with `/bin/sh /run/zima-adapter/native-launch.sh
docker-entrypoint.sh node dist/index.js`, UID:GID `1000:1000`, init and
`unless-stopped`. It uses `bambu-printer-mcp-egress`, is supplementary group
`10002`, and receives `/exchange/store` RW plus `/exchange/outbox` RO.
Its private native launcher first sources the private runtime environment and
then launches the image entrypoint. That environment configures the managed
account/cloud-signing, printer/TLS, TUTK lock, streamable-HTTP Host/bearer/path
and normal Node home state; values are intentionally absent.

The upstream printer fork pin is `4cadc9f7c84138382f215b3e254094fa66c6a689`
(base version `1.1.94`), per the repository contract. The active Orca image is
`sha256:3fddb1d70090cc0042aa7c93f0319479a1c911c474c2ae22bab54b39e7798376`.
Its upstream `feature/mcp` source pin is
`8cccdf82d00381942d9b664750457da318e7d068`; its runtime/build sources remain
in [`../orca/`](../orca/), and are deliberately not copied here.

## Reconstruction inputs

Use [`.env.example`](.env.example) as a path-and-image inventory, then render
[printer.compose.yaml](printer.compose.yaml) and
[orca.compose.yaml](orca.compose.yaml) with a private environment file. The
real values must name already provisioned host paths. They are intentionally
not defaulted and must never be committed.

The missing private launch bytes are reconstructed by
[private/runtime-env.sh.example](private/runtime-env.sh.example) and
[private/native-launch.sh.example](private/native-launch.sh.example). Copy both
outside the repository, replace the marked ordinary configuration values and
make each `0600`, owned by `1000:1000`. The secrets mount must contain regular
non-symlink files `http-token` and `printer-access-token` at `0600`, plus the
readable TLS/device-CA files. The private Node home holds account refresh state,
the writable managed-signing generation, signing counter and records; it must
remain persistent and private. `operation.lock` is a pre-created,
stable private regular file. `handy.apk` is a separately verified private input
mounted read-only. Do not restore the obsolete explicit cloud
broker/username/token triple: the launcher selects `BAMBU_SIGNED_CLOUD_AUTH=account`
and drops all three variables before Node starts.

Before applying a deployment change, verify all path types, ownership, modes,
capacity, image identity and the existing application-manager definition. In
particular, retain private 0700 state/secrets parents; do not share the printer
home, signing state, account material or Orca state with another service. The
artifact store is Node RW; only `store/published` is Orca RO. The outbox is
Orca RW and Node RO, with the dedicated supplementary group (`10002` in the
observed deployment). The Orca socket directory is private; `0660` is needed
only for the trusted gateway group.

Validate syntax without launching anything:

```sh
docker compose --env-file deploy/zimaos/.env.example -f deploy/zimaos/printer.compose.yaml config --quiet
docker compose --env-file deploy/zimaos/.env.example -f deploy/zimaos/orca.compose.yaml config --quiet
```

Do not use that example environment file to create host paths. It contains
placeholders and cannot establish the required ownership or private files.

## Limits and unavailable material

The live CasaOS compose files and the private adapter files are root/owner
restricted to this SSH account. Container inspection verified their active
mounts, entrypoints, listener bindings and nonsecret environment key names; no
secret contents were read. These examples therefore preserve deployment
semantics but not appliance-managed metadata. The live runtime currently supplies
the printer access code through its owner-restricted runtime environment; the
template instead requires the separate private `printer-access-token` file so
that no secret byte is embedded in a launcher. The printer's active native
launcher/adapter is an external private prerequisite, and authenticated client
invocation plus a real user-client attachment handoff remain unverified. Source
and Compose validation do not prove OAuth, printer readiness, successful
slicing, dispatch or a physical print.
