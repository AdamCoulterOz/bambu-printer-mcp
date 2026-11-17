# TUTK camera and file application wire

This protocol-facts note records source attribution for the direct implementations and refers to Open Bamboo Networking commit [`77de55a8c696c53125ca297bdf3fdf1258772335`](https://github.com/ClusterM/open-bamboo-networking/tree/77de55a8c696c53125ca297bdf3fdf1258772335), plus Android Handy 4.4.1 APK SHA-256 `88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506`. The vendor network plugin is closed; observations in the pinned research describe particular captures and models. `tests/fixtures/tutk-wire/vectors.json` is wholly synthetic. It contains no device identity, real filenames, credential, key, photograph or network capture. A fixture or successful decoder does not establish printer compatibility.

## Credential and readiness evidence

Handy's `IotLiveviewApi.java:13–14` uses `POST iot-service/api/user/ttcode` with account authorization and app proof-of-possession headers; `FetchTTCodeRequest` supplies `dev_id` and a protocol list, with `channel_name` optional. A `tutk` response must provide the current ticket, auth key, password and region for the chosen account/printer. Treat these as secrets and bind the request to the selected account and device; never log or return them. The documented stock trace says the cloud mint also sends the printer a signed `liveview.prepare` (`research/08.11-camera.md:35,52–74`). A successful HTTP response alone does not prove a session is ready.

Pinned OBN `src/agent.cpp:1309–1376,1734–1795` observes a prepare success **or** an already-enabled server, waits at most five seconds and returns its URL even on timeout. Its implementation also sends a separate prepare; its stock-traffic research says the cloud sends that command, so do not conflate these behaviours. Handy's `LiveviewRepository.java:746–865,880–881` sends a prepare and waits on a TUTK-state predicate; `:557–604` explicitly continues to connect after the five-second wait times out. Neither source requires a fresh matching prepare **and** a fresh enabled report before attempting a connection. The connection and application exchange establish their own result; do not claim readiness from an HTTP receipt or invent firmware evidence. No additional prepare is implied by the direct client contract.

## AV and frame layout

All offsets below are byte offsets, integer fields little-endian. These describe DTLS application records, not the outer IOTC transport. `src/camera/tutk/TutkSession.cpp:28–102,158–181`, `src/camera/tutk/IotcProtocol.hpp:28–35`, and `research/06.07-tutk.md:51–104` are the pinned references.

| Item | Fields and meaning |
| --- | --- |
| AV header | Eight bytes: type `[0]`, flag `[1]`, version `0x000b` LE16 `[2]`, packet counter LE16 `[4]`; remaining two bytes reserved/opaque. |
| Login | 570 bytes; payload length 546 at `[16]`, nonce LE32 `[20]`; payload begins `[24]` with `admin`, password at payload offset 257. Send framed steps `0x00` and `0x20`; capability block selects framed mode. Do not log bytes containing the password. |
| Framed control | Type `0x0c`; after AV header an eight-byte group header has `k=0`, then control body. For one slice: body `[0..1]=00 70`, request index LE16 `[2]`, count LE32 `[4]=1`, length LE32 `[8]=4+data_length`, request index LE32 `[12]`, IO type LE32 `[20]`, data `[24..]`. JSON request is UTF-8 bytes, not a C string. |
| IO type `0x01ff` / `0x02ff` | Start/stop camera. Data is channel LE32 followed by four zero bytes; framed channel 0 only. Legacy video requests channels 0 and 1. |
| IO type `0x3001` | File-browser JSON request; unlike LAN framing, do not prepend `mtype` to these browser requests. CTRL mode starts no camera stream. Pinned reference accepts at most 1200 request bytes (`TutkSession.hpp:35–42`); stock `avSendIOCtrl` can slice larger messages, but that is not evidence for this implementation. |
| Framed stream group | `0x0c` plus optional embedded probe when flag bit 3 is set, then group LE16, packet index byte, data count `k` byte, parity count `m` LE32. Index `<k` contains a data slice; index `>=k` is parity. `k+m` must fit 255. |
| Slice | 20-byte header: kind `[0]`, last flag `[1]`, global slice counter LE16 `[2]`, count LE16 `[4]`, slice index LE16 `[6]` or last-slice trailer length `[6]`, data length LE16 `[8]`, frame number LE32 `[12]`, next frame LE32 `[16]`; payload begins `[20]`. Reject zero count, invalid index or truncated data. Last-slice trailer is typically 16 bytes. |
| Kinds | `5` keyframe, `7` inter-frame, `4` audio. Repeats may use `6` and the same frame number. CTRL frames must not be subject to video keyframe gating. Duplicate packets/frames must not duplicate a completed file chunk. |
| Frame info | Pinned research identifies codec at trailer `[0]` (`0x4e` H.264), keyframe flag `[2]`, timestamp LE32 milliseconds `[12]`. Remove the declared trailer before passing content to a decoder or CTRL parser. Legacy framing can put 16-byte info **before** Annex-B content. |
| Sample units | OBN `stubs/BambuSource.cpp:199–205,809–835,2365–2380` exposes track `0`; video `flags & 1` identifies a keyframe, `decode_time` is 100 ns units (`nanoseconds / 100`). CTRL sample timestamp is set to zero. This ABI timestamp is not a physical capture timestamp. |

The `framed_ctrl_reply_two_slices` vector contains synthetic text, not camera content. It exercises the last-slice trailer and complete-frame reconstruction. An inter-frame must not be treated as independently decodable after an unrecoverable video gap; permit CTRL frames without that video-specific gate (`TutkSession.cpp:314–407`).

## Link control and FEC

| Wire item | Source-backed facts |
| --- | --- |
| Heartbeat | Type `0x09`, 24 bytes, roughly every 100 ms. Previously/currently reported receive counters at `[8]`/`[10]`, heartbeat counter `[18]`, 16-bit millisecond clock `[20]`. First packet has `ff` at bytes `[8..14)`. |
| Probe | Type `0x0a`, flag `0x08`, 16 bytes, roughly every 200 ms; 16-bit clock `[8]`, RTT estimate `[10]`, first marker `0x30` LE32 `[12]`, later `1`. |
| Probe ACK | Type `0x0b`, 20 bytes, byte `[6]=0x1f`; echoed clock LE16 `[8]`, receive count LE16 at both `[10]` and `[12]`. No packet-counter increment for this ACK. Legacy ACK uses a different counted shape (`TutkSession.cpp:544–617`). |
| FEC | Systematic Reed–Solomon GF(2^8), polynomial `0x11d`, Vandermonde row `r^c`, systematic generator `V * inverse(V[0:k])`; data shorter than the coded length is zero-padded. `k=2` parity row 2 coefficients are `[3,2]`; the fixture is a small arithmetic check, not a packet capture. A parity body contains a 20-byte header and its coded length is LE16 at `[8]`. Recover only with enough distinct valid rows; verify the recovered slice header and length (`Fec.cpp:12–26,79–137`, `TutkSession.cpp:190–235,286–309`). |

## Printer file browser

Requests are serialized per CTRL session. `cmdtype` and `sequence` identify a reply, not `result` alone. `src/tunnel_local.cpp:281–298,323–339` and `research/09.05-ctrl.md:110–155,09.06-commands.md:3–58` describe these fields. File-browser request JSON travels in IO type `0x3001`, without `mtype`; replies are reassembled frame bytes `<JSON>[\n\n<binary>]`. `mtype:12289` may appear in replies. A notification `cmdtype:0x100` or `0x101`, or the observed unsolicited `cmdtype` and `sequence` both `0xffffffff`, is not a matching response.

| Code | Purpose / shape |
| --- | --- |
| `1` LIST_INFO | `req.type` is `model`, `video`, or `timelapse`; request uses `api_version:2`, `notify:"DETAIL"` and optional `storage`. `reply.file_lists` is an array. Preserve actual returned paths; never derive host filesystem paths from them. |
| `2` SUB_FILE | Archive member / video thumbnail request; optional `\n\n` binary replies may be multi-frame. Out of scope for a whole-file downloader. |
| `3` FILE_DEL | Destructive; not an authorized read action. |
| `4` FILE_DOWNLOAD | `req.path` is the exact absolute printer path, `offset` starts at `0`; received chunks follow JSON and `\n\n`. Correlate command and sequence, check offset/size/total, order and bounds. `result:1` continues, `0` completes, all other values fail; on completion verify the stated `file_md5` over the exact assembled bytes. `mem_dl_param_size` denotes a separate metadata blob, not file bytes; reject it if memory-file downloads are unsupported. |
| `5` FILE_UPLOAD | Mutating and out of scope. Its negotiated `chunk_size` is KiB, not bytes; e.g. 31 means 31,744 bytes. |
| `7` REQUEST_MEDIA_ABILITY | Reports media capabilities, not proof that a specific file can be downloaded. |
| `0x100`, `0x101` | Asynchronous list change/resync notifications. |
| `0x1000` TASK_CANCEL | Cancels in-flight file tasks; not a reason to replay a request. |

`result:2` is JSON error; `14` file read/write error; `17` storage unavailable; `18` API version unsupported. `19` means file exists in the documented upload flow, not generic success. Storage labels are model and operation dependent: on the documented X2D, empty/external listed USB models, while internal/emmc/udisk/sdcard listed internal models; this is not a universal storage mapping. Listing does not imply reading a model is allowed: `research/09.06-commands.md:49–75` documents internal-model restrictions and the `fun2` bit-17 correlation on several printers.

## Helper comparison and validation limits

The existing private sidecar adds a 12-byte local process envelope (`size`, `track`, `flags` as LE32) around ABI samples; this is **not** on the network. Its parser admits only track 0 and its download path demands contiguous offsets, consistent total and final MD5. It deliberately rejects memory-download metadata, caps a file at 16 MiB, and handles only the listed storage/category values. Those bounds are application policy, not firmware limits. The sidecar's fixed request sequence 1 is valid for its one-request session; a reusable direct session must correlate its own sequence. The reference has a legacy video fallback but rejects legacy mode for CTRL (`TutkSession.cpp:703–719`). Reassembled framed CTRL uses slice kind 5 in observed traffic; kind 6 repeat handling and unsolicited frames must not be mistaken for a second result.

The wire vectors check exact header endianness, fixed IO types, a bounded JSON request, a synthetic split reply/trailer, final binary delimiter and MD5, one FEC arithmetic example, probe-ACK bytes, and malformed slice refusal. They do not test UDP traversal, DTLS, camera decode, real device replies, rate limits, account permissions, live readiness, or actual file browsing. In particular, the current live file-list attempt stopped at the prior readiness gate before invoking the native helper; it is not evidence of a CTRL failure.
