// Test-only Node loader: isolate the MQTT boundary and signing credentials in an MCP subprocess.
const mqtt = `import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
export function connect(url, options) {
  const client = new EventEmitter(); client.connected = false;
  client.subscribe = (topic, opts, cb) => { appendFileSync(process.env.SIGNED_TEST_LOG, JSON.stringify({subscribe:topic})+'\\n'); cb(null,[{topic,qos:1}]); };
  client.publish = (topic,payload,opts,cb) => { const value=JSON.parse(String(payload)); appendFileSync(process.env.SIGNED_TEST_LOG, JSON.stringify({topic,value,opts})+'\\n'); if(value.signed && process.env.SIGNED_TEST_PUBLISH_FAIL==='1') return cb(new Error('mock write failure')); cb(); if(value.security) queueMicrotask(()=>client.emit('message',topic.replace('/request','/report'),Buffer.from('{"security":{"sequence_id":"1"}}'), {retain:false})); };
  client.end = () => { client.connected=false;client.emit('close'); };
  queueMicrotask(()=>{client.connected=true;client.emit('connect');}); return client;
}`;
const signing = `export async function createSigningSession() { return {
  async beginInstall() {return {sequence:'1',payload:Buffer.from('{"security":{"sequence_id":"1"}}')};},
  async acceptInstallReply({reply}) {return reply?.security?.sequence_id==='1';},
  async signCommand(command) {return Buffer.from(JSON.stringify({signed:command}));},
  disconnect(){},readiness(){return {state:'READY',reason:'test'}}
}; }`;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/signing-transport.js')) {
    if (specifier === 'mqtt') return {url:'data:text/javascript,'+encodeURIComponent(mqtt),shortCircuit:true};
    if (specifier === './signing/index.js') return {url:'data:text/javascript,'+encodeURIComponent(signing),shortCircuit:true};
  }
  return nextResolve(specifier, context);
}
