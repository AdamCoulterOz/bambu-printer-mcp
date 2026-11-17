# Decision history

## 2026-11-15 — Created the Bambu printer MCP fork

Created the `AdamCoulterOz/bambu-printer-mcp` fork from `DMontgomery40/bambu-printer-mcp` at upstream commit `4cadc9f7c84138382f215b3e254094fa66c6a689` (package version `1.1.94`). The fork preserves the upstream Bambu-only architecture and safety rules.

At fork creation the planned direction was signed LAN/cloud X2D controls, self-documenting MCP behavior, and retiring A1 from Codex and Claude printer surfaces. That initial plan did not establish API contracts, hardware compatibility, or implementation completion. No AGPL Home Assistant signing code was copied. The repository declares GPL-2.0-only.

## 2026-11-15 — Added opt-in signing and agent discovery

Implemented optional local and cloud signed MQTT controls with independent application and device trust, a persistent shared local counter, fail-closed selection and no automatic replay. The browser-based Bambu account session is an optional cloud credential source; it does not provide the application signing bundle or native file transfer. Preserved the existing `counterpart/1` setup contract and added standalone MCP guide and local-readiness tools and resources instead. The A1 retirement mentioned above is a local deployment decision, not a model-wide removal from this fork. Synthetic and mocked validation does not establish live device or physical-print success.

## 2026-11-15 — Shared stateful HTTP backend

Changed Streamable HTTP to give each client a separate stateful MCP protocol session over one process-owned printer backend. Session deletion no longer tears down shared backend resources; request-bound elicitation and cancellation remain isolated. The earlier stateless option is explicitly unsupported. Added a private-token stdio-to-HTTP relay for clients that cannot connect directly. Local protocol and mocked validation do not establish live printer behavior.

## 2026-11-15 — Exposed an explicit fresh identity read

Added optional `fresh: true` to `get_printer_status` using the existing shared backend and fresh MQTT collector. This mode waits for a matching printer-returned serial even when a model-only status arrives first. Existing display behavior and default internal print safety reads remain unchanged. The read does not authorize printing or establish complete print readiness; synthetic tests do not prove live identity or signed-control acceptance.

## 2026-11-15 — Bounded private signed-control trial

After expanding the separate device trust-bundle cap to eight CA certificates while retaining the six-certificate chain limit and existing strict checks, operator-provided application and device trust validated. Fresh X2D status returned a matching identity, with observation age 11 ms, FINISH at 100%, zero print error and no HMS entries. An authorized signed cloud 20% part-fan request received broker acknowledgement and fresh raw fan telemetry changed from 0 to 1. Acknowledged 0% restoration initially reported 2 and subsequently returned to 0 with matching fresh identity, zero error and no HMS entries. Raw values are unscaled: neither the requested percentage nor a broker acknowledgement proves fan RPM or rotation. No print, heater, axis, native upload or native print was tested; the next print remains subject to a fresh preflight. This private trial does not qualify other models or firmware or satisfy the upstream four-client audit.

## 2026-11-16 — First private native-print attempt

The first authorized private native-print attempt reached the client deadline without a helper receipt. A later fresh matching-printer report showed an older completed job and an idle printer; neither that observation nor a missing flight record proves whether the dispatch occurred. The outcome remains unknown and no physical-print qualification is claimed.

The accepted lifecycle repair bounds fresh safety collection and native helper execution, prevents late authorization, and records dispatch bookkeeping synchronously at the final authorization boundary. Success requires an unambiguous receipt for the latest authorized attempt; uncertain outcomes are not replayed. Focused fixtures and independent review support the change; physical-print qualification remains unestablished.


## 2026-11-16 — Bounded MQTT connection diagnostics

A private native-print attempt returned an MQTT offline error before recorded dispatch. An independent in-memory MQTT fixture reproduced a 2-second transport timeout before a deliberately delayed 2.5-second CONNACK; the outer connection deadline was already 10 seconds. The transport timeout now matches that outer bound, and sanitized connection diagnostics distinguish the initial and confirmation safety stages. The fixture proves a possible mechanism, not the cause of that live attempt. No retry, safety-check bypass or physical-print qualification follows.

## 2026-11-16 — Explicit signed project route

Added a candidate capability-driven direct internal-storage 3MF transfer and readback path coupled to the existing signed MQTT project command, with explicit TLS trust and no fallback or replay. It reuses the prior Android-derived signing work; it does not use or repair the vendor native SDK's separate -26 readiness gate. Independent published protocol research informed the design without copying its implementation. Focused synthetic and MCP tests do not establish a live upload or physical print; private deployment and qualification remain pending.

## 2026-11-16 — Storage login interoperability

The first private signed-route upload-only attempt failed in login framing before an upload receipt. A subsequent strict-TLS login probe returned the expected acknowledgement magic, length and sequence with a nonzero opaque reserved field. The receiver now permits that field while retaining the other login and transport checks; outgoing reserved fields remain zero. Focused fixtures cover the correction and typed failure diagnostics without retry. This observation does not qualify an upload or physical print.

## 2026-11-16 — Storage list interoperability

A strict-TLS read-only session authenticated, completed setup, reported internal and external storage capabilities, and listed files through the supported selectors. Valid correlated list replies had a varying opaque header byte, which the initial parser rejected before upload. The receiver now treats that byte as opaque while retaining marker, channel and inner reply validation; transmitted framing and other security checks remain unchanged. The initial upload-only request stopped before writing a file, and this read-only evidence does not qualify an upload or print.

## 2026-11-16 — Private signed project trial

A normal MCP upload-only request transferred a checked 3MF to internal storage over TLS and verified the complete readback by byte length and SHA-256. A subsequent signed-cloud project request uploaded and verified a new copy, and the matching X2D job on firmware 01.02.00.00 reached FINISH at 100%, 40 of 40 layers, with no reported print or HMS errors. Camera images showed first-layer material in the expected footprint and the completed fixture on the plate. Hands-on physical quality and fit remain unverified; this is evidence for one printer and firmware, not universal support. The route reuses the Android-derived signing work; the earlier vendor SDK print path did not use that signer. Uncertain prior native attempts remain uncertain and are not automatically replayed. The four-client audit remains required before an upstream PR.


## 2026-11-17 — Stateless HTTP operation ownership

Replaced the feature branch's idle stateful HTTP session pool with per-request protocol contexts over one process-owned backend. Legacy clients carry signed compatibility metadata; the modern SDK path keeps only bounded active-operation state for continuations. Cancellation remains scoped to the originating operation, and neither client cleanup nor an expired ticket closes the shared backend. The relay may recover safe discovery after confirmed ticket expiry but never replays a tool call. `MCP_HTTP_STATEFUL` must be absent or false. This supersedes the earlier stateful decision; the new implementation is unmerged, unpublished and not deployed. The full suite passed 1,582 tests with 30 skips and no failures. Codex CLI 0.167 and Claude Code CLI 2.1.322 connected through native HTTP and the relay for metadata discovery; staged-package checks found 74 tools on all four routes and passed 13 self-checks. No tool calls, model turns or real printer operations were exercised; Claude Desktop GUI integration remains unverified.


## 2026-11-17 — Container handoff preparation

Prepared Dockerfile and Compose packaging for the selected ZimaOS deployment behind its existing HTTPS/OAuth proxy. The current Mac service remains on the earlier stateful implementation; no container build or cutover is complete. Local Docker is unavailable, so Linux build validation belongs to the infrastructure owner. Lazy, transient validation avoids eager AJV creation and retained schema caches, and SDK close clears its timer. A metadata-only benchmark observed zero idle protocol contexts for 205 clients, not flat RSS: memory still grew on Mac Node 26. The staged package contains 312 files; its SHA-256 is `d551ed2c75a5cddec91b4f0e73dc8fe86e7fe2644d6f10f0f258f01ea5a06ae4`.

## 2026-11-17 — Resumed deployment and separate Orca candidate

After the reboot pause, the Mac printer writer was disabled and its final counter state transferred. The Linux Node backend started with metadata for 79 tools, 16 resources and 8 prompts, and authenticated public Codex discovery returned 79 tools. A fresh matching X2D report showed FINISH, zero print error and no HMS entries. A signed 20% part-fan request returned a receipt and fresh raw fan telemetry changed from 0 to 3/2. The first restoration outcome was uncertain; a new 0% request following a fresh same-job guard returned a receipt, and delayed fresh telemetry reported 0. Raw values are unscaled and do not prove RPM or rotation. No print, heater or motion command was exercised in this trial; broader qualification remains open.

Selected official Orca `feature/mcp` commit `8cccdf82d00381942d9b664750457da318e7d068` for X2D profiles and full MCP in a separate image. Its candidate uses explicit durable workspaces, one on-demand worker, checkpoint/recovery and stateless MCP, with a private Unix socket, exclusive gateway ownership and no container network. It serves one trusted operator, not isolated tenants. Independent source review passed for runtime archive SHA-256 `4ca1cbc2bddca83fb42210264ac71566479450044edb4a2c2ee9ab55251a463e`. Its isolated Linux suite passed all 35 tests with no skips in 10.892 seconds on Python 3.12 slim, non-root UID 10001 and no network; Mac passed 32 with three Linux skips. Source build `43903074799` at feature head `5eded4d` subsequently failed without an artifact; the real image, synthetic X2D slice/export/restore and clients are not yet qualified.

## 2026-11-17 — Orca source packaging failure

Source build `43903074799` failed after compilation when AppImage packaging could not find repository metadata and appimagetool reported a missing FUSE device. The pinned generated helper calculated the metadata root as `/` and altered the downloaded AppImage runtime before its container invocation. The build correction fixes the generated path, preserves the runtime and supplies verified appimagetool and type2 runtime assets for offline packaging; separate dependency, compilation and packaging layers allow an available Docker cache to retain completed stages. An isolated non-root Linux fixture with no network, FUSE device, capabilities or privilege escalation produced a valid type2 AppImage, extracted the expected metadata and executable synthetic AppRun, and ran that AppRun successfully. This does not validate the complete Orca packaging path or image. The prior ephemeral runner's cache is not assumed to survive.

## 2026-11-17 — Common workspace and file exchange candidate

The user approved a shared opaque workspace ID across the printer artifact store and separate Orca GUI service, with independent ledgers, explicit cold attach and data-only published/outbox mounts. Added bounded staged transfer and export adoption without coupling the services' lifecycles, networking or private state. File preparation does not authorize printing; existing inspection and safety checks remain in force. Completed work is retained until explicit deletion. This is an undeployed candidate pending integration tests, mount qualification and live client verification.

## 2026-11-17 — Candidate packaging and runtime evidence

The current Node suite passed 1,604 tests with 29 skips and no failures. Actual npm installations in local-hoisted, private global and npm-exec layouts, and an extracted MCPB, exercised the installed workspace module and lock helper in isolation. The current Orca fixture passed 50 of 50 tests on Linux as UID 10001 without network, and 47 on macOS with three Linux-only skips. Corrected pinned source CI run `43995773386` succeeded, producing a verified bundle with SHA-256 prefix `57508f`. An initial runtime exposed 50 native tools but remained unready because a missing `en_US.UTF-8` locale caused a modal dialog. The runtime Dockerfile now generates that locale; the rebuilt image is awaiting verification. These results do not qualify deployment, cross-service mounts, live client transfer or synthetic slicing.

## 2026-11-17 — Isolated shared-workspace trial and close investigation

The corrected Orca runtime passed locale, OpenGL and permissions checks and reached readiness in about 31.8 seconds. Legacy and modern clients saw 57 tools and ready state with the X2D 0.4 mm and BBL PLA presets, no jobs or dialogs, and one GUI worker. In an isolated trial, a 684-byte, 20 mm cube passed through the read-only shared input mount, sliced to a 100-layer 3MF, and was published through the outbox and adopted by Node with matching SHA-256 `25341814d1c311409c2548bd15db5a9f1ccff34d52b9ab0bc08e05a8e07a82cc`. File-only inspection returned `dispatch_authorized: false`; the 3.63 g and 837 seconds are slicer estimates, not physical-print evidence.

The following `workspace_close` returned `closed: false`, `checkpointed: false` and an unknown unfinished state. The service exited with code 1 without OOM; its recorded GUI, Xvfb and D-Bus processes were gone. A false stop result forces the reported checkpoint value to false even if a file exists, so the checkpoint outcome and stop cause remain under investigation. Restore and production deployment are not qualified. A guide-only Node image exposed 92 tools with unchanged schemas; production remained on its prior image and authenticated reconnection was not verified.

## 2026-11-17 — Orca session ownership candidate

Changed the candidate GUI launch to use a private D-Bus session within the harness-owned launch group. The recorded group leader is the session runner; process identity checks, settlement deadlines and refusal of unexplained survivors remain unchanged. Earlier close failures remain unexplained. The wrapper, actual process topology, shutdown and checkpoint/restore remain subject to independent review and Linux runtime qualification.

## 2026-11-17 — Procfs disappearance handling

A process can disappear between opening and reading its procfs stat file, producing ESRCH. Process enumeration now skips that disappearance as it already skipped ENOENT; permission, I/O and parse errors remain fatal. The errno behind earlier close failures was not captured, so those failures are not attributed to this correction. The deterministic Linux witness and runtime lifecycle remain to be validated.

## 2026-11-17 — Private runtime lifecycle qualification

The final isolated Linux fixture passed 56 of 56 tests without skips in 14.823 seconds, including a real kernel ESRCH disappearance and forced process-group TERM/KILL. The uninstrumented runtime image `3fddb1d70090cc0042aa7c93f0319479a1c911c474c2ae22bab54b39e7798376` passed startup and cleanup; its session runner, private bus and GUI shared a process group and Xvfb was separate. Legacy and modern clients saw 57 tools and ready state with the X2D 0.4 mm and BBL PLA presets, no jobs or dialogs. An existing staged cube survived a successful checkpoint and close, same-ID restore with presets, and a second successful checkpoint and close. Each close left only init and supervisor; final state was idle without recovery, and containers exited zero without OOM or descendants. The earlier slice/export/adoption trial remains separate and did not print.

The ESRCH fix addresses a demonstrated kernel and source bug; the earlier failed close cannot be attributed to it because that failure's errno was not captured. The guide-only Node candidate exposed 92 tools with unchanged schema and passed its guide smoke check. The staged offline private authorization gate passed. Managed deployment, public OAuth and user-client verification remain pending; production is unchanged, the public slicer route returns 404, and the printer-only private plugin remains at 0.1.0 with the 0.1.1 candidate not uploaded.

## 2026-11-17 — Managed shared-workspace deployment

The managed Node image exposed 92 tools and the separate network-isolated Orca image uses its private bus, workspaces and data-only artifact mounts. The authorization service retained its existing key material and encrypted state containing 71 records, with matching fingerprints, while serving independently scoped printer and slicer OAuth resources. Public normal-TLS metadata returned successfully for both resources, with their respective scopes and issuers, 401 behavior, S256 and dynamic registration verified. No proxy, router or certificate change was needed. The existing writer used the same mounts without restore, reseed or an old writer; equality across termination was observed, but no historical post-start digest comparison was retained. Shutdown took about 0.44 seconds, exited 143 with no logged errors or descendants, and does not establish global operation quiescence.

The private 0.1.1 plugin was updated under the same identity with both MCPs and retained skills; the user reported both connected. Authenticated printer readiness and empty configured workspace status succeeded without dispatch. The existing Codex session had not loaded the new slicer tools, so public slicer tool invocation and a user-client attachment handoff remain unverified. Native global Codex and Claude Code user slicer entries were added without replacing the printer entries. No new physical print or universal model qualification follows. There is no supported global active-operation drain inventory; SIGTERM cancels and waits briefly for settlement rather than passively draining.
