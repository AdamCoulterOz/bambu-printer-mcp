import {resolve as baseResolve} from './signed-internal-loader.mjs';
const cloud = `import {appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export async function submitCloudPrint(o) {
  if(createHash('sha256').update(readFileSync(o.filePath)).digest('hex')!==o.sha256) throw Error('snapshot mismatch');
  if(process.env.SIGNED_TEST_ACCOUNT_SCENARIO==='changed_early') process.env.BAMBU_SIGNED_CLOUD_TOKEN='changed';
  o.assertAuthority();
  await o.proofFactory(o.signingDirectory);
  appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'cloud-prepared',plate:o.plate,task:o.task})+'\\n');
  await o.proofFactory(o.signingDirectory);
  if(process.env.SIGNED_TEST_ACCOUNT_SCENARIO==='changed') process.env.BAMBU_SIGNED_CLOUD_TOKEN='changed';
  await o.beforeDispatch();
  o.assertAuthority();
  o.onDispatch();
  appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'cloud-dispatch'})+'\\n');
  return {projectId:'1',taskId:'2',dispatch:'unconfirmed'};
}`;
const proof = `import {appendFileSync} from 'node:fs';
export async function handyClientHeaders(){return {'x-bbl-client-name':'BambuHandy'}};
export function httpProofRenewalConfiguration(env,directory){return env.BAMBU_SIGNING_AUTO_RENEW==='true'?{directory,region:env.BAMBU_SIGNING_REGION}:undefined};
export async function createHttpProof(directory,clock,autoRenew){appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'http-proof',renew:!!autoRenew,region:autoRenew?.region,directory})+'\\n');if(autoRenew && process.env.SIGNED_TEST_RENEW_FAIL==='1') throw Error('SIGNING_RENEWAL_FAILED'); return {};}`;
const bootstrap = `import {appendFileSync} from 'node:fs';
const record=(method,o)=>{appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'signing-setup',method,region:o.region,apk:o.apkFile,hasSignal:!!o.signal})+'\\n');return {expiresAt:'2030-01-01T00:00:00.000Z'}};
export async function provisionSigningCredentials(o){return record('files',o)}
export async function provisionSigningCredentialsFromApk(o){return record('apk',o)}
export async function provisionSigningCredentialsFromOfficialPackage(o){return record('automatic',o)}`;
const mutationUrl=new URL('../dist/tutk-direct/mutations.js',import.meta.url).href;
const tutk = `import {appendFileSync} from 'node:fs';
async function auth(o,deps){const c=await deps.credentials(o.serial);if(process.env.SIGNED_TEST_ACCOUNT_SCENARIO==='changed_early')process.env.BAMBU_SIGNED_CLOUD_TOKEN='changed';await c.assertCurrent();await deps.proof(o.signingDirectory);if(process.env.SIGNED_TEST_ACCOUNT_SCENARIO==='changed')process.env.BAMBU_SIGNED_CLOUD_TOKEN='changed';c.assertGenerationCurrent();}
export async function runTutkOperation(o,deps){await auth(o,deps);appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'remote',operation:o.operation})+'\\n');if(o.operation.operation==='camera')return {kind:'camera',jpeg:Buffer.from([255,216,255,217])};if(o.operation.operation==='list')return {kind:'list',files:[{name:'clip.mp4',path:'/clip.mp4',size:5,type:'video'}]};if(o.operation.operation==='upload'&&process.env.SIGNED_TEST_REMOTE_UNKNOWN==='1'){const {MutationFailure}=await import(${JSON.stringify(mutationUrl)});throw new MutationFailure({status:'unknown',operation:'upload',path:'unique.3mf',retryable:false})}if(o.operation.operation==='upload')return {kind:'upload',receipt:{status:'verified',operation:'upload',path:'unique.3mf',retryable:false},actualPath:'/userdata/model/unique.3mf'};if(o.operation.operation==='delete'&&o.operation.expectedSize!==undefined&&o.operation.expectedSize!==5){const {MutationFailure}=await import(${JSON.stringify(mutationUrl)});throw new MutationFailure({status:'not_sent',operation:'delete',path:o.operation.path,retryable:false})}if(o.operation.operation==='delete')return {kind:'delete',receipt:{status:'acknowledged',operation:'delete',path:o.operation.path,retryable:false}};return {kind:'download',bytes:Buffer.from('video'),size:5,md5:'421b47ffd946ca083b65cd668c6b17e6'};}
export async function runRemoteArchive(o,deps){await auth(o,deps);return {entries:['Metadata/a.xml','Metadata/b.png'],...(o.member?{bytes:Buffer.from('preview')}:{})}}`;

const account = `import {appendFileSync} from 'node:fs';
export class AccountManager {
 async status(){return {state:'not_configured'}}
 async getConfiguredCloudMqttCredentials(serial,env,signal){
  appendFileSync(process.env.SIGNED_TEST_LOG,JSON.stringify({kind:'account-binding',serial,explicit:!!(env.BAMBU_SIGNED_CLOUD_BROKER && env.BAMBU_SIGNED_CLOUD_USERNAME && env.BAMBU_SIGNED_CLOUD_TOKEN),signal:!!signal})+'\\n');
  if(env.SIGNED_TEST_ACCOUNT_SCENARIO==='mismatch')throw Error('Configured printer is not uniquely bound to this account.');
  const token=env.BAMBU_SIGNED_CLOUD_TOKEN; const guard=()=>{if(signal?.aborted || env.BAMBU_SIGNED_CLOUD_TOKEN!==token)throw Error('Cloud configuration changed.');};
  return {url:env.BAMBU_SIGNED_CLOUD_BROKER||'mqtts://us.mqtt.bambulab.com:8883',username:env.BAMBU_SIGNED_CLOUD_USERNAME||'u_123',password:token||'dummy',assertCurrent:async()=>guard(),assertGenerationCurrent:guard};
 }
}`;
export async function resolve(specifier,context,next) {
  if(context.parentURL?.endsWith('/dist/signing-transport.js') && specifier==='./account/index.js') return {url:'data:text/javascript,'+encodeURIComponent(account),shortCircuit:true};
  if(context.parentURL?.endsWith('/dist/index.js') && specifier==='./cloud-print.js') return {url:'data:text/javascript,'+encodeURIComponent(cloud),shortCircuit:true};
  if(context.parentURL?.endsWith('/dist/index.js') && specifier==='./signing/http-proof.js') return {url:'data:text/javascript,'+encodeURIComponent(proof),shortCircuit:true};
  if(context.parentURL?.endsWith('/dist/index.js') && specifier==='./signing/bootstrap.js') return {url:'data:text/javascript,'+encodeURIComponent(bootstrap),shortCircuit:true};
  if(context.parentURL?.endsWith('/dist/index.js') && specifier==='./tutk.js') return {url:'data:text/javascript,'+encodeURIComponent(tutk),shortCircuit:true};
  return baseResolve(specifier,context,next);
}
