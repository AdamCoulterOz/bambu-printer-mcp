import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { handleWorkspaceArtifactTool as call } from '../dist/workspace-artifacts.js';

test('workspace survives attach, chunk upload and verified reading', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'artifact-test-'));
  process.env.BAMBU_ARTIFACT_DIR = root;
  process.env.BAMBU_ARTIFACT_GROUP_GID = String(process.getgid());
  try {
    const { workspace_id } = await call('workspace_create', {});
    assert.equal(workspace_id.length, 43);
    assert.equal((await call('workspace_attach', { workspace_id })).workspace_id, workspace_id);
    const bytes = Buffer.from('fixture'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { upload_id } = await call('workspace_upload_begin', { workspace_id, filename:'part.stl', size_bytes:bytes.length, sha256 });
    await call('workspace_upload_chunk', { workspace_id, upload_id, offset:0, data_base64:bytes.toString('base64') });
    const result = await call('workspace_upload_finish', { workspace_id, upload_id });
    assert.equal(result.sha256, sha256);
    assert.deepEqual(Buffer.from((await call('workspace_artifact_read', { workspace_id, artifact_id:result.artifact_id })).data_base64, 'base64'), bytes);
    await assert.rejects(call('workspace_artifact_delete', { workspace_id, artifact_id:result.artifact_id, sha256:'0'.repeat(64) }), { code:'INTEGRITY_MISMATCH' });
  } finally { delete process.env.BAMBU_ARTIFACT_DIR; delete process.env.BAMBU_ARTIFACT_GROUP_GID; await chmod(root, 0o700); await rm(root,{recursive:true,force:true}); }
});

test('kernel lock persists after helper exits until the Node owner closes its descriptor', async () => {
  const { spawn } = await import('node:child_process'); const {open}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-lock-')), file=path.join(root,'lock'), helper=path.resolve('scripts/artifact-store-lock.py');
  const first=await open(file,'w+'), second=await open(file,'r+');
  const acquire=fd=>spawn('python3',[helper,'lock'],{stdio:['ignore','ignore','ignore',fd]});
  const done=child=>new Promise((resolve,reject)=>{child.once('error',reject); child.once('close',code=>code===0?resolve():reject(new Error(`helper ${code}`)));});
  try {
    await done(acquire(first.fd));
    const contender=acquire(second.fd); let acquired=false; const waiting=done(contender).then(()=>{acquired=true;});
    await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(acquired,false);
    await first.close(); await waiting; assert.equal(acquired,true);
  } finally { await first.close().catch(()=>{}); await second.close(); await rm(root,{recursive:true,force:true}); }
});

test('concurrent reservations enforce quota and wrong workspaces cannot access uploads', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'artifact-quota-'));
  Object.assign(process.env, { BAMBU_ARTIFACT_DIR:root, BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()), BAMBU_ARTIFACT_MAX_TOTAL_BYTES:'7' });
  try {
    const one = (await call('workspace_create', {})).workspace_id;
    const two = (await call('workspace_create', {})).workspace_id;
    const args = { workspace_id:one, filename:'part.stl', size_bytes:7, sha256:'0'.repeat(64) };
    const attempts = await Promise.allSettled([call('workspace_upload_begin',args), call('workspace_upload_begin',args)]);
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length,1);
    assert.equal(attempts.find(x => x.status === 'rejected').reason.code,'QUOTA_EXCEEDED');
    const upload_id = attempts.find(x => x.status === 'fulfilled').value.upload_id;
    await assert.rejects(call('workspace_upload_abort',{workspace_id:two,upload_id}),{code:'UPLOAD_NOT_FOUND'});
    await call('workspace_upload_abort',{workspace_id:one,upload_id});
    assert.equal((await call('workspace_status',{})).usage.reserved_and_published_bytes,0);
  } finally { for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_MAX_TOTAL_BYTES']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('adoption verifies receipt and bytes and refuses symlinked outbox entries', async () => {
  const { mkdir, writeFile, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'artifact-adopt-'));
  const store=path.join(root,'store'), outbox=path.join(root,'outbox'); await mkdir(store); await mkdir(outbox); await chmod(outbox,0o2750);
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:store,BAMBU_ARTIFACT_OUTBOX_DIR:outbox,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    const export_id=Buffer.alloc(32,3).toString('base64url'); const bytes=Buffer.from('test export');
    const sha256=createHash('sha256').update(bytes).digest('hex'); const receipt={version:1,workspace_id,export_id,filename:'part.3mf',sha256,size_bytes:bytes.length};
    const dir=path.join(outbox,workspace_id,export_id); await mkdir(dir,{recursive:true}); await chmod(path.dirname(dir),0o2750); await chmod(dir,0o2750); await writeFile(path.join(dir,'receipt.json'),JSON.stringify(receipt)); await writeFile(path.join(dir,'content'),bytes); await chmod(path.join(dir,'receipt.json'),0o440); await chmod(path.join(dir,'content'),0o440);
    const artifact=await call('workspace_adopt_export',{workspace_id,export_id,sha256,size_bytes:bytes.length}); assert.equal(artifact.sha256,sha256);
    await chmod(path.join(dir,'content'),0o640); await writeFile(path.join(dir,'content'),'tampered'); await chmod(path.join(dir,'content'),0o440);
    await assert.rejects(call('workspace_adopt_export',{workspace_id,export_id,sha256,size_bytes:bytes.length}),{code:'INTEGRITY_MISMATCH'});
    await rm(path.join(dir,'content')); await symlink(artifact.file_path,path.join(dir,'content'));
    await assert.rejects(call('workspace_adopt_export',{workspace_id,export_id,sha256,size_bytes:bytes.length}),{code:'UNSAFE_STORAGE'});
  } finally { for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_OUTBOX_DIR','BAMBU_ARTIFACT_GROUP_GID']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('reconciles a finalized publication and a deletion intent after interrupted ledger commits', async () => {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-recovery-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    const bytes=Buffer.from('recover'); const sha256=createHash('sha256').update(bytes).digest('hex');
    const {upload_id}=await call('workspace_upload_begin',{workspace_id,filename:'recover.stl',size_bytes:bytes.length,sha256});
    await call('workspace_upload_chunk',{workspace_id,upload_id,offset:0,data_base64:bytes.toString('base64')});
    const ledger=path.join(root,'private','ledger.json'); const before=await readFile(ledger);
    const artifact=await call('workspace_upload_finish',{workspace_id,upload_id});
    await writeFile(ledger,before);
    const recovered=await call('workspace_status',{workspace_id}); assert.equal(recovered.artifacts[0].artifact_id,artifact.artifact_id); assert.equal(recovered.uploads.length,0);
    const token=Buffer.alloc(32,7).toString('base64url'); const tomb=path.join(root,'private','tombstones'); await mkdir(tomb,{recursive:true});
    await writeFile(path.join(tomb,`${token}.json`),JSON.stringify({workspace_id,artifact_id:artifact.artifact_id,sha256}));
    assert.equal((await call('workspace_status',{workspace_id})).artifacts.length,0);
    assert.equal((await call('workspace_status',{workspace_id})).artifacts.length,0);
  } finally { delete process.env.BAMBU_ARTIFACT_DIR; delete process.env.BAMBU_ARTIFACT_GROUP_GID; await rm(root,{recursive:true,force:true}); }
});

test('upload leases expire and late chunks cannot revive them', async () => {
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-lease-')); const now=Date.now;
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_UPLOAD_IDLE_SECONDS:'1',BAMBU_ARTIFACT_UPLOAD_HARD_SECONDS:'2'});
  try {
    let time=now(); Date.now=()=>time;
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    const {upload_id}=await call('workspace_upload_begin',{workspace_id,filename:'piece.obj',size_bytes:1,sha256:'0'.repeat(64)});
    time+=1001;
    await assert.rejects(call('workspace_upload_chunk',{workspace_id,upload_id,offset:0,data_base64:'YQ=='}),{code:'UPLOAD_NOT_FOUND'});
    assert.equal((await call('workspace_status',{workspace_id})).uploads.length,0);
  } finally { Date.now=now; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_UPLOAD_IDLE_SECONDS','BAMBU_ARTIFACT_UPLOAD_HARD_SECONDS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('import rejects unsafe URLs and private DNS answers before a connection', async () => {
  const dns=(await import('node:dns/promises')).default; const lookup=dns.lookup;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-url-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'example.org'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'http://example.org/test',filename:'test.stl'}),{code:'DOWNLOAD_REJECTED'});
    dns.lookup=async()=>[{address:'127.0.0.1',family:4}];
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://example.org/test',filename:'test.stl'}),{code:'DOWNLOAD_REJECTED'});
    assert.equal((await call('workspace_status',{workspace_id})).uploads.length,0);
  } finally { dns.lookup=lookup; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('redirects are re-resolved and rejected before connecting to private destinations', async () => {
  const dns=(await import('node:dns/promises')).default, https=(await import('node:https')).default;
  const { EventEmitter }=await import('node:events'); const lookup=dns.lookup, get=https.get;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-redirect-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'public.example,private.example'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id; let connections=0;
    dns.lookup=async host=>[{address:host==='public.example'?'8.8.8.8':'10.0.0.1',family:4}];
    https.get=(url,opts,callback)=>{ connections++; const req=new EventEmitter(); req.destroy=()=>{}; opts.lookup('public.example',{},(_e,address)=>assert.equal(address,'8.8.8.8')); queueMicrotask(()=>{const res=new EventEmitter(); res.statusCode=302; res.headers={location:'https://private.example/payload'}; res.resume=()=>{}; callback(res);}); return req; };
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/item',filename:'item.stl'}),{code:'DOWNLOAD_REJECTED'});
    assert.equal(connections,1);
  } finally { dns.lookup=lookup; https.get=get; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('published transaction survives an expired reservation and failed triggering operation', async () => {
  const { readFile, writeFile }=await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-expired-publish-')); const now=Date.now;
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_UPLOAD_IDLE_SECONDS:'1',BAMBU_ARTIFACT_UPLOAD_HARD_SECONDS:'2'});
  try {
    let time=now(); Date.now=()=>time;
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    const bytes=Buffer.from('committed'), sha256=createHash('sha256').update(bytes).digest('hex');
    const {upload_id}=await call('workspace_upload_begin',{workspace_id,filename:'part.stl',size_bytes:bytes.length,sha256});
    await call('workspace_upload_chunk',{workspace_id,upload_id,offset:0,data_base64:bytes.toString('base64')});
    const ledger=path.join(root,'private','ledger.json'), prior=await readFile(ledger);
    const artifact=await call('workspace_upload_finish',{workspace_id,upload_id});
    await writeFile(ledger,prior); time+=3000;
    await assert.rejects(call('workspace_upload_abort',{workspace_id,upload_id}),{code:'UPLOAD_NOT_FOUND'});
    const status=await call('workspace_status',{workspace_id});
    assert.equal(status.artifacts[0].artifact_id,artifact.artifact_id); assert.equal(status.uploads.length,0);
  } finally { Date.now=now; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_UPLOAD_IDLE_SECONDS','BAMBU_ARTIFACT_UPLOAD_HARD_SECONDS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('interrupted chunk tail is truncated before resuming at the committed offset', async () => {
  const { appendFile, readFile }=await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-chunk-recovery-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id, bytes=Buffer.from('abcd'), sha256=createHash('sha256').update(bytes).digest('hex');
    const {upload_id}=await call('workspace_upload_begin',{workspace_id,filename:'part.obj',size_bytes:bytes.length,sha256});
    await call('workspace_upload_chunk',{workspace_id,upload_id,offset:0,data_base64:Buffer.from('ab').toString('base64')});
    await appendFile(path.join(root,'private','incoming',upload_id),'BAD');
    await call('workspace_upload_chunk',{workspace_id,upload_id,offset:2,data_base64:Buffer.from('cd').toString('base64')});
    const result=await call('workspace_upload_finish',{workspace_id,upload_id}); assert.deepEqual(await readFile(result.file_path),bytes);
  } finally { delete process.env.BAMBU_ARTIFACT_DIR; delete process.env.BAMBU_ARTIFACT_GROUP_GID; await rm(root,{recursive:true,force:true}); }
});

test('cancelled import releases its reservation and cannot publish a late response', async () => {
  const dns=(await import('node:dns/promises')).default, https=(await import('node:https')).default;
  const {EventEmitter}=await import('node:events'); const lookup=dns.lookup, get=https.get;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-cancel-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'public.example'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id, controller=new AbortController(); let deliver;
    dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
    https.get=(_url,_opts,callback)=>{ const req=new EventEmitter(); req.destroy=()=>{}; deliver=()=>{const res=new EventEmitter(); res.statusCode=200; res.headers={}; callback(res); res.emit('data',Buffer.from('late')); res.emit('end');}; return req; };
    const pending=call('workspace_import_file',{workspace_id,source_url:'https://public.example/item',filename:'item.stl'},{signal:controller.signal});
    while (!deliver) await new Promise(resolve=>setImmediate(resolve));
    controller.abort(); deliver(); await assert.rejects(pending,{code:'CANCELLED'});
    const status=await call('workspace_status',{workspace_id}); assert.equal(status.uploads.length,0); assert.equal(status.artifacts.length,0);
  } finally { dns.lookup=lookup; https.get=get; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('adoption recovers a finalized copy whose ledger update was interrupted', async () => {
  const {mkdir,writeFile,readFile}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-adopt-recovery-')), store=path.join(root,'store'), outbox=path.join(root,'outbox');
  await mkdir(store); await mkdir(outbox); await chmod(outbox,0o2750);
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:store,BAMBU_ARTIFACT_OUTBOX_DIR:outbox,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id, export_id=Buffer.alloc(32,9).toString('base64url'), bytes=Buffer.from('adopt recovery'), sha256=createHash('sha256').update(bytes).digest('hex');
    const dir=path.join(outbox,workspace_id,export_id); await mkdir(dir,{recursive:true}); await chmod(path.dirname(dir),0o2750); await chmod(dir,0o2750);
    await writeFile(path.join(dir,'receipt.json'),JSON.stringify({version:1,workspace_id,export_id,filename:'part.3mf',sha256,size_bytes:bytes.length})); await writeFile(path.join(dir,'content'),bytes);
    await chmod(path.join(dir,'receipt.json'),0o440); await chmod(path.join(dir,'content'),0o440);
    const ledger=path.join(store,'private','ledger.json'), before=await readFile(ledger);
    const artifact=await call('workspace_adopt_export',{workspace_id,export_id,sha256,size_bytes:bytes.length}); await writeFile(ledger,before);
    const recovered=await call('workspace_status',{workspace_id}); assert.equal(recovered.artifacts[0].artifact_id,artifact.artifact_id); assert.deepEqual(await readFile(artifact.file_path),bytes);
  } finally { for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_OUTBOX_DIR','BAMBU_ARTIFACT_GROUP_GID']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('download pins the checked address and rejects a streamed body over the configured bound', async () => {
  const dns=(await import('node:dns/promises')).default, https=(await import('node:https')).default;
  const {EventEmitter}=await import('node:events'); const lookup=dns.lookup, get=https.get;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-stream-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'public.example',BAMBU_ARTIFACT_MAX_FILE_BYTES:'3'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id; let lookups=0,connections=0;
    dns.lookup=async()=>{lookups++; return [{address:'8.8.8.8',family:4}];};
    https.get=(_url,opts,callback)=>{connections++; opts.lookup('public.example',{},(_err,address)=>assert.equal(address,'8.8.8.8')); const req=new EventEmitter(); req.destroy=()=>{}; queueMicrotask(()=>{const res=new EventEmitter(); res.statusCode=200; res.headers={}; res.destroy=err=>res.emit('error',err); callback(res); res.emit('data',Buffer.from('oversize'));}); return req;};
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/secret?token=secret',filename:'part.stl'}),error=>error.code==='DOWNLOAD_FAILED' && !error.message.includes('secret'));
    assert.equal(lookups,1); assert.equal(connections,1); assert.equal((await call('workspace_status',{workspace_id})).uploads.length,0);
  } finally { dns.lookup=lookup; https.get=get; for (const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS','BAMBU_ARTIFACT_MAX_FILE_BYTES']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('lock releases when the independent Node owner is killed', async () => {
  const {spawn}=await import('node:child_process'); const {open}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-owner-death-')), file=path.join(root,'lock'), helper=path.resolve('scripts/artifact-store-lock.py');
  const script=`const fs=require('node:fs'), cp=require('node:child_process'); const fd=fs.openSync(process.argv[1],'w+'); const c=cp.spawn('python3',[process.argv[2],'lock'],{stdio:['ignore','ignore','ignore',fd]}); c.on('close',n=>{if(n) process.exit(n); console.log('ready'); setInterval(()=>{},1000)});`;
  const owner=spawn(process.execPath,['-e',script,file,helper],{stdio:['ignore','pipe','ignore']});
  const ready=new Promise((resolve,reject)=>{owner.stdout.once('data',resolve);owner.once('error',reject);owner.once('exit',()=>reject(new Error('owner exited early')));});
  try {
    await ready; const fd=await open(file,'r+'); const contender=spawn('python3',[helper,'lock'],{stdio:['ignore','ignore','ignore',fd.fd]}); let acquired=false;
    const waiting=new Promise((resolve,reject)=>{contender.once('close',code=>code===0?resolve():reject(new Error('contender failed')));}).then(()=>{acquired=true;});
    await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(acquired,false); owner.kill('SIGKILL'); await waiting; assert.equal(acquired,true); await fd.close();
  } finally { owner.kill('SIGKILL'); await rm(root,{recursive:true,force:true}); }
});

test('missing ledger-referenced publication fails closed', async () => {
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-missing-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id, bytes=Buffer.from('x'), sha256=createHash('sha256').update(bytes).digest('hex');
    const {upload_id}=await call('workspace_upload_begin',{workspace_id,filename:'part.stl',size_bytes:1,sha256}); await call('workspace_upload_chunk',{workspace_id,upload_id,offset:0,data_base64:bytes.toString('base64')});
    const artifact=await call('workspace_upload_finish',{workspace_id,upload_id}); await rm(artifact.file_path);
    await assert.rejects(call('workspace_status',{workspace_id}),{code:'STORAGE_ERROR'});
  } finally { delete process.env.BAMBU_ARTIFACT_DIR; delete process.env.BAMBU_ARTIFACT_GROUP_GID; await rm(root,{recursive:true,force:true}); }
});

test('one deadline covers stalled DNS, trickled response and redirect chain without late publication', async () => {
  const dns=(await import('node:dns/promises')).default, https=(await import('node:https')).default;
  const {EventEmitter}=await import('node:events'); const lookup=dns.lookup, get=https.get, timer=globalThis.setTimeout;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-deadline-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'public.example'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id;
    globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===30000?35:ms,...args);
    let releaseDns, connections=0;
    dns.lookup=()=>new Promise(resolve=>{releaseDns=resolve;}); https.get=()=>{connections++; throw new Error('unexpected connection');};
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/one',filename:'part.stl'}),{code:'DOWNLOAD_FAILED'});
    releaseDns([{address:'8.8.8.8',family:4}]); await new Promise(resolve=>timer(resolve,10)); assert.equal(connections,0);
    dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
    https.get=(_url,_opts,callback)=>{ const req=new EventEmitter(); req.destroy=()=>{}; queueMicrotask(()=>{const res=new EventEmitter(); res.statusCode=200; res.headers={}; res.destroy=()=>{}; callback(res); const i=setInterval(()=>res.emit('data',Buffer.from('a')),5); timer(()=>clearInterval(i),80);}); return req; };
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/two',filename:'part.stl'}),{code:'DOWNLOAD_FAILED'});
    let redirects=0; https.get=(_url,_opts,callback)=>{const req=new EventEmitter(); req.destroy=()=>{}; timer(()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'/next'};res.resume=()=>{};redirects++;callback(res);},20);return req;};
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/three',filename:'part.stl'}),{code:'DOWNLOAD_FAILED'});
    await new Promise(resolve=>timer(resolve,60)); assert.ok(redirects>=1); const status=await call('workspace_status',{workspace_id}); assert.equal(status.uploads.length,0); assert.equal(status.artifacts.length,0);
  } finally { globalThis.setTimeout=timer; dns.lookup=lookup; https.get=get; for(const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS']) delete process.env[k]; await rm(root,{recursive:true,force:true}); }
});

test('only two buffered network imports run per process', async () => {
  const dns=(await import('node:dns/promises')).default, lookup=dns.lookup;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-active-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid()),BAMBU_ARTIFACT_TRUSTED_HOSTS:'public.example'});
  try {
    const workspace_id=(await call('workspace_create',{})).workspace_id, controllers=[new AbortController(),new AbortController()]; let started=0;
    dns.lookup=()=>{started++;return new Promise(()=>{});};
    const pending=controllers.map(c=>call('workspace_import_file',{workspace_id,source_url:'https://public.example/file',filename:'part.stl'},{signal:c.signal}));
    while(started<2) await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(call('workspace_import_file',{workspace_id,source_url:'https://public.example/file',filename:'part.stl'}),{code:'QUOTA_EXCEEDED'});
    controllers.forEach(c=>c.abort()); const results=await Promise.allSettled(pending); assert.deepEqual(results.map(r=>r.reason.code),['CANCELLED','CANCELLED']);
    assert.equal((await call('workspace_status',{workspace_id})).uploads.length,0);
  } finally {dns.lookup=lookup;for(const k of ['BAMBU_ARTIFACT_DIR','BAMBU_ARTIFACT_GROUP_GID','BAMBU_ARTIFACT_TRUSTED_HOSTS']) delete process.env[k];await rm(root,{recursive:true,force:true});}
});

test('first initialization syncs each new managed directory and its parent before ledger publication', async () => {
  const fs=(await import('node:fs')).promises, originalMkdir=fs.mkdir, originalOpen=fs.open, originalRename=fs.rename;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-init-sync-')); const events=[];
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    fs.mkdir=async (p,...args)=>{const result=await originalMkdir.call(fs,p,...args);events.push(['mkdir',String(p)]);return result;};
    fs.open=async (p,...args)=>{const handle=await originalOpen.call(fs,p,...args);const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();events.push(['sync',String(p)]);};return handle;};
    fs.rename=async (from,to)=>{events.push(['rename',String(to)]);return originalRename.call(fs,from,to);};
    await call('workspace_create',{});
    const ledger=events.findIndex(([type,p])=>type==='rename' && p===path.join(root,'private','ledger.json')); assert.ok(ledger>=0);
    for (const dir of [path.join(root,'private'),path.join(root,'private','incoming'),path.join(root,'private','tombstones'),path.join(root,'published')]) {
      const made=events.findIndex(([type,p])=>type==='mkdir' && p===dir); assert.ok(made>=0);
      assert.ok(events.slice(made+1,ledger).some(([type,p])=>type==='sync' && p===dir),`${dir} synced`);
      assert.ok(events.slice(made+1,ledger).some(([type,p])=>type==='sync' && p===path.dirname(dir)),`${dir} parent synced`);
    }
  } finally {fs.mkdir=originalMkdir;fs.open=originalOpen;fs.rename=originalRename;delete process.env.BAMBU_ARTIFACT_DIR;delete process.env.BAMBU_ARTIFACT_GROUP_GID;await rm(root,{recursive:true,force:true});}
});

test('failed first initialization directory sync prevents workspace acknowledgement', async () => {
  const fs=(await import('node:fs')).promises, originalOpen=fs.open;
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'artifact-init-fail-'));
  Object.assign(process.env,{BAMBU_ARTIFACT_DIR:root,BAMBU_ARTIFACT_GROUP_GID:String(process.getgid())});
  try {
    fs.open=async (p,...args)=>{const handle=await originalOpen.call(fs,p,...args);if(String(p)===root) handle.sync=async()=>{throw new Error('injected fsync failure');};return handle;};
    await assert.rejects(call('workspace_create',{}),{code:'STORAGE_ERROR'});
    await assert.rejects(fs.stat(path.join(root,'private','ledger.json')),{code:'ENOENT'});
    let rootSynced=false;
    fs.open=async (p,...args)=>{const handle=await originalOpen.call(fs,p,...args);if(String(p)===root) {const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();rootSynced=true;};}return handle;};
    await call('workspace_create',{}); assert.equal(rootSynced,true);
  } finally {fs.open=originalOpen;delete process.env.BAMBU_ARTIFACT_DIR;delete process.env.BAMBU_ARTIFACT_GROUP_GID;await rm(root,{recursive:true,force:true});}
});
