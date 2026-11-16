OrcaSlicer development container — integration candidate, not deployment-ready

Build target: Linux amd64; Ubuntu 24.04. Dockerfile pins the official
feature/mcp commit 8cccdf82d00381942d9b664750457da318e7d068. It uses the
upstream dependency installer and AppImage build with two compiler jobs.
Build may take substantial memory, disk and time; these are not yet measured.
The source build remains in progress and has not produced an artifact. The
runtime source passed independent review, but the actual image and upstream
MCP have not yet been qualified.
The upstream AGPL source, dependencies and licence belong to the separate
Orca image. They are not incorporated into the GPL-2 printer MCP process.

The Orca GUI uses a private Xvfb display and the upstream harness. Docker
network_mode: none leaves the upstream HTTP server on its own loopback and
prevents network access to printers and cloud services. The local gateway
exposes a Unix socket in a private host bind mount for an authorized proxy.
No printer credentials, printer-MCP signing material, cloud account or printer
network are mounted or supplied. Runtime profile synchronisation and plugin
downloads are unavailable with this isolation. No TCP socket is published.

Workspace IDs coordinate projects for trusted agents of one authenticated operator;
they are not a hostile-tenant security boundary. Gateway OAuth/bearer authentication
identifies the operator, and network isolation prevents direct printer egress.
The full upstream scripting, file, CAD and GUI tools remain available.

The proxy must authenticate clients, forward the exact configured Host and
path /3d-printing/slicer, and replace Authorization with Orca's separate private
64-character lowercase hex bearer token. The same token is read from a 0600
file owned by UID 10001, mounted read-only into the container. The gateway
rejects Origin headers and does not emit CORS headers. It makes a single upstream
request, and an upstream failure can leave an operation's outcome unknown.

The socket defaults to mode 0600 and the container user owns it. To share with
the proxy, configure a shared primary group and set ORCA_SOCKET_MODE=0660;
ensure the socket directory is private, writable by UID 10001, and accessible
only to that trusted group. File ownership is a host deployment responsibility.
The gateway holds an exclusive lock in the socket directory before probing Orca;
another instance sharing that directory fails startup without replacing its socket.
Keep the private lock file in place across restarts so stale sockets can be recovered.
The separate /artifacts mount stores workspace outputs under /artifacts/<workspace_id>; share only necessary artifact files with the printer service, never the private state directory. The state directory is private and owned by UID 10001. Its contents include
upstream credentials and discovery metadata: do not expose it to the proxy.

A startup probe starts and stops Orca to cache metadata. During a job, call
workspace_create, then workspace_open with its workspace_id, and pass that ID to every native tool, then wait for jobs,
export artifacts and call workspace_close. A normal close attempts a versioned checkpoint and reopening uses the last verified checkpoint. An unclean stop or failed checkpoint marks the workspace as requiring recovery; retained files are not an automatic project restore. The checkpoint implementation remains unverified against real Orca and must not be deployed yet. The default idle expiry is 900 seconds
and hard lifetime is 14400 seconds; ORCA_IDLE_SECONDS and ORCA_HARD_SECONDS
configure them (hard maximum 86400 seconds). On end or expiry the server revokes
active worker access and stops the child before another workspace can start. Unfinished
operations have unknown outcomes and are never replayed. Output files, checkpoints and each workspace profile remain on disk until the operator removes them; no automatic retention cleanup is implemented. A lost workspace_create reply can leave an unclaimed cold directory, but cannot start or monopolize the worker. A read-only profile template may be
mounted separately and supplied via ORCA_PROFILE_TEMPLATE; it is copied per job.
Do not deploy until reservation and shutdown behavior, image build, and network
isolation have been independently verified on the target host.
The generic upstream tools include script/GUI and print-host operations, so the
network restriction is an essential boundary, not merely a configuration aid.
The gateway makes no claim that a shared project can safely serve concurrent jobs.

Run offline mock checks: python3 -m unittest -v test_gateway.py test_workspace.py test_protocol.py
These exercise no Orca executable. They do not verify Docker, Linux library
compatibility, network isolation, upstream MCP, actual X2D slicing, export, or
physical printing. A synthetic X2D project slice and exported artifact inspection
on the intended host are required before claiming slicing readiness.

Runtime image from the separately built CI artifact:

1. Verify the external archive SHA-256 supplied with the CI artifact before
   extraction. The archive must come from the accepted source/build revision.
2. In an otherwise empty runtime build context, copy this directory's Dockerfile.runtime,
   .dockerignore, gateway.py, supervisor.py, workspace.py, protocol.py,
   orca_backend.py and verify_bundle.py. Extract the verified artifact beneath
   bundle/. Bundle contents must include build/OrcaSlicer_Linux_V*.AppImage,
   tools/mcp/, LICENSE.txt, ORCA_COMMIT, BUILD_REPOSITORY_COMMIT, SHA256SUMS.
3. Build with: docker build --platform linux/amd64 -f Dockerfile.runtime .
   The image verifies the upstream source commit and complete file manifest
   before extracting the AppImage. The external archive hash must be checked
   separately; matching hashes do not by themselves establish publisher identity.

The Linux-only lifecycle fixture in test_linux_process.py launches dummy Python
processes, not Orca. The Mac suite passed 32 of 35 tests with three Linux-only
skips. The independently reviewed v5 runtime archive SHA-256 is
4ca1cbc2bddca83fb42210264ac71566479450044edb4a2c2ee9ab55251a463e.
All 35 tests passed without skips in 10.892 seconds in isolated Python 3.12
slim as non-root UID 10001 with no network. This is separate from the pending
real-image process, metadata/slice/export/checkpoint/restore and client checks.
