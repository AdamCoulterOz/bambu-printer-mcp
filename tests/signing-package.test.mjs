import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { downloadReviewedPackageForTest, REVIEWED_APK_URL } from '../dist/signing/official-package.js';
const value = Buffer.from('synthetic package');
const sha = createHash('sha256').update(value).digest('hex');
async function fixture(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'package-test-'))); t.after(()=>rm(dir,{recursive:true,force:true})); return dir; }
function transport(body = value, status = 200, hold = false) {
  return (url, options, callback) => {
    assert.equal(url, REVIEWED_APK_URL); assert.equal(options.headers['Accept-Encoding'], 'identity');
    const req = new EventEmitter(), response = new PassThrough(); response.statusCode=status; response.headers={};
    req.destroy=()=>response.destroy(new Error('cancelled'));
    options.signal.addEventListener('abort',req.destroy,{once:true});
    queueMicrotask(()=>{ callback(response); response.write(body); if (!hold) response.end(); });
    return req;
  };
}
test('only exact expected official bytes are retained privately', async t => {
  const dir=await fixture(t), path=join(dir,'package');
  await downloadReviewedPackageForTest(path,{transport:transport(),size:value.length,sha256:sha});
  assert.deepEqual(await readFile(path),value);
});
for (const [name, body, status, size, hash] of [['redirect',value,302,value.length,sha],['oversize',value,200,1,sha],['short',value,200,value.length+1,sha],['hash',value,200,value.length,'0'.repeat(64)]]) {
  test(`${name} download fails and removes partial bytes`, async t => {
    const dir=await fixture(t), path=join(dir,'package');
    await assert.rejects(downloadReviewedPackageForTest(path,{transport:transport(body,status),size,sha256:hash}),/SIGNING_PACKAGE_ACQUISITION_FAILED/);
    assert.deepEqual(await readdir(dir),[]);
  });
}
test('cancellation stops a pending transfer and removes partial file', async t => {
  const dir=await fixture(t), path=join(dir,'package'), controller=new AbortController();
  const pending=downloadReviewedPackageForTest(path,{transport:transport(value,200,true),size:value.length,sha256:sha,signal:controller.signal});
  setTimeout(()=>controller.abort(),20);
  await assert.rejects(pending,/SIGNING_PACKAGE_ACQUISITION_FAILED/); assert.deepEqual(await readdir(dir),[]);
});
test('existing symlink is refused and target preserved', async t => {
  const dir=await fixture(t), target=join(dir,'target'), path=join(dir,'package');
  await writeFile(target,'safe'); await symlink(target,path);
  await assert.rejects(downloadReviewedPackageForTest(path,{transport:transport(),size:value.length,sha256:sha}),/SIGNING_PACKAGE_ACQUISITION_FAILED/);
  assert.equal(await readFile(target,'utf8'),'safe');
});

test('one-click handoff waits for validated download and cleans after issuance seam', async t => {
  const { provisionOfficialPackageForTest } = await import('../dist/signing/bootstrap.js');
  const dir=await fixture(t), calls=[];
  const result=await provisionOfficialPackageForTest({directory:dir,region:'global'}, {
    download: async path => { calls.push('download'); await writeFile(path,value,{mode:0o600}); },
    provision: async options => { calls.push('provision'); assert.deepEqual(await readFile(options.apkFile),value); return {expiresAt:'2030-01-01T00:00:00.000Z'}; },
  });
  assert.deepEqual(calls,['download','provision']); assert.equal(result.expiresAt,'2030-01-01T00:00:00.000Z'); assert.deepEqual(await readdir(dir),[]);
});
test('cancelled one-click download never reaches issuance and removes temporary files', async t => {
  const { provisionOfficialPackageForTest } = await import('../dist/signing/bootstrap.js');
  const dir=await fixture(t), abort=new AbortController(); let called=false;
  await assert.rejects(provisionOfficialPackageForTest({directory:dir,region:'global',signal:abort.signal}, {
    download: async path => { await writeFile(path,value); abort.abort(); },
    provision: async () => { called=true; return {expiresAt:''}; },
  }));
  assert.equal(called,false); assert.deepEqual(await readdir(dir),[]);
});
