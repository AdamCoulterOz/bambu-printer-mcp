import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, constants as C } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { privateLockHeld, withPrivateLock } from './safety/private-lock.js';

/** A deliberately small, stable error surface: never include URLs or OS error text. */
export class WorkspaceArtifactError extends Error {
  constructor(public code: string, message: string, public next_action: string) { super(message); this.name = 'WorkspaceArtifactError'; }
}
const fail = (code: string, message: string, next = 'Check the arguments and workspace status before retrying.'): never => { throw new WorkspaceArtifactError(code, message, next); };
const id = () => randomBytes(32).toString('base64url');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
const hashOk = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const filename = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 200 || !/^(?:[^/\\\x00-\x1f]+\.(stl|3mf|step|stp|obj|amf|svg|gcode|png|jpe?g|webp|mp4|mov|xml|json|config|txt|rels|model)|\.rels)$/i.test(v) || v === '.' || v === '..') return fail('INVALID_FILENAME', 'Unsupported or unsafe filename.');
  return v;
};
const integer = (v: unknown, min: number, max: number): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('INVALID_ARGUMENT', 'Expected a bounded integer.');
const num = (name: string, fallback: number, max: number) => {
  const v = process.env[name]; if (v === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) return fail('INVALID_CONFIGURATION', `Invalid ${name}.`, 'Correct the server configuration.');
  return Number(v);
};
type Entry = { filename: string; size_bytes: number; sha256: string; created?: number; updated?: number; offset?: number; kind?: string; ticket_hash?: string; ticket_expires?: number };
type State = { version: 1; workspaces: Record<string, { name?: string; uploads: Record<string, Entry>; artifacts: Record<string, Entry> }> };
type Config = { root: string; outbox?: string; uploadBase?: URL; gid?: number; maxFile: number; maxTotal: number; slots: number; workspaces: number; idle: number; hard: number };
function config(): Config {
  const root = process.env.BAMBU_ARTIFACT_DIR;
  if (!root || !path.isAbsolute(root)) return fail('FEATURE_UNAVAILABLE', 'Artifact storage is not configured.', 'Configure an absolute BAMBU_ARTIFACT_DIR.');
  const group = process.env.BAMBU_ARTIFACT_GROUP_GID;
  if (group !== undefined && (!/^\d+$/.test(group) || !Number.isSafeInteger(Number(group)))) return fail('INVALID_CONFIGURATION', 'Invalid artifact group.', 'Correct BAMBU_ARTIFACT_GROUP_GID.');
  const outbox = process.env.BAMBU_ARTIFACT_OUTBOX_DIR;
  if (outbox && !path.isAbsolute(outbox)) return fail('INVALID_CONFIGURATION', 'Outbox path must be absolute.');
  let uploadBase: URL | undefined;
  if (process.env.BAMBU_ARTIFACT_UPLOAD_BASE_URL) {
    try { uploadBase = new URL(process.env.BAMBU_ARTIFACT_UPLOAD_BASE_URL); } catch { return fail('INVALID_CONFIGURATION', 'Invalid artifact upload base URL.'); }
    if (uploadBase.protocol !== 'https:' || uploadBase.username || uploadBase.password || uploadBase.search || uploadBase.hash || (uploadBase.port && uploadBase.port !== '443') || uploadBase.pathname.endsWith('/')) return fail('INVALID_CONFIGURATION', 'Artifact upload base URL must be a bare HTTPS route without a trailing slash.');
  }
  const c = { root: path.resolve(root), outbox: outbox && path.resolve(outbox), uploadBase, gid: group === undefined ? undefined : Number(group), maxFile: num('BAMBU_ARTIFACT_MAX_FILE_BYTES', 128 * 1024 ** 2, 1024 ** 3), maxTotal: num('BAMBU_ARTIFACT_MAX_TOTAL_BYTES', 2 * 1024 ** 3, 64 * 1024 ** 3), slots: num('BAMBU_ARTIFACT_MAX_SLOTS', 512, 4096), workspaces: num('BAMBU_ARTIFACT_MAX_WORKSPACES', 128, 1024), idle: num('BAMBU_ARTIFACT_UPLOAD_IDLE_SECONDS', 3600, 86400) * 1000, hard: num('BAMBU_ARTIFACT_UPLOAD_HARD_SECONDS', 14400, 604800) * 1000 };
  if (c.idle > c.hard) return fail('INVALID_CONFIGURATION', 'Upload idle lease exceeds hard lease.');
  return c;
}
async function noLinks(p: string) {
  let current = path.parse(p).root;
  for (const part of path.resolve(p).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = await fs.lstat(current);
    if (s.isSymbolicLink()) fail('UNSAFE_STORAGE', 'A storage path contains a symbolic link.', 'Repair the configured storage paths.');
  }
}
async function directory(p: string, mode: number): Promise<boolean> {
  let created = false;
  try { await fs.mkdir(p, { mode }); created = true; } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await noLinks(p); const st = await fs.lstat(p); if (!st.isDirectory()) fail('UNSAFE_STORAGE', 'A storage directory is invalid.');
  // Also sync existing entries: an earlier initialization may have failed
  // after mkdir but before its parent was durably synced.
  await syncDir(p); await syncDir(path.dirname(p));
  return created;
}
async function ownedDirectory(p: string, mode: number) {
  const created = await directory(p,mode); const st=await fs.stat(p);
  if (st.uid!==process.getuid?.() || (st.mode & 0o022) || (!created && (st.mode & 0o7777)!==mode)) fail('UNSAFE_STORAGE','Private store directory ownership or permissions are invalid.');
  if (created) { await fs.chmod(p,mode); await syncDir(p); }
}
async function init(c: Config) {
  await noLinks(c.root); const rootStat = await fs.stat(c.root);
  if (!rootStat.isDirectory() || rootStat.uid!==process.getuid?.() || (rootStat.mode & 0o022)) fail('UNSAFE_STORAGE', 'Artifact root ownership or permissions are invalid.');
  await ownedDirectory(path.join(c.root,'private'),0o700); await ownedDirectory(path.join(c.root,'private','incoming'),0o700); await ownedDirectory(path.join(c.root,'private','tombstones'),0o700);
  const pub=path.join(c.root,'published'); const created=await directory(pub,0o2750);
  let st=await fs.stat(pub); const gid=c.gid ?? rootStat.gid;
  if (c.gid===undefined && !(rootStat.mode & 0o2000)) fail('INVALID_CONFIGURATION','Artifact root must have an inherited setgid group.','Configure a setgid artifact root or BAMBU_ARTIFACT_GROUP_GID.');
  if (created) { if (st.gid!==gid) await fs.chown(pub,-1,gid); await fs.chmod(pub,0o2750); await syncDir(pub); st=await fs.stat(pub); }
  if (st.uid!==process.getuid?.() || st.gid!==gid || (st.mode & 0o7777)!==0o2750) fail('UNSAFE_STORAGE','Published directory ownership or permissions are invalid.');
}

async function syncDir(p: string) { const h = await fs.open(p, 'r'); try { await h.sync(); } finally { await h.close(); } }
async function checkPublishedDirectory(c: Config, p: string) { await noLinks(p); const [st,root]=await Promise.all([fs.stat(p),fs.stat(path.join(c.root,'published'))]); if (!st.isDirectory() || st.uid!==process.getuid?.() || st.gid!==root.gid || (st.mode & 0o7777)!==0o2750) fail('UNSAFE_STORAGE','Published directory ownership or permissions are invalid.'); }
async function checkPublishedFile(c: Config, p: string) { const [st,root]=await Promise.all([fs.lstat(p),fs.stat(path.join(c.root,'published'))]); if (!st.isFile() || st.uid!==process.getuid?.() || st.gid!==root.gid || (st.mode & 0o7777)!==0o440) fail('UNSAFE_STORAGE','Published file ownership or permissions are invalid.'); }
async function reconcile(c: Config, s: State): Promise<string[]> {
  const cleanup: string[] = [];
  const tombRoot=path.join(c.root,'private','tombstones');
  for (const marker of await fs.readdir(tombRoot)) {
    if (!marker.endsWith('.json') || !validId(marker.slice(0,-5))) continue;
    const token=marker.slice(0,-5); const raw=await readRegular(path.join(tombRoot,marker),4096); let intent: any;
    try { intent=JSON.parse(raw.toString('utf8')); } catch { return fail('UNSAFE_STORAGE','Deletion intent is invalid.'); }
    if (!validId(intent.workspace_id) || !validId(intent.artifact_id) || !hashOk(intent.sha256)) fail('UNSAFE_STORAGE','Deletion intent is invalid.');
    const w=s.workspaces[intent.workspace_id], e=w?.artifacts[intent.artifact_id];
    if (e && e.sha256!==intent.sha256) fail('UNSAFE_STORAGE','Deletion intent conflicts with the ledger.');
    const source=path.join(c.root,'published',intent.workspace_id,intent.artifact_id), target=path.join(tombRoot,token);
    try { await fs.rename(source,target); await syncDir(path.dirname(source)); await syncDir(tombRoot); } catch (err: any) { if (err.code !== 'ENOENT') throw err; if (e) { try { const st=await fs.lstat(target); if (!st.isDirectory()) fail('UNSAFE_STORAGE','Deletion tombstone is invalid.'); } catch { fail('UNSAFE_STORAGE','Deletion source and tombstone are missing.'); } } }
    if (w) delete w.artifacts[intent.artifact_id]; cleanup.push(token);
  }
  const pub = path.join(c.root, 'published');
  for (const wd of await fs.readdir(pub, { withFileTypes: true })) {
    if (!wd.isDirectory() || !validId(wd.name)) fail('UNSAFE_STORAGE', 'Unexpected published entry.');
    await checkPublishedDirectory(c,path.join(pub,wd.name));
    for (const ad of await fs.readdir(path.join(pub, wd.name), { withFileTypes: true })) {
      if (ad.isDirectory() && /^\.pending-[A-Za-z0-9_-]{43}$/.test(ad.name)) { await fs.rm(path.join(pub,wd.name,ad.name),{recursive:true}); continue; }
      if (!ad.isDirectory() || !validId(ad.name)) fail('UNSAFE_STORAGE', 'Incomplete published transaction requires inspection.');
      const dir=path.join(pub,wd.name,ad.name), w=s.workspaces[wd.name]; await checkPublishedDirectory(c,dir);
      if (!w) fail('UNSAFE_STORAGE','Published artifact has no workspace.');
      if (!w.artifacts[ad.name]) {
        await checkPublishedFile(c,path.join(dir,'.artifact.json')); const raw=await readRegular(path.join(dir,'.artifact.json'),4096); let m: any;
        try { m=JSON.parse(raw.toString('utf8')); } catch { return fail('UNSAFE_STORAGE','Published manifest is invalid.'); }
        if (m.version!==1 || m.workspace_id!==wd.name || m.artifact_id!==ad.name || !validId(m.upload_id) || !hashOk(m.sha256) || !Number.isSafeInteger(m.size_bytes) || m.size_bytes<0 || m.size_bytes>c.maxFile) fail('UNSAFE_STORAGE','Published manifest is invalid.');
        const fn=filename(m.filename), u=w.uploads[m.upload_id];
        if ((!u && m.source!=='adopt') || (u && (u.filename!==fn || (u.sha256 && u.sha256!==m.sha256) || (u.kind !== 'network' && u.size_bytes!==m.size_bytes)))) fail('UNSAFE_STORAGE','Published transaction conflicts with its reservation.');
        if (!u) quota(s,c,m.size_bytes);
        await checkPublishedFile(c,path.join(dir,fn)); const b=await readRegular(path.join(dir,fn),c.maxFile); if (b.length!==m.size_bytes || digest(b)!==m.sha256) fail('INTEGRITY_MISMATCH','Recovered artifact failed verification.');
        w.artifacts[ad.name]={filename:fn,size_bytes:m.size_bytes,sha256:m.sha256}; delete w.uploads[m.upload_id]; await fs.rm(inputPath(c,m.upload_id),{force:true});
      }
    }
  }
  for (const w of Object.values(s.workspaces)) for (const [uid,u] of Object.entries(w.uploads)) {
    if (u.kind === 'http-streaming') { if (!await privateLockHeld(streamingLockPath(c,uid))) { delete w.uploads[uid]; await fs.rm(inputPath(c,uid),{force:true}); } continue; }
    if (u.kind !== 'upload' && u.kind !== 'http' && u.kind !== 'http-streaming') continue;
    const h=await fs.open(inputPath(c,uid),C.O_RDWR|C.O_NOFOLLOW); try { const st=await h.stat(); if (!st.isFile() || st.size<(u.offset??0)) fail('UNSAFE_STORAGE','Upload is shorter than its committed offset.'); if (st.size>(u.offset??0)) { await h.truncate(u.offset??0); await h.sync(); } } finally { await h.close(); }
  }
  return cleanup;
}
async function verifyLedger(c: Config, s: State) {
  const incoming = path.join(c.root, 'private', 'incoming');
  const expected = new Set<string>();
  for (const w of Object.values(s.workspaces)) for (const [uid, u] of Object.entries(w.uploads)) if (u.kind === 'upload' || u.kind === 'http' || (u.kind === 'http-streaming' && (await privateLockHeld(streamingLockPath(c,uid))))) expected.add(uid);
  const actual = await fs.readdir(incoming, { withFileTypes: true });
  for (const e of actual) { if (!e.isFile() || !validId(e.name)) fail('UNSAFE_STORAGE','Unexpected incoming entry.'); if (!expected.has(e.name)) await fs.rm(path.join(incoming,e.name)); }
  if (actual.filter(e=>expected.has(e.name)).length !== expected.size) fail('UNSAFE_STORAGE', 'Upload ledger and files disagree.', 'Inspect the store before further changes.');
  const pub = path.join(c.root, 'published');
  for (const [wid,w] of Object.entries(s.workspaces)) for (const [aid,e] of Object.entries(w.artifacts)) { const dir=path.join(pub,wid,aid); await checkPublishedDirectory(c,dir); await checkPublishedFile(c,path.join(dir,e.filename)); }
  for (const wd of await fs.readdir(pub, { withFileTypes: true })) {
    if (!wd.isDirectory() || !validId(wd.name)) fail('UNSAFE_STORAGE', 'Published store contains an unexpected entry.');
    for (const ad of await fs.readdir(path.join(pub, wd.name), { withFileTypes: true })) {
      if (!ad.isDirectory() || !validId(ad.name) || !s.workspaces[wd.name]?.artifacts[ad.name]) fail('UNSAFE_STORAGE', 'Published ledger and files disagree.', 'Inspect the store before further changes.');
    }
  }
}
async function saveLedger(c: Config, state: State) {
  const temp=path.join(c.root,'private',`ledger-${id()}`), h=await fs.open(temp,'wx',0o600);
  try { await h.writeFile(JSON.stringify(state)); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp,path.join(c.root,'private','ledger.json')); await syncDir(path.join(c.root,'private'));
}
async function locked<T>(c: Config, fn: (s: State) => Promise<T>): Promise<T> {
  await init(c);
  const helper = fileURLToPath(new URL('../scripts/artifact-store-lock.py', import.meta.url));
  const lock = await fs.open(path.join(c.root, 'private', 'store.lock'), C.O_CREAT | C.O_RDWR | C.O_NOFOLLOW, 0o600);
  try {
    const stat = await lock.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('UNSAFE_STORAGE', 'Artifact lock ownership or permissions are invalid.');
    const child = spawn('python3', [helper, 'lock'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] });
    await new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('helper')); });
      child.once('close', code => { clearTimeout(timer); if (!timedOut && code === 0) resolve(); else reject(new Error('helper')); });
    }).catch(() => fail('LOCK_UNAVAILABLE', 'Artifact storage locking is unavailable.', 'Install Python 3 with fcntl and verify the packaged lock helper.'));
    const ledger = path.join(c.root, 'private', 'ledger.json'); let state: State;
    try { const h = await fs.open(ledger, C.O_RDONLY | C.O_NOFOLLOW); try { state = JSON.parse(await h.readFile('utf8')); } finally { await h.close(); } }
    catch (e: any) { if (e.code === 'ENOENT') state = { version: 1, workspaces: {} }; else throw e; }
    if (state.version !== 1 || !state.workspaces || typeof state.workspaces !== 'object') fail('UNSAFE_STORAGE', 'Artifact ledger is invalid.');
    const cleanup=await reconcile(c, state);
    await verifyLedger(c, state);
    // Commit recovered publications before applying leases: a finalized artifact
    // stays durable even if its original upload reservation has since expired.
    await saveLedger(c,state);
    if (cleanup.length) { for (const token of cleanup) { await fs.rm(path.join(c.root,'private','tombstones',token),{recursive:true,force:true}); await fs.rm(path.join(c.root,'private','tombstones',`${token}.json`),{force:true}); } await syncDir(path.join(c.root,'private','tombstones')); }
    const now=Date.now(), expired: string[]=[];
    for (const w of Object.values(state.workspaces)) for (const [uid,u] of Object.entries(w.uploads)) { if (u.kind==='http-streaming' && await privateLockHeld(streamingLockPath(c,uid))) continue; if (now-(u.updated??0)>c.idle || now-(u.created??0)>c.hard) { expired.push(uid); delete w.uploads[uid]; } }
    if (expired.length) { await saveLedger(c,state); for (const uid of expired) await fs.rm(inputPath(c,uid),{force:true}); }
    const result = await fn(state);
    await saveLedger(c,state);
    return result;
  } finally { await lock.close(); }
}
function workspace(s: State, wid: unknown) {
  if (!validId(wid)) return fail('INVALID_WORKSPACE', 'Workspace ID is malformed.', 'Attach the exact 43-character workspace ID.');
  return s.workspaces[wid] ?? fail('WORKSPACE_NOT_FOUND', 'Workspace is not attached.', 'Call workspace_attach with the shared workspace ID.');
}
function quota(s: State, c: Config, size: number) {
  let bytes = 0, count = 0;
  for (const w of Object.values(s.workspaces)) for (const e of [...Object.values(w.uploads), ...Object.values(w.artifacts)]) { bytes += e.size_bytes; count++; }
  if (count >= c.slots || bytes + size > c.maxTotal) fail('QUOTA_EXCEEDED', 'Artifact storage quota is exhausted.', 'Delete unneeded artifacts or abort uploads.');
}
function getId(v: unknown, kind: string): string { if (!validId(v)) return fail('INVALID_ARGUMENT', `Invalid ${kind} ID.`); return v; }
const inputPath = (c: Config, uid: string) => path.join(c.root, 'private', 'incoming', uid);
const streamingLockPath = (c: Config, uid: string) => path.join(c.root, 'private', 'http-locks', uid);
const result = (wid: string, aid: string, e: Entry, c: Config) => ({ version: 1, workspace_id: wid, artifact_id: aid, filename: e.filename, size_bytes: e.size_bytes, sha256: e.sha256, file_path: path.join(c.root, 'published', wid, aid, e.filename) });
async function readRegular(p: string, max: number): Promise<Buffer> {
  await noLinks(path.dirname(p)); const h = await fs.open(p, C.O_RDONLY | C.O_NOFOLLOW);
  try { const before = await h.stat(); if (!before.isFile() || before.size > max) fail('UNSAFE_STORAGE', 'File is not a bounded regular file.'); const b = await h.readFile(); const after = await h.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || b.length !== before.size) fail('FILE_CHANGED', 'File changed during verification.'); return b; } finally { await h.close(); }
}
async function readExport(c: Config, wid: string, eid: string): Promise<[Buffer, Buffer]> {
  const helper = fileURLToPath(new URL('../scripts/artifact-store-lock.py', import.meta.url));
  const gid = (await fs.stat(path.join(c.root,'published'))).gid;
  const child = spawn('python3', [helper, 'read-export', c.outbox!, wid, eid, String(c.maxFile), String(gid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = []; let size = 0;
  return await new Promise<[Buffer, Buffer]>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > c.maxFile + 4100) child.kill(); else chunks.push(chunk); });
    child.on('error', reject);
    child.on('close', code => { if (code !== 0) { reject(new Error('export read')); return; } const data = Buffer.concat(chunks); if (data.length < 4 || data.readUInt32BE(0) > 4096 || data.length < 4 + data.readUInt32BE(0)) { reject(new Error('export framing')); return; } const n = data.readUInt32BE(0); resolve([data.subarray(4, 4+n), data.subarray(4+n)]); });
  }).catch(() => fail('UNSAFE_STORAGE', 'Export could not be read safely.', 'Inspect the outbox and export receipt.'));
}
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ticketHash = (value: string) => createHash('sha256').update(value).digest('hex');
const ticketEqual = (left: string | undefined, right: string) => !!left && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(ticketHash(right), 'hex'));
async function publish(c: Config, wid: string, w: State['workspaces'][string], uid: string, u: Entry, bytes: Buffer, options: {signal?:AbortSignal;assertAuthority?:()=>void|Promise<void>} = {}) {
  if (bytes.length !== u.size_bytes || digest(bytes) !== u.sha256) fail('INTEGRITY_MISMATCH', 'File size or SHA-256 does not match.', 'Inspect or abort the upload before retrying.');
  const root = path.join(c.root, 'published'); const wd = path.join(root, wid); if (await directory(wd, 0o2750)) { await fs.chmod(wd, 0o2750); await syncDir(root); } await checkPublishedDirectory(c,wd);
  const aid = id(); const temp = path.join(wd, `.pending-${aid}`);let committed=false,created=false;try {
  await fs.mkdir(temp, { mode: 0o2750 });created=true;await fs.chmod(temp, 0o2750);
  const p = path.join(temp, u.filename); const h = await fs.open(p, 'wx', 0o440); try { await h.writeFile(bytes); await h.chmod(0o440); await h.sync(); } finally { await h.close(); }
  const mh=await fs.open(path.join(temp,'.artifact.json'),'wx',0o440); try { await mh.writeFile(JSON.stringify({version:1,workspace_id:wid,artifact_id:aid,upload_id:uid,source:u.kind,filename:u.filename,sha256:u.sha256,size_bytes:u.size_bytes})); await mh.chmod(0o440); await mh.sync(); } finally { await mh.close(); } await syncDir(temp);
  await options.assertAuthority?.();if(options.signal?.aborted)fail('CANCELLED','Operation was cancelled.');
  await fs.rename(temp, path.join(wd, aid));committed=true; await syncDir(wd); w.artifacts[aid] = { filename: u.filename, size_bytes: u.size_bytes, sha256: u.sha256 };
  await fs.rm(inputPath(c, uid), { force: true }); delete w.uploads[uid]; return result(wid, aid, w.artifacts[aid], c);
  } finally {if(created&&!committed)await fs.rm(temp,{recursive:true,force:true});}
}
const blocked = new net.BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as [string,number][]) blocked.addSubnet(address,bits,'ipv4');
for (const [address,bits] of [['::',128],['::1',128],['64:ff9b::',96],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]] as [string,number][]) blocked.addSubnet(address,bits,'ipv6');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
function publicIp(address: string): boolean { const family = net.isIP(address); return family !== 0 && (family !== 6 || globalV6.check(address,'ipv6')) && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'); }
async function download(url: string, max: number, callerSignal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (callerSignal?.aborted) cancel(); else callerSignal?.addEventListener('abort', cancel, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      downloadWithinDeadline(url, max, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new WorkspaceArtifactError('DOWNLOAD_FAILED', 'File download timed out.', 'Check the source and start a new import explicitly.')); }, 30000);
        controller.signal.addEventListener('abort', () => reject(new WorkspaceArtifactError(callerSignal?.aborted ? 'CANCELLED' : 'DOWNLOAD_FAILED', callerSignal?.aborted ? 'Operation was cancelled.' : 'File download timed out.', 'Check the source and start a new import explicitly.')), { once: true });
        if (controller.signal.aborted) reject(new WorkspaceArtifactError('CANCELLED', 'Operation was cancelled.', 'Start a new import explicitly.'));
      })
    ]);
  } finally { if (timeout) clearTimeout(timeout); callerSignal?.removeEventListener('abort', cancel); controller.abort(); }
}
async function downloadWithinDeadline(url: string, max: number, signal: AbortSignal): Promise<Buffer> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (signal.aborted) return fail('CANCELLED', 'Operation was cancelled.');
    let u: URL; try { u = new URL(current); } catch { return fail('DOWNLOAD_REJECTED', 'Download URL is invalid.'); }
    // A hosted MCP can fetch arbitrary public HTTPS sources itself. Short-lived
    // MakerWorld object URLs are intentionally not hostname-pinned here; every
    // hop is constrained by the HTTPS, DNS and IP checks below instead. Operators
    // can opt into a literal-host egress allowlist when their deployment needs it.
    const hosts = (process.env.BAMBU_ARTIFACT_TRUSTED_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const host = u.hostname.toLowerCase();
    const openAiFileHost = host === 'files.oaiusercontent.com' || host.endsWith('.files.oaiusercontent.com');
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443') || net.isIP(host) || (hosts.length > 0 && !openAiFileHost && !hosts.includes(host))) fail('DOWNLOAD_REJECTED', 'Download URL is outside the permitted HTTPS host scope.', 'Use a public HTTPS file host permitted by the server policy.');
    let addresses: Awaited<ReturnType<typeof dns.lookup>>[];
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch { return fail('DOWNLOAD_FAILED', 'Download host resolution failed.', 'Check the trusted host and retry explicitly.'); }
    if (signal.aborted) return fail('CANCELLED', 'Operation was cancelled.');
    if (!addresses.length || addresses.some(a => !publicIp(a.address))) fail('DOWNLOAD_REJECTED', 'Download host resolved to an unsafe address.');
    const selected = addresses[0];
    const response = await new Promise<{ status: number; location?: string; bytes: Buffer }>((resolve, reject) => {
      const req = https.get(u, { lookup: (_hostname, _options, cb) => cb(null, selected.address, selected.family), signal, timeout: 30000, headers: { accept: 'application/octet-stream' } }, res => {
        const status = res.statusCode ?? 0; const location = res.headers.location;
        if (status >= 300 && status < 400) { res.resume(); resolve({ status, location, bytes: Buffer.alloc(0) }); return; }
        if (status !== 200) { res.resume(); reject(new Error('status')); return; }
        const length = res.headers['content-length']; if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > max)) { res.destroy(); reject(new Error('size')); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) res.destroy(new Error('size')); else chunks.push(chunk); });
        res.on('end', () => { if (length !== undefined && size !== Number(length)) reject(new Error('length')); else resolve({ status, bytes: Buffer.concat(chunks) }); });
        res.on('error', reject);
      }); req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    }).catch(() => fail(signal?.aborted ? 'CANCELLED' : 'DOWNLOAD_FAILED', 'File download did not complete.', 'Check the source and start a new import explicitly.'));
    if (response.status >= 300 && response.status < 400) { if (!response.location || redirects === 3) fail('DOWNLOAD_REJECTED', 'Download redirect limit or location is invalid.'); try { current = new URL(response.location!, u).toString(); } catch { return fail('DOWNLOAD_REJECTED', 'Download redirect location is invalid.'); } continue; }
    return response.bytes;
  }
  return fail('DOWNLOAD_REJECTED', 'Download redirect limit exceeded.');
}
const str = { type: 'string' };
let activeImports = 0;
const specs: Array<[string,string,Record<string,object>,string[]]> = [
 ['workspace_create','Create a durable shared project ID.',{name:str},[]],
 ['workspace_attach','Attach an existing shared project ID without opening a GUI.',{workspace_id:str},['workspace_id']],
 ['workspace_status','Inspect storage configuration, or a workspace and its resumable uploads.',{workspace_id:str},[]],
 ['workspace_delete','Delete an empty Node workspace only.',{workspace_id:str},['workspace_id']],
 ['workspace_import_file','Import a public HTTPS file; completed artifacts are retained.',{workspace_id:str,file:{type:'object',properties:{download_url:str,file_id:str,mime_type:str,file_name:str},required:['download_url','file_id'],additionalProperties:false},source_url:str,filename:str,expected_sha256:str},['workspace_id']],
 ['workspace_upload_begin','Reserve an upload with expected size and SHA-256.',{workspace_id:str,filename:str,size_bytes:{type:'integer'},sha256:str},['workspace_id','filename','size_bytes','sha256']],
 ['workspace_upload_begin_https','Reserve a one-time raw HTTPS PUT URL for a client-local file. Supply its exact byte size and lowercase SHA-256, PUT raw bytes without base64 or an Authorization header, then call workspace_upload_finish with the returned upload_id.',{workspace_id:str,filename:str,size_bytes:{type:'integer'},sha256:str},['workspace_id','filename','size_bytes','sha256']],
 ['workspace_upload_chunk','Append a sequential base64 chunk, at most 512 KiB decoded.',{workspace_id:str,upload_id:str,offset:{type:'integer'},data_base64:str},['workspace_id','upload_id','offset','data_base64']],
 ['workspace_upload_finish','Verify and publish a complete upload.',{workspace_id:str,upload_id:str},['workspace_id','upload_id']],
 ['workspace_upload_abort','Delete an unfinished upload and release its reservation.',{workspace_id:str,upload_id:str},['workspace_id','upload_id']],
 ['workspace_artifact_info','Inspect a verified artifact and its server-local path.',{workspace_id:str,artifact_id:str},['workspace_id','artifact_id']],
 ['workspace_artifact_read','Read at most 256 KiB of a verified artifact as base64.',{workspace_id:str,artifact_id:str,offset:{type:'integer'},length:{type:'integer'}},['workspace_id','artifact_id']],
 ['workspace_artifact_delete','Delete an artifact after matching its SHA-256.',{workspace_id:str,artifact_id:str,sha256:str},['workspace_id','artifact_id','sha256']],
 ['workspace_adopt_export','Verify and copy an Orca outbox export into this workspace.',{workspace_id:str,export_id:str,sha256:str,size_bytes:{type:'integer'}},['workspace_id','export_id','sha256','size_bytes']],
];
const propertyDescriptions: Record<string,string> = {
  name:'Optional human-readable project name.', workspace_id:'The shared project workspace ID.',
  file:'An MCP client file object to download.', download_url:'A public HTTPS download URL.', file_id:'The client file identifier.', mime_type:'Optional MIME type.', file_name:'Original filename including its supported extension.',
  source_url:'A public HTTPS download URL; redirects are revalidated.', filename:'Filename including a supported extension.', expected_sha256:'Optional expected lowercase SHA-256 of the downloaded bytes.',
  size_bytes:'Exact file size in bytes.', sha256:'Expected lowercase SHA-256 of the exact bytes.', upload_id:'The unfinished upload ID. For HTTPS upload, call finish only after the PUT succeeds.', offset:'Byte offset for this chunk or read.', data_base64:'Base64-encoded sequential upload bytes.',
  artifact_id:'The workspace artifact ID.', length:'Maximum bytes to read.', export_id:'The finalized Orca export ID.'
};
function describeProperties(properties: Record<string,object>): Record<string,object> {
  return Object.fromEntries(Object.entries(properties).map(([key,value]) => {
    const schema = value as Record<string, any>;
    return [key, {...schema, description: propertyDescriptions[key], ...(schema.properties ? { properties: describeProperties(schema.properties) } : {})}];
  }));
}
export const workspaceArtifactTools: Tool[] = specs.map(([name,description,properties,required]) => ({ name, description, inputSchema:{type:'object',properties:describeProperties(properties),required,additionalProperties:false}, ...(name === 'workspace_import_file' ? { _meta: { 'openai/fileParams': ['file'] } } : {}) }));

/** The public route is fixed by deployment configuration, never by Host input. */
export function workspaceArtifactUploadPath(): string | undefined {
  const base = config().uploadBase;
  return base ? `${base.pathname}/workspace-uploads/` : undefined;
}

/**
 * Consume one opaque upload capability and stream raw bytes into its already
 * reserved private file. The capability is hashed in the ledger and removed
 * before reading the body, so it cannot be reused after a timeout or failure.
 */
export async function handleWorkspaceArtifactUpload(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let c: Config;
  try { c = config(); } catch { return false; }
  const prefix = c.uploadBase ? `${c.uploadBase.pathname}/workspace-uploads/` : undefined;
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!prefix || !pathname.startsWith(prefix)) return false;
  const ticket = pathname.slice(prefix.length);
  const reject = (status: number) => { res.writeHead(status, {'Cache-Control':'no-store'}); res.end(); };
  if (req.method !== 'PUT' || !validId(ticket) || pathname !== `${prefix}${ticket}`) { reject(404); return true; }
  req.setTimeout?.(15 * 60 * 1000);
  const length = req.headers['content-length'];
  if (typeof length !== 'string' || !/^\d+$/.test(length)) { reject(411); return true; }
  let candidate: { workspace: string; upload: string } | undefined;
  try {
    candidate = await locked(c, async state => {
      const now = Date.now();
      for (const [workspaceId, workspaceValue] of Object.entries(state.workspaces)) for (const [uploadId, entry] of Object.entries(workspaceValue.uploads)) {
        if (entry.kind !== 'http' || !entry.ticket_expires || entry.ticket_expires < now || !ticketEqual(entry.ticket_hash, ticket)) continue;
        if (Number(length) !== entry.size_bytes) fail('UPLOAD_REJECTED', 'Upload length does not match its reservation.');
        return {workspace:workspaceId,upload:uploadId};
      }
      return fail('UPLOAD_REJECTED', 'Upload capability is unknown or expired.');
    });
  } catch { reject(404); return true; }
  let claimed: { workspace: string; upload: string; entry: Entry } | undefined;
  return await withPrivateLock(streamingLockPath(c,candidate.upload), async () => {
    try {
      claimed = await locked(c, async state => {
        const entry=state.workspaces[candidate!.workspace]?.uploads[candidate!.upload], now=Date.now();
        if (!entry || entry.kind!=='http' || !entry.ticket_expires || entry.ticket_expires<now || !ticketEqual(entry.ticket_hash,ticket) || Number(length)!==entry.size_bytes) return fail('UPLOAD_REJECTED','Upload capability is unknown or expired.');
        delete entry.ticket_hash; delete entry.ticket_expires; entry.kind='http-streaming'; entry.updated=now;
        return {workspace:candidate!.workspace,upload:candidate!.upload,entry:{...entry}};
      });
    } catch { reject(404); return true; }
    const input = inputPath(c, claimed.upload);
    const handle = await fs.open(input, C.O_WRONLY | C.O_NOFOLLOW);
    let size = 0; const hash = createHash('sha256');
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size !== 0) fail('UNSAFE_STORAGE', 'Upload destination changed.');
      for await (const raw of req) {
        const bytes = Buffer.from(raw); size += bytes.length;
        if (size > claimed.entry.size_bytes) fail('UPLOAD_REJECTED', 'Upload exceeds its reservation.');
        hash.update(bytes); let offset = 0;
        while (offset < bytes.length) { const write = await handle.write(bytes, offset, bytes.length - offset, size - bytes.length + offset); if (!write.bytesWritten) fail('STORAGE_ERROR', 'Upload write made no progress.'); offset += write.bytesWritten; }
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (size !== claimed.entry.size_bytes || hash.digest('hex') !== claimed.entry.sha256) fail('INTEGRITY_MISMATCH', 'Upload bytes do not match the reservation.');
    await locked(c, async state => {
      const entry = state.workspaces[claimed!.workspace]?.uploads[claimed!.upload];
      if (!entry || entry.kind !== 'http-streaming' || entry.offset !== 0 || entry.size_bytes !== claimed!.entry.size_bytes || entry.sha256 !== claimed!.entry.sha256) fail('UPLOAD_REJECTED', 'Upload reservation was cancelled.');
      entry.kind = 'http'; entry.offset = size; entry.updated = Date.now();
    });
    res.writeHead(204, {'Cache-Control':'no-store'}); res.end(); return true;
  }).catch(async () => {
    if (claimed) await locked(c, async state => { const entry=state.workspaces[claimed!.workspace]?.uploads[claimed!.upload]; if (entry?.kind==='http' || entry?.kind==='http-streaming') { delete state.workspaces[claimed!.workspace].uploads[claimed!.upload]; await fs.rm(inputPath(c,claimed!.upload),{force:true}); } }).catch(()=>{});
    reject(422); return true;
  });
}
export async function handleWorkspaceArtifactTool(name: string, args: unknown, options: { signal?: AbortSignal; assertAuthority?:()=>void|Promise<void> } = {}): Promise<Record<string, unknown>> {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, any>;
  if (name === 'workspace_status' && a.workspace_id === undefined && !process.env.BAMBU_ARTIFACT_DIR) return {version:1,configured:false};
  const c = config();
  if (options.signal?.aborted) return fail('CANCELLED', 'Operation was cancelled.');
  try {
    if (name === 'workspace_import_file') {
      if (activeImports >= 2) return fail('QUOTA_EXCEEDED', 'Too many active file imports.', 'Wait for an import to finish before starting another.');
      activeImports++;
      try {
      if (!!a.file === !!a.source_url) fail('INVALID_ARGUMENT', 'Supply exactly one file or source_url.');
      const f = a.file; if (f && (typeof f !== 'object' || typeof f.download_url !== 'string' || typeof f.file_id !== 'string')) fail('INVALID_ARGUMENT', 'Invalid file parameter.');
      const fn = filename(a.filename ?? f?.file_name); if (a.expected_sha256 !== undefined && !hashOk(a.expected_sha256)) fail('INVALID_ARGUMENT', 'Invalid SHA-256.');
      const wid = getId(a.workspace_id, 'workspace'); const uid = id();
      await locked(c, async s => { const w = workspace(s,wid); quota(s,c,c.maxFile); w.uploads[uid] = {filename:fn,size_bytes:c.maxFile,sha256:'',offset:0,created:Date.now(),updated:Date.now(),kind:'network'}; });
      try {
        const b = await download(f?.download_url ?? a.source_url,c.maxFile,options.signal); if (options.signal?.aborted) fail('CANCELLED','Operation was cancelled.');
        const sha = digest(b); if (a.expected_sha256 && a.expected_sha256 !== sha) fail('INTEGRITY_MISMATCH','Downloaded file SHA-256 does not match.');
        return await locked(c,async s => { const w=workspace(s,wid); const u=w.uploads[uid]; if (!u || u.kind !== 'network') return fail('UPLOAD_NOT_FOUND','Import reservation expired or was removed.'); if (options.signal?.aborted) fail('CANCELLED','Operation was cancelled.'); u.size_bytes=b.length; u.sha256=sha; return publish(c,wid,w,uid,u,b,options); });
      } catch (e) { await locked(c, async s => { const w=workspace(s,wid); if (w.uploads[uid]?.kind === 'network') { delete w.uploads[uid]; await fs.rm(inputPath(c,uid),{force:true}); } }); throw e; }
      } finally { activeImports--; }
    }
    return await locked(c,async s => {
      if (name === 'workspace_status' && a.workspace_id === undefined) { const entries = Object.values(s.workspaces).flatMap(w => [...Object.values(w.uploads), ...Object.values(w.artifacts)]); return {version:1,configured:true,limits:{max_file_bytes:c.maxFile,max_total_bytes:c.maxTotal,max_slots:c.slots,max_workspaces:c.workspaces,upload_idle_seconds:c.idle/1000,upload_hard_seconds:c.hard/1000},usage:{reserved_and_published_bytes:entries.reduce((n,e)=>n+e.size_bytes,0),slots:entries.length,workspaces:Object.keys(s.workspaces).length}}; }
      if (name === 'workspace_create' || name === 'workspace_attach') {
        const wid = name === 'workspace_create' ? id() : getId(a.workspace_id,'workspace');
        if (!s.workspaces[wid]) { if (Object.keys(s.workspaces).length >= c.workspaces) fail('QUOTA_EXCEEDED','Workspace quota is exhausted.'); if (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 200)) fail('INVALID_ARGUMENT','Invalid workspace name.'); s.workspaces[wid] = { ...(a.name ? {name:a.name} : {}),uploads:{},artifacts:{} }; }
        return {version:1,workspace_id:wid};
      }
      const wid=getId(a.workspace_id,'workspace'); const w=workspace(s,wid);
      if (name === 'workspace_status') return {version:1,workspace_id:wid,uploads:Object.entries(w.uploads).map(([upload_id,e])=>({upload_id,filename:e.filename,size_bytes:e.size_bytes,sha256:e.sha256,offset:e.offset,created:e.created,updated:e.updated,kind:e.kind})),artifacts:Object.entries(w.artifacts).map(([artifact_id,e])=>result(wid,artifact_id,e,c))};
      if (name === 'workspace_delete') { if (Object.keys(w.uploads).length || Object.keys(w.artifacts).length) fail('WORKSPACE_NOT_EMPTY','Delete artifacts and abort uploads first.'); delete s.workspaces[wid]; return {version:1,workspace_id:wid,deleted:true}; }
      if (name === 'workspace_upload_begin') { const fn=filename(a.filename), size=integer(a.size_bytes,0,c.maxFile); if (!hashOk(a.sha256)) fail('INVALID_ARGUMENT','Invalid SHA-256.'); quota(s,c,size); const uid=id(); const h=await fs.open(inputPath(c,uid),'wx',0o600); try { await h.sync(); } finally { await h.close(); } await syncDir(path.join(c.root,'private','incoming')); w.uploads[uid]={filename:fn,size_bytes:size,sha256:a.sha256,offset:0,created:Date.now(),updated:Date.now(),kind:'upload'}; return {version:1,workspace_id:wid,upload_id:uid,offset:0,size_bytes:size,sha256:a.sha256,filename:fn}; }
      if (name === 'workspace_upload_begin_https') { const fn=filename(a.filename), size=integer(a.size_bytes,0,c.maxFile), uploadUrl=c.uploadBase?.toString(); if (!hashOk(a.sha256)) fail('INVALID_ARGUMENT','Invalid SHA-256.'); if (!uploadUrl) fail('FEATURE_UNAVAILABLE','Raw HTTPS upload is not configured.','Configure BAMBU_ARTIFACT_UPLOAD_BASE_URL and its gateway route.'); quota(s,c,size); const uid=id(), ticket=id(), now=Date.now(), expires=now+15*60*1000; const h=await fs.open(inputPath(c,uid),'wx',0o600); try { await h.sync(); } finally { await h.close(); } await syncDir(path.join(c.root,'private','incoming')); w.uploads[uid]={filename:fn,size_bytes:size,sha256:a.sha256,offset:0,created:now,updated:now,kind:'http',ticket_hash:ticketHash(ticket),ticket_expires:expires}; return {version:1,workspace_id:wid,upload_id:uid,upload_url:`${uploadUrl}/workspace-uploads/${ticket}`,method:'PUT',size_bytes:size,sha256:a.sha256,expires_at:new Date(expires).toISOString()}; }
      if (name.startsWith('workspace_upload_')) {
        const uid=getId(a.upload_id,'upload'); const u=w.uploads[uid]; if (!u || (u.kind !== 'upload' && u.kind !== 'http' && u.kind !== 'http-streaming')) return fail('UPLOAD_NOT_FOUND','Upload was not found.'); if (u.kind==='http-streaming') return fail('UPLOAD_IN_PROGRESS','HTTPS upload is still receiving bytes.','Cancel the client PUT, wait for it to settle, then inspect workspace status before aborting.');
        if (name === 'workspace_upload_abort') { delete w.uploads[uid]; await saveLedger(c,s); await fs.rm(inputPath(c,uid),{force:true}); return {version:1,workspace_id:wid,upload_id:uid,aborted:true}; }
        if (u.kind === 'http' && name === 'workspace_upload_chunk') return fail('UPLOAD_NOT_FOUND','Upload uses its one-time HTTPS URL.');
        if (name === 'workspace_upload_chunk') { const offset=integer(a.offset,0,u.size_bytes); if (offset !== u.offset) fail('OFFSET_MISMATCH','Chunk offset does not match the persisted upload offset.'); if (typeof a.data_base64 !== 'string' || a.data_base64.length > 699052 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data_base64)) fail('INVALID_ARGUMENT','Invalid base64.'); const b=Buffer.from(a.data_base64,'base64'); if (!b.length || b.length > 512*1024 || offset+b.length > u.size_bytes || b.toString('base64') !== a.data_base64) fail('INVALID_ARGUMENT','Invalid upload chunk size or encoding.'); const h=await fs.open(inputPath(c,uid),C.O_WRONLY|C.O_NOFOLLOW); try { const st=await h.stat(); if (!st.isFile() || st.size !== offset) fail('FILE_CHANGED','Upload file differs from its recorded offset.'); let written=0; while (written < b.length) { const part=await h.write(b,written,b.length-written,offset+written); if (!part.bytesWritten) fail('STORAGE_ERROR','Upload write made no progress.'); written+=part.bytesWritten; } await h.sync(); } finally {await h.close();} u.offset=offset+b.length; u.updated=Date.now(); return {version:1,workspace_id:wid,upload_id:uid,offset:u.offset}; }
        if (name === 'workspace_upload_finish') { if (u.offset !== u.size_bytes) fail('UPLOAD_INCOMPLETE','Upload has not reached its expected size.'); const b=await readRegular(inputPath(c,uid),c.maxFile); return publish(c,wid,w,uid,u,b,options); }
      }
      if (name.startsWith('workspace_artifact_')) {
        const aid=getId(a.artifact_id,'artifact'); const e=w.artifacts[aid]; if (!e) return fail('ARTIFACT_NOT_FOUND','Artifact was not found in this workspace.'); const r=result(wid,aid,e,c); await checkPublishedFile(c,r.file_path); const b=await readRegular(r.file_path,c.maxFile); if (b.length!==e.size_bytes || digest(b)!==e.sha256) fail('INTEGRITY_MISMATCH','Published artifact failed verification.');
        if (name === 'workspace_artifact_info') return r;
        if (name === 'workspace_artifact_read') { const off=integer(a.offset??0,0,b.length), len=integer(a.length??Math.min(256*1024,b.length-off),0,256*1024); return {...r,offset:off,data_base64:b.subarray(off,off+len).toString('base64'),next_offset:Math.min(off+len,b.length)}; }
        if (name === 'workspace_artifact_delete') { if (a.sha256 !== e.sha256) fail('INTEGRITY_MISMATCH','Expected SHA-256 does not match.'); const token=id(), tomb=path.join(c.root,'private','tombstones'), marker=path.join(tomb,`${token}.json`); const pending=path.join(tomb,`.pending-${token}`); const h=await fs.open(pending,'wx',0o600); try { await h.writeFile(JSON.stringify({workspace_id:wid,artifact_id:aid,sha256:e.sha256})); await h.sync(); } finally { await h.close(); } await fs.rename(pending,marker); await syncDir(tomb); await fs.rename(path.dirname(r.file_path),path.join(tomb,token)); await syncDir(path.dirname(path.dirname(r.file_path))); await syncDir(tomb); delete w.artifacts[aid]; return {version:1,workspace_id:wid,artifact_id:aid,deleted:true}; }
      }
      if (name === 'workspace_adopt_export') {
        if (!c.outbox) fail('FEATURE_UNAVAILABLE','Export outbox is not configured.','Configure BAMBU_ARTIFACT_OUTBOX_DIR.'); const eid=getId(a.export_id,'export'); const size=integer(a.size_bytes,0,c.maxFile); if (!hashOk(a.sha256)) fail('INVALID_ARGUMENT','Invalid SHA-256.'); quota(s,c,size);
        const [raw,b]=await readExport(c,wid,eid); let receipt: any; try { receipt=JSON.parse(raw.toString('utf8')); } catch { return fail('INVALID_RECEIPT','Export receipt is invalid.'); }
        if (Object.keys(receipt).sort().join(',') !== 'export_id,filename,sha256,size_bytes,version,workspace_id' || receipt.version!==1 || receipt.workspace_id!==wid || receipt.export_id!==eid || receipt.sha256!==a.sha256 || receipt.size_bytes!==size) fail('INVALID_RECEIPT','Export receipt does not match the requested export.'); const fn=filename(receipt.filename); if (b.length!==size || digest(b)!==a.sha256) fail('INTEGRITY_MISMATCH','Export bytes do not match the receipt.'); const uid=id(); const u:Entry={filename:fn,size_bytes:size,sha256:a.sha256,kind:'adopt'}; w.uploads[uid]=u; const published=await publish(c,wid,w,uid,u,b,options); return {...published,export_id:eid};
      }
      return fail('UNKNOWN_TOOL','Unknown workspace artifact tool.');
    });
  } catch (e) { if (e instanceof WorkspaceArtifactError) throw e; return fail('STORAGE_ERROR','Artifact operation failed.','Inspect storage configuration and workspace status before retrying.'); }
}
