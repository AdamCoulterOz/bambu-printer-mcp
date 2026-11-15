import { resolve as signedResolve } from './signed-transport-loader.mjs';
const transfer = `import {appendFileSync, statSync, chmodSync, writeFileSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export class MediaTransferError extends Error {
  constructor(stage,reason,uploadMayExist) { super('Printer media transfer failed ('+stage+': '+reason+').'); this.stage=stage; this.reason=reason; this.uploadMayExist=uploadMayExist; this.privateDetail='PRIVATE_SECRET_DO_NOT_RETURN'; }
}
export async function verifiedUploadInternal(o) {
  appendFileSync(process.env.SIGNED_TEST_LOG, JSON.stringify({kind:'verified-upload', name:o.remoteName})+'\\n');
  o.assertActive();
  if (process.env.SIGNED_TEST_MUTATE === '1') { chmodSync(o.filePath, 0o600); writeFileSync(o.filePath,'modified'); }
  if (createHash('sha256').update(readFileSync(o.filePath)).digest('hex') !== o.snapshotSha256) throw new Error('snapshot changed');
  if (process.env.SIGNED_TEST_TRANSFER_ERROR === 'login') throw new MediaTransferError('login','protocol',false);
  if (process.env.SIGNED_TEST_TRANSFER_ERROR === 'upload') throw new MediaTransferError('upload','closed',true);
  if (process.env.SIGNED_TEST_UPLOAD_FAIL === '1') throw new Error('mock upload failed');
  return {storage:'emmc',name:o.remoteName,size:statSync(o.filePath).size,md5:'a'.repeat(32),sha256:o.snapshotSha256,url:'brtc://emmc/'+o.remoteName,verifiedBy:'readback'};
}`;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/index.js') && specifier === './printers/media-transfer.js') return {url:'data:text/javascript,'+encodeURIComponent(transfer),shortCircuit:true};
  return signedResolve(specifier, context, nextResolve);
}
