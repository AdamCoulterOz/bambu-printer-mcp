# Remote camera and files

The direct TUTK path provides `remote_camera_snapshot` for one JPEG, `remote_list_files` for bounded model, video or timelapse metadata, and `remote_download_file` for a checked file in an existing workspace. These explicit remote tools retain their names, inputs and outputs. The existing local camera and file tools keep their own behavior. Downloaded models and G-code still require normal inspection and print authorization.

See [configuration](#configuration), [operation lifetime](#operation-lifetime), [protocol and evidence](#protocol-and-evidence), and [limits](#limits). For the complete agent process, request the camera, signing and dispatch topics with `get_agent_guide`.

## Configuration

The operator enables `BAMBU_TUTK_ENABLED=true` and supplies:

- `BAMBU_TUTK_OPERATION_LOCK_FILE`: an absolute, pre-created stable single-link regular file, inaccessible to other users, shared by cooperating HA and MCP consumers.
- `BAMBU_SIGNING_DIR` and `BAMBU_SIGNING_STATE_DIR`: validated application credentials and private persistent state.
- `BAMBU_HANDY_OS_VERSION`: the explicit Handy-compatible runtime profile version; do not copy another device's identity.
- A configured Bambu account bound to the selected printer, through the cached account session or the complete explicit cloud credential tuple.

Camera decoding requires `ffmpeg` in the server runtime. Account login alone does not supply application signing material. The managed signing setup and optional on-demand renewal remain available; see [signing provisioning](signing-provisioning.md). Keep account and signing material in private server configuration.

The direct remote path needs no vendor networking binary, separate native TUTK helper service, helper URL or bearer token. Its UDP/IOTC, DTLS, FEC, AV and file-control modules are packaged ahead of time with the MCP; cryptography uses the runtime's OS crypto and the camera codec uses local `ffmpeg`.

## Operation lifetime

One request acquires the shared OS lock, verifies account binding and current authority, and mints one TUTK ticket using validated application HTTP proof. It then attempts an authenticated direct TUTK session. There is no per-operation cloud MQTT readiness watcher or duplicate prepare command. A ticket response alone does not prove the printer is ready: the direct connection and application exchange must succeed.

Each operation owns its sockets, DTLS state and timers. Cancellation and errors close and settle that request's direct transport before releasing the lock. Other applications, including Handy, do not share the lock; their concurrent requests and process crashes can still interfere. Failures do not automatically remint or replay.

The server includes `remote_upload_file`, `remote_delete_file`, `remote_archive_members` and `remote_archive_extract`. Upload requires an exact bounded workspace artifact, internal storage and explicit consent to possible history rotation. Delete requires an exact fresh listing and confirmation; the listing and deletion are not atomic. Archive operations use checked bounded downloads and exact members; extracted data does not authorize printing. Failure or interruption may leave a mutation's outcome uncertain; inspect printer storage before a deliberate new attempt. Remote writes have no live mutation qualification.

Account and printer credentials remain internal. Listings return allowlisted metadata, snapshots use MCP image content, and downloads return workspace artifact metadata rather than file contents. File size and printer MD5 are checked before publication; the workspace also records SHA-256.

## Protocol and evidence

The reviewed Handy 4.4.1 APK SHA-256 is `88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506`. Its `IotLiveviewApi`, `FetchTTCodeRequest` and `LiveviewRepository` identify the Handy ticket request `{dev_id, protocols:["tutk"]}` without a fabricated firmware version. The client generates its own private stable device UUID.

Protocol facts are documented in [TUTK wire reference](protocol/tutk-wire.md), based on [Open Bamboo Networking commit 77de55a8c696c53125ca297bdf3fdf1258772335](https://github.com/ClusterM/open-bamboo-networking/tree/77de55a8c696c53125ca297bdf3fdf1258772335). Synthetic shared wire vectors, independent protocol oracles and OpenSSL peer checks exercise the implementation. Normal authenticated camera, listing and checked download reads succeeded on one selected printer. These reads do not qualify other printers or firmware.

## Limits

Snapshots are single JPEGs, bounded to 4 MiB. Downloads are bounded to 16 MiB; listings project at most 4,096 entries. Read success does not establish continuous video or physical print readiness. Remote mutations remain unqualified by live execution.
