OrcaSlicer development container — managed deployment

Build target: Linux amd64; Ubuntu 24.04. Dockerfile pins the official
feature/mcp commit 8cccdf82d00381942d9b664750457da318e7d068. It uses the
upstream dependency installer and AppImage build with two compiler jobs.
Build may take substantial memory, disk and time; these are not yet measured.
The pinned source CI build succeeded. The reviewed runtime passed isolated Linux
fixture and actual-image slice, checkpoint, restore and cleanup checks. Managed
deployment and public OAuth metadata are verified; fresh-client slicer tool
invocation and an actual user-client attachment handoff remain unverified.
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
export artifacts and call workspace_close. A normal close attempts a versioned checkpoint and reopening uses the last verified checkpoint. An unclean stop or failed checkpoint marks the workspace as requiring recovery; retained files are not an automatic project restore. An isolated actual-image trial verified checkpoint and same-ID restore; the managed service is deployed. The default idle expiry is 900 seconds
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
physical printing. An isolated X2D slice and exported artifact inspection passed; these mock checks
alone do not establish production readiness.

Runtime image from the separately built CI artifact:

1. Verify the external archive SHA-256 supplied with the CI artifact before
   extraction. The archive must come from the accepted source/build revision.
2. In an otherwise empty runtime build context, copy this directory's Dockerfile.runtime,
   .dockerignore, gateway.py, supervisor.py, workspace.py, protocol.py,
   orca_backend.py, export_store.py, verify_bundle.py and the required
   `orca-session` launcher. Extract the verified artifact beneath
   bundle/. Bundle contents must include build/OrcaSlicer_Linux_V*.AppImage,
   tools/mcp/, LICENSE.txt, ORCA_COMMIT, BUILD_REPOSITORY_COMMIT, SHA256SUMS.
3. Build with: docker build --platform linux/amd64 -f Dockerfile.runtime .
   The image verifies the upstream source commit and complete file manifest
   before extracting the AppImage. The external archive hash must be checked
   separately; matching hashes do not by themselves establish publisher identity.

Public-safe provenance for the historical verified artifact is recorded in
deploy/orca/qualification/README.txt: repository commit
309e42d6b746bbc9c45a67739d9b9a43e0f42fc5, upstream Orca commit
8cccdf82d00381942d9b664750457da318e7d068, archive name/size/hash,
AppImage name/size/hash, and its verified 91-entry manifest. Do not copy local
state paths, receipts, profiles, credentials or binaries into this repository.

The Linux lifecycle fixtures launch dummy Python processes, not Orca. The final
isolated Linux suite passed all 56 tests as UID 10001 without network, including
real ESRCH and forced process-group termination. Separately, the uninstrumented
image completed two clean closes and a same-ID restore with the test cube and
presets. An earlier false close remains unexplained because its errno was not
captured. These results do not establish deployed OAuth or user-client access.

Shared workspace file exchange candidate
----------------------------------------
The operator may configure a data-only Node store and Orca export outbox. Create
one workspace ID on either MCP and cold-attach the same ID on the other; their
ledgers remain independent. Closing Orca releases the GUI without deleting the
project or staged files. These IDs coordinate one trusted operator and are not
hostile-tenant boundaries. The Node publisher owns incoming and published files;
mount only its published subtree read-only into Orca at the same absolute path.
Mount the separate outbox read-write for Orca and read-only for Node, also at
matching absolute paths. Configure a dedicated supplementary artifact group on
both containers; the proposed GID 10002 must be checked by infrastructure.
Data directories use 2750 and files 0440. Never share either service's private
home, secrets, printer signing counter or Orca IPC group. Orca retains network
isolation and does not receive printer credentials.

Native Orca calls use the opened workspace ID. Publish a completed export using
workspace_publish_file, then adopt its receipt with workspace_adopt_export on
Node; use the returned file_path for existing inspection and dispatch gates.
Outbox deletion requires an explicit matching-hash request and leaves the
original workspace file intact. No completed workspace or artifact is deleted
automatically. The managed deployment uses these data-only mounts; an actual user-client
attachment handoff remains to be verified.
