import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SignedTransport } from '../dist/signing-transport.js';

class FakeMqtt extends EventEmitter {
  connected = false;
  published = [];
  closed = false;
  subscribe(topic, options, cb) { this.subscription = topic; cb(null, [{topic, qos: 1}]); }
  publish(topic, payload, options, cb) {
    this.published.push({topic, payload, options}); cb();
    if (this.published.length === 1) queueMicrotask(() => this.emit('message', 'device/ABC/report', Buffer.from(JSON.stringify({sequence: 1})), {retain:false}));
  }
  end(force) { this.closed = force; this.connected = false; this.emit('close'); }
}
const setup = (changes = {}) => {
  const mqtt = new FakeMqtt();
  const received = [];
  const session = {
    beginInstall: async () => ({sequence: '1', payload: Buffer.from('install')}),
    acceptInstallReply: async value => { received.push(value); return value.reply.sequence === 1; },
    signCommand: async command => Buffer.from(JSON.stringify(command)),
    disconnect() { this.disconnected = true; }, readiness: () => ({state:'ready', reason:''}),
  };
  const transport = new SignedTransport({ serial: 'ABC', url:'mqtts://example.test', username:'test', password:'secret', sessionFactory: async () => session,
    connect: () => { queueMicrotask(() => { mqtt.connected = true; mqtt.emit('connect'); }); return mqtt; }, timeoutMs: 100, ...changes });
  return {mqtt, session, transport, received};
};
test('subscribes before authenticated signed publish and closes one-shot connection', async () => {
  const {mqtt, session, transport, received} = setup();
  await transport.send({command:'stop', param:'é'});
  assert.equal(mqtt.subscription, 'device/ABC/report');
  assert.equal(received[0].topic, 'device/ABC/report');
  assert.equal(mqtt.published.length, 2);
  assert.deepEqual(mqtt.published.map(p => p.options), [{qos:1,retain:false},{qos:1,retain:false}]);
  assert.match(mqtt.published[1].payload.toString(), /é/);
  assert.equal(mqtt.closed, true); assert.equal(session.disconnected, true);
});
test('timeout force-closes and does not send late after an unmatched reply', async () => {
  const {mqtt, session, transport} = setup();
  session.acceptInstallReply = async () => false;
  await assert.rejects(transport.send({command:'stop'}), /timed out/);
  assert.equal(mqtt.closed, true); assert.equal(mqtt.published.length, 1);
  mqtt.emit('message', 'device/ABC/report', Buffer.from('{"sequence":1}'), {retain:false});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mqtt.published.length, 1);
});
test('cancellation while signing prevents subsequent publish', async () => {
  const {mqtt, session, transport} = setup();
  let release;
  session.signCommand = () => new Promise(resolve => { release = resolve; });
  const abort = new AbortController();
  const work = transport.send({command:'stop'}, abort.signal);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  abort.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  release(Buffer.from('late'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mqtt.closed, true); assert.equal(mqtt.published.length, 1);
});

test('explicit route and independent cloud credentials are required', async () => {
  const { signedControlConfiguration } = await import('../dist/signing-transport.js');
  assert.equal(signedControlConfiguration({}, 'printer.local', 'lan'), undefined);
  const common = { BAMBU_SIGNED_CONTROLS:'true', BAMBU_SIGNING_DIR:'/private/keys', BAMBU_SIGNING_DEVICE_CA_FILE:'/private/ca', BAMBU_SIGNING_STATE_DIR:'/private/state' };
  assert.throws(() => signedControlConfiguration(common, 'printer.local', 'lan'), /transport/);
  assert.throws(() => signedControlConfiguration({...common, BAMBU_SIGNED_WRITE_TRANSPORT:'cloud'}, 'printer.local', 'lan'), /account/);
  assert.throws(() => signedControlConfiguration({...common, BAMBU_SIGNED_WRITE_TRANSPORT:'local', BAMBU_SIGNED_LOCAL_TLS_SERVERNAME:'127.0.0.1'}, '127.0.0.1', 'lan'), /DNS name/);
  const local = signedControlConfiguration({...common, BAMBU_SIGNED_WRITE_TRANSPORT:'local', BAMBU_SIGNED_LOCAL_TLS_CA_FILE:'/private/broker-ca', BAMBU_SIGNED_LOCAL_TLS_SERVERNAME:'printer.example'}, '127.0.0.1', 'lan');
  assert.equal(local.localTlsServername, 'printer.example');
  assert.equal(local.localTlsCaFile, '/private/broker-ca');
  const cloud = signedControlConfiguration({...common, BAMBU_SIGNED_WRITE_TRANSPORT:'cloud', BAMBU_SIGNED_CLOUD_BROKER:'mqtts://cloud.example', BAMBU_SIGNED_CLOUD_USERNAME:'account', BAMBU_SIGNED_CLOUD_TOKEN:'cloud-token'}, 'printer.local', 'lan');
  assert.equal(cloud.password, 'cloud-token');
  assert.throws(() => new SignedTransport({...cloud, serial:'ABC', sessionFactory: async () => ({}) , url:'mqtts://user:secret@cloud.example'}), /without embedded credentials/);
});

test('rejects failed subscription before any publish', async () => {
  const {mqtt, transport} = setup();
  mqtt.subscribe = (topic, options, cb) => cb(null, [{topic, qos:128}]);
  await assert.rejects(transport.send({command:'stop'}), /subscription failed/);
  assert.equal(mqtt.published.length, 0);
  assert.equal(mqtt.closed, true);
});
test('does not accept replies from another printer topic', async () => {
  const {mqtt, session, transport, received} = setup({timeoutMs:30});
  mqtt.publish = function (topic, payload, options, cb) {
    this.published.push({topic,payload,options}); cb();
    if (this.published.length === 1) queueMicrotask(() => this.emit('message', 'device/OTHER/report', Buffer.from('{"sequence":1}'), {retain:false}));
  };
  await assert.rejects(transport.send({command:'stop'}), /timed out/);
  assert.equal(received.length, 0); assert.equal(mqtt.published.length, 1); assert.equal(session.disconnected, true);
});
test('hides sensitive MQTT errors', async () => {
  const {mqtt, transport} = setup();
  mqtt.subscribe = (topic, options, cb) => cb(new Error('secret credential'), []);
  await assert.rejects(transport.send({command:'stop'}), error => /subscription failed/.test(error.message) && !error.message.includes('secret'));
});
test('connection loss during signing cannot publish a queued command', async () => {
  const {mqtt, session, transport} = setup();
  let release;
  session.signCommand = () => new Promise(resolve => { release = resolve; });
  const work = transport.send({command:'stop'});
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  mqtt.connected = false; mqtt.emit('close');
  await assert.rejects(work, /connection closed/);
  release(Buffer.from('late'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mqtt.published.length, 1);
});

test('MCP signed selection fails closed with incomplete configuration and rejects raw native control', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-controls-test-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  const server = new StdioClientTransport({command:process.execPath, args:[fileURLToPath(new URL('../dist/index.js', import.meta.url))], cwd,
    env:{...process.env, BAMBU_SIGNED_CONTROLS:'true', BAMBU_SIGNING_DIR:'', BAMBU_SIGNING_DEVICE_CA_FILE:'', BAMBU_SIGNING_STATE_DIR:'', BAMBU_SIGNED_WRITE_TRANSPORT:'local', BAMBU_PRINTER_HOST:'127.0.0.1', BAMBU_PRINTER_SERIAL:'TESTSERIAL', BAMBU_PRINTER_ACCESS_TOKEN:'DUMMY', BAMBU_MODEL:'x2d'}, stderr:'pipe'});
  server.stderr?.on('data', () => {});
  const client = new Client({name:'signed-control-test',version:'1'});
  t.after(() => client.close());
  await client.connect(server);
  const stop = await client.callTool({name:'cancel_print',arguments:{}});
  assert.equal(stop.isError, true); assert.match(JSON.stringify(stop), /signing directory/i);
  for (const [name, args] of [
    ['pause_print', {}], ['set_print_speed', {mode:'standard'}], ['set_airduct_mode', {mode:'cooling'}],
    ['reread_ams_rfid', {ams_id:0, slot_id:0}], ['set_temperature', {component:'bed', temperature:0}],
    ['skip_objects', {object_ids:[1]}], ['set_ams_drying', {action:'stop',ams_id:0}], ['set_light', {light:'chamber_light',mode:'on'}],
  ]) {
    const response = await client.callTool({name, arguments:args});
    assert.equal(response.isError, true, name);
    assert.match(JSON.stringify(response), /signing directory/i, name);
  }
  const raw = await client.callTool({name:'x2d_native_control',arguments:{message_json:'{"print":{"command":"stop"}}'}});
  assert.equal(raw.isError, true); assert.match(JSON.stringify(raw), /Raw native commands are unavailable/);
  const alive = await client.callTool({name:'get_agent_readiness',arguments:{}}); assert.notEqual(alive.isError,true);
});

test('wrong install sequence is ignored before the matching reply', async () => {
  const {mqtt, transport, received} = setup();
  mqtt.publish = function(topic, payload, options, cb) {
    this.published.push({topic, payload, options}); cb();
    if (this.published.length === 1) queueMicrotask(() => {
      this.emit('message', 'device/ABC/report', Buffer.from('{"sequence":2}'), {retain:false});
      this.emit('message', 'device/ABC/report', Buffer.from('{"sequence":1}'), {retain:false});
    });
  };
  await transport.send({command:'pause'});
  assert.deepEqual(received.map(item => item.reply.sequence), [2,1]);
  assert.equal(received[0].generation, received[1].generation);
  assert.equal(mqtt.published.length, 2);
});

test('failed pre-publish recheck blocks the signed command', async () => {
  const {mqtt, transport} = setup({beforePublish: async () => { throw new Error('state changed'); }});
  await assert.rejects(transport.send({command:'resume'}), /state changed/);
  assert.equal(mqtt.published.length, 1);
  assert.equal(mqtt.closed, true);
});
test('explicit close invalidates an in-flight signed send', async () => {
  const {mqtt, session, transport} = setup();
  let release;
  session.signCommand = () => new Promise(resolve => { release = resolve; });
  const work = transport.send({command:'stop'});
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  transport.close();
  await assert.rejects(work, /connection closed/);
  release(Buffer.from('late'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mqtt.published.length, 1);
});

test('signed selection blocks raw gcode_file before download, upload or publish', async () => {
  const {BambuImplementation} = await import('../dist/printers/bambu.js');
  const old = process.env.BAMBU_SIGNED_CONTROLS;
  process.env.BAMBU_SIGNED_CONTROLS = 'true';
  const printer = new BambuImplementation();
  let writes = 0;
  printer.ftpDownload = printer.ftpUpload = printer.getPrinter = async () => { writes++; throw new Error('unexpected IO'); };
  try {
    await assert.rejects(printer.startJob('printer.invalid', 'TESTSERIAL', 'DUMMY', 'cache/job.gcode', 'p1s'), /does not support gcode_file/);
    await assert.rejects(printer.printRawPrepared('printer.invalid', 'TESTSERIAL', 'DUMMY', '/ignored.gcode', 'cache/job.gcode', 'p1s', () => {}), /does not support gcode_file/);
    assert.equal(writes, 0);
  } finally { if (old === undefined) delete process.env.BAMBU_SIGNED_CONTROLS; else process.env.BAMBU_SIGNED_CONTROLS = old; }
});

test('MCP typed controls use the selected signed MQTT writer across subprocess boundary', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path'); const os = await import('node:os'); const fs = await import('node:fs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-controls-fixture-'));
  t.after(() => fs.rmSync(cwd, {recursive:true,force:true}));
  const ca = path.join(cwd,'device-ca.pem'), log = path.join(cwd,'wire.jsonl');
  fs.writeFileSync(ca, 'independent test trust'); fs.writeFileSync(log,'');
  const loader = fileURLToPath(new URL('./signed-transport-loader.mjs', import.meta.url));
  const server = new StdioClientTransport({command:process.execPath, args:['--experimental-loader', loader, fileURLToPath(new URL('../dist/index.js', import.meta.url))], cwd,
    env:{...process.env, SIGNED_TEST_LOG:log, BAMBU_SIGNED_CONTROLS:'true', BAMBU_SIGNING_DIR:cwd, BAMBU_SIGNING_DEVICE_CA_FILE:ca, BAMBU_SIGNING_STATE_DIR:cwd, BAMBU_SIGNED_WRITE_TRANSPORT:'local', BAMBU_PRINTER_HOST:'127.0.0.1', BAMBU_PRINTER_SERIAL:'TESTSERIAL', BAMBU_PRINTER_ACCESS_TOKEN:'DUMMY', BAMBU_MODEL:'p1s'},stderr:'pipe'});
  server.stderr?.on('data',()=>{});
  const client = new Client({name:'signed-routing-test',version:'1'}); t.after(()=>client.close()); await client.connect(server);
  const calls = [
    ['cancel_print',{},'stop'], ['pause_print',{},'pause'], ['set_print_speed',{mode:'standard'},'print_speed'],
    ['set_airduct_mode',{mode:'cooling'},'set_airduct'], ['reread_ams_rfid',{ams_id:0,slot_id:0},'ams_get_rfid'],
    ['set_temperature',{component:'bed',temperature:0},'gcode_line'], ['set_fan_speed',{fan:'part',speed:50},'gcode_line'],
    ['skip_objects',{object_ids:[1]},'skip_objects'], ['set_ams_drying',{action:'stop',ams_id:0},'ams_control'],
  ];
  for (const [name,args] of calls) {
    const response = await client.callTool({name,arguments:args}); assert.notEqual(response.isError,true,`${name}: ${JSON.stringify(response)}`);
  }
  const lightResult = await client.callTool({name:'set_light',arguments:{light:'chamber_light',mode:'on'}});
  assert.notEqual(lightResult.isError,true,JSON.stringify(lightResult));
  const entries = fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const sent = entries.filter(e=>e.value?.signed).map(e=>e.value.signed);
  assert.deepEqual(sent.map(c=>c.command),calls.map(c=>c[2]));
  assert.equal(sent[5].param,'M140 S0\n'); assert.equal(sent[6].param,'M106 P1 S127.5\n');
  const lights=entries.filter(e=>e.value?.system); assert.equal(lights.length,1);
  assert.deepEqual(Object.keys(lights[0].value),['system']);
  assert.equal(lights[0].value.system.command,'ledctrl'); assert.equal(lights[0].value.system.led_node,'chamber_light'); assert.equal(lights[0].value.system.led_mode,'on');
  const readiness=await client.callTool({name:'get_agent_readiness',arguments:{}});assert.notEqual(readiness.isError,true);
  assert.ok(entries.filter(e=>e.value).every(e=>e.topic==='device/TESTSERIAL/request' && e.opts.qos===1 && e.opts.retain===false));
});

test('checked project_file uses signed MQTT after upload and safety recheck', async t => {
  const path = await import('node:path'); const os = await import('node:os'); const fs = await import('node:fs');
  const {fileURLToPath} = await import('node:url'); const {execFile} = await import('node:child_process'); const {promisify} = await import('node:util');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'signed-project-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ca=path.join(dir,'ca'), log=path.join(dir,'log'); fs.writeFileSync(ca,'test trust');fs.writeFileSync(log,'');
  const env={...process.env,SIGNED_TEST_DIR:dir,SIGNED_TEST_LOG:log,BAMBU_DISPATCH_CHECK_MS:'0',BAMBU_SIGNED_CONTROLS:'true',BAMBU_SIGNING_DIR:dir,BAMBU_SIGNING_DEVICE_CA_FILE:ca,BAMBU_SIGNING_STATE_DIR:dir,BAMBU_SIGNED_WRITE_TRANSPORT:'local'};
  await promisify(execFile)(process.execPath,['--experimental-loader',fileURLToPath(new URL('./signed-transport-loader.mjs',import.meta.url)),fileURLToPath(new URL('./signed-transport-project-fixture.mjs',import.meta.url))],{env});
});

test('retained, metadata-free and pre-install matching replies cannot authorize a command', async () => {
  const {mqtt, session, transport, received}=setup({timeoutMs:300});
  let release;
  session.beginInstall=()=>new Promise(resolve=>{release=resolve});
  mqtt.publish=function(topic,payload,options,cb) {
    this.published.push({topic,payload,options});cb();
    if(this.published.length===1) queueMicrotask(()=>{
      const packet=Buffer.from('{"sequence":1}');
      this.emit('message','device/ABC/report',packet,{retain:true});
      this.emit('message','device/ABC/report',packet);
      setTimeout(()=>this.emit('message','device/ABC/report',packet,{retain:false}),5);
    });
  };
  const task=transport.send({command:'stop'});
  while(!release) await new Promise(resolve=>setTimeout(resolve,1));
  mqtt.emit('message','device/ABC/report',Buffer.from('{"sequence":1}'),{retain:false});
  assert.equal(received.length,0);assert.equal(mqtt.published.length,0);
  release({sequence:'1',payload:Buffer.from('install')});
  await task;
  assert.equal(received.length,1);assert.equal(mqtt.published.length,2);
});

test('explicit account cloud selection never mixes partial environment credentials', async () => {
  const {resolveSignedControlConfiguration} = await import('../dist/signing-transport.js');
  const base={BAMBU_SIGNED_CONTROLS:'true',BAMBU_SIGNED_WRITE_TRANSPORT:'cloud',BAMBU_SIGNED_CLOUD_AUTH:'account',BAMBU_SIGNING_DIR:'/keys',BAMBU_SIGNING_DEVICE_CA_FILE:'/ca',BAMBU_SIGNING_STATE_DIR:'/state'};
  let calls=0;const account={async getCloudMqttCredentials(serial){calls++;assert.equal(serial,'PRINTER');return {url:'mqtts://account.example',username:'account-user',password:'account-secret',assertCurrent:async()=>{},assertGenerationCurrent:()=>{}}}};
  const selected=await resolveSignedControlConfiguration(base,'host','lan','PRINTER',account);
  assert.equal(selected.password,'account-secret');assert.equal(calls,1);
  await assert.rejects(resolveSignedControlConfiguration({...base,BAMBU_SIGNED_CLOUD_USERNAME:'partial'},'host','lan','PRINTER',account),/incomplete/);
  assert.equal(calls,1);
  const explicit=await resolveSignedControlConfiguration({...base,BAMBU_SIGNED_CLOUD_BROKER:'mqtts://explicit.example',BAMBU_SIGNED_CLOUD_USERNAME:'explicit-user',BAMBU_SIGNED_CLOUD_TOKEN:'explicit-secret'},'host','lan','PRINTER',account);
  assert.equal(explicit.password,'explicit-secret');assert.equal(calls,1);
  await assert.rejects(resolveSignedControlConfiguration({...base,BAMBU_SIGNING_STATE_DIR:''},'host','lan','PRINTER',account),/absolute paths/);
  assert.equal(calls,1);
});

test('account tools expose only temporary local login and cached-session status', async t => {
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const path=await import('node:path');const os=await import('node:os');const fs=await import('node:fs');const {fileURLToPath}=await import('node:url');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'account-tools-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:home,env:{...process.env,HOME:home,MCP_TRANSPORT:'stdio'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
  const client=new Client({name:'account-tools-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
  const list=await client.listTools();for(const name of ['account_status','account_login','account_cancel_login','account_list_printers','account_logout'])assert.ok(list.tools.some(tool=>tool.name===name));
  let result=await client.callTool({name:'account_status',arguments:{}});assert.notEqual(result.isError,true);assert.match(JSON.stringify(result),/not_configured/);assert.match(JSON.stringify(result),/liveValidated/);
  result=await client.callTool({name:'account_login',arguments:{region:'global',password:'never-accepted'}});assert.equal(result.isError,true);
  result=await client.callTool({name:'account_login',arguments:{region:'global'}});assert.notEqual(result.isError,true);assert.match(JSON.stringify(result),/127\.0\.0\.1/);assert.doesNotMatch(JSON.stringify(result),/accessToken|password|session\.json/);
  result=await client.callTool({name:'account_cancel_login',arguments:{}});assert.notEqual(result.isError,true);
  result=await client.callTool({name:'account_logout',arguments:{}});assert.notEqual(result.isError,true);assert.match(JSON.stringify(result),/remote_revoked/);
});

test('a later connection cannot reuse an earlier generation or its retained reply', async () => {
  const brokers=[], accepted=[];let serial=0;
  const transport=new SignedTransport({serial:'ABC',url:'mqtts://printer.example',username:'user',password:'dummy',timeoutMs:250,
    sessionFactory:async()=>{const id=++serial;return {beginInstall:async()=>({sequence:String(id),payload:Buffer.from('install')}),acceptInstallReply:async v=>{accepted.push([id,v.generation,v.reply.sequence]);return v.reply.sequence===id},signCommand:async()=>Buffer.from('signed'),disconnect(){},readiness:()=>({state:'INSTALLING',reason:''})}},
    connect:()=>{const broker=new FakeMqtt();brokers.push(broker);broker.publish=function(topic,payload,options,cb){this.published.push({topic,payload,options});cb();if(this.published.length===1&&brokers.length===2)queueMicrotask(()=>{const report='device/ABC/report';brokers[0].emit('message',report,Buffer.from('{"sequence":1}'),{retain:false});this.emit('message',report,Buffer.from('{"sequence":2}'),{retain:true});setTimeout(()=>this.emit('message',report,Buffer.from('{"sequence":2}'),{retain:false}),5)})};queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker}
  });
  const abort=new AbortController(), first=transport.send({command:'stop'},abort.signal);
  while(!brokers[0]?.published.length) await new Promise(resolve=>setTimeout(resolve,1));
  abort.abort(new Error('cancelled'));await assert.rejects(first,/cancelled/);
  await transport.send({command:'stop'});
  assert.equal(brokers[0].published.length,1);assert.equal(brokers[1].published.length,2);
  assert.deepEqual(accepted.filter(([id])=>id===2).map(x=>x[2]),[2]);
});

test('X2D typed AMS-HT 128 drying reaches the signed route', async t => {
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const path=await import('node:path');const os=await import('node:os');const fs=await import('node:fs');const {fileURLToPath}=await import('node:url');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'signed-ams-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ca=path.join(dir,'ca'),log=path.join(dir,'log');fs.writeFileSync(ca,'test trust');fs.writeFileSync(log,'');
  const loader=fileURLToPath(new URL('./signed-transport-loader.mjs',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-loader',loader,fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:dir,env:{...process.env,SIGNED_TEST_LOG:log,BAMBU_SIGNED_CONTROLS:'true',BAMBU_SIGNING_DIR:dir,BAMBU_SIGNING_DEVICE_CA_FILE:ca,BAMBU_SIGNING_STATE_DIR:dir,BAMBU_SIGNED_WRITE_TRANSPORT:'local',BAMBU_PRINTER_HOST:'printer.invalid',BAMBU_PRINTER_SERIAL:'20PTESTSERIAL',BAMBU_PRINTER_ACCESS_TOKEN:'DUMMY',BAMBU_MODEL:'x2d'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
  const client=new Client({name:'ams-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
  const result=await client.callTool({name:'set_ams_drying',arguments:{action:'stop',ams_id:128}});assert.notEqual(result.isError,true,JSON.stringify(result));
  const sent=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.value?.signed);
  assert.equal(sent.length,1);assert.equal(sent[0].value.signed.ams_id,128);assert.equal(sent[0].value.signed.command,'ams_control');
  const rejected=await client.callTool({name:'set_ams_drying',arguments:{action:'stop',ams_id:129}});assert.equal(rejected.isError,true);
});

async function logoutFixture(t) {
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const {AccountManager}=await import('../dist/account/index.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'signed-account-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const token=`x.${Buffer.from(JSON.stringify({username:'u_123'})).toString('base64url')}.x`;
  fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify({version:1,region:'global',token,expiresAt:null}),{mode:0o600});
  const account=new AccountManager({sessionDirectory:dir,vendor:{async request(){return {devices:[{dev_id:'ABC',name:'test'}]}}}});
  const credentials=await account.getCloudMqttCredentials('ABC');return {account,credentials};
}
function guardedSession(overrides={}) {return {beginInstall:async()=>({sequence:'1',payload:Buffer.from('install')}),acceptInstallReply:async()=>true,signCommand:async()=>Buffer.from('signed'),disconnect(){},readiness:()=>({state:'READY',reason:''}),...overrides}}

test('account logout during signing blocks the current command and queued writer',async t=>{
  const {account,credentials}=await logoutFixture(t);const broker=new FakeMqtt();let release;
  const session=guardedSession({signCommand:()=>new Promise(resolve=>{release=resolve})});
  const writer=new SignedTransport({serial:'ABC',url:'mqtts://example.test',username:'user',password:'dummy',accountGuard:credentials,sessionFactory:async()=>session,connect:()=>{queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker},timeoutMs:500});
  const first=writer.send({command:'stop'}),second=writer.send({command:'pause'});
  // Attach rejection observers before invalidation so Node never sees an unhandled rejection.
  const firstResult=assert.rejects(first,/Account/),secondResult=assert.rejects(second,/Account/);
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  const logout=account.logout();release(Buffer.from('signed'));await logout;await firstResult;await secondResult;
  assert.equal(broker.published.length,1);
});
test('account logout while key loading prevents MQTT connect',async t=>{
  const {account,credentials}=await logoutFixture(t);let release,connections=0;
  const writer=new SignedTransport({serial:'ABC',url:'mqtts://example.test',username:'user',password:'dummy',accountGuard:credentials,sessionFactory:()=>new Promise(resolve=>{release=resolve}),connect:()=>{connections++;return new FakeMqtt()},timeoutMs:500});
  const work=writer.send({command:'stop'});const rejected=assert.rejects(work,/Account/);
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  const logout=account.logout();release(guardedSession());await logout;await rejected;assert.equal(connections,0);
});
test('account logout while connect is pending prevents installation publish',async t=>{
  const {account,credentials}=await logoutFixture(t);const broker=new FakeMqtt();let connected=false;
  const writer=new SignedTransport({serial:'ABC',url:'mqtts://example.test',username:'user',password:'dummy',accountGuard:credentials,sessionFactory:async()=>guardedSession(),connect:()=>{connected=true;return broker},timeoutMs:500});
  const work=writer.send({command:'stop'});const rejected=assert.rejects(work,/Account/);
  while(!connected)await new Promise(resolve=>setTimeout(resolve,1));
  const logout=account.logout();broker.connected=true;broker.emit('connect');await logout;await rejected;assert.equal(broker.published.length,0);
});

test('signed readiness reports only static configuration shape without contacting a device or account',async t=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const {fileURLToPath}=await import('node:url');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'signed-readiness-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const base={...process.env,HOME:home,MCP_TRANSPORT:'stdio',BAMBU_PRINTER_HOST:'printer.invalid',BAMBU_PRINTER_SERIAL:'TESTSERIAL',BAMBU_PRINTER_ACCESS_TOKEN:'DUMMY',BAMBU_MODEL:'p1s',BAMBU_SIGNED_CONTROLS:'',BAMBU_SIGNED_WRITE_TRANSPORT:'',BAMBU_SIGNING_DIR:'',BAMBU_SIGNING_DEVICE_CA_FILE:'',BAMBU_SIGNING_STATE_DIR:'',BAMBU_SIGNED_CLOUD_AUTH:'',BAMBU_SIGNED_CLOUD_BROKER:'',BAMBU_SIGNED_CLOUD_USERNAME:'',BAMBU_SIGNED_CLOUD_TOKEN:'',BAMBU_SIGNED_LOCAL_TLS_CA_FILE:'',BAMBU_SIGNED_LOCAL_TLS_SERVERNAME:''};
  async function readiness(extra) {
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:home,env:{...base,...extra},stderr:'pipe'});transport.stderr?.on('data',()=>{});
    const client=new Client({name:'readiness-test',version:'1'});try {await client.connect(transport);const result=await client.callTool({name:'get_agent_readiness',arguments:{}});assert.notEqual(result.isError,true);return result.structuredContent;}finally {await client.close();}
  }
  let result=await readiness({});assert.deepEqual(result.signed_controls,{selected:'not_selected',configuration:'unknown'});
  result=await readiness({BAMBU_SIGNED_CONTROLS:'true'});assert.deepEqual(result.signed_controls,{selected:'selected',configuration:'missing'});assert.ok(result.blockers.some(item=>item.code==='signed_configuration'));
  const common={BAMBU_SIGNED_CONTROLS:'true',BAMBU_SIGNING_DIR:'/missing/keys',BAMBU_SIGNING_DEVICE_CA_FILE:'/missing/ca',BAMBU_SIGNING_STATE_DIR:'/missing/state'};
  result=await readiness({...common,BAMBU_SIGNED_WRITE_TRANSPORT:'local'});assert.deepEqual(result.signed_controls,{selected:'selected',configuration:'available'});assert.equal(result.capabilities.signed_mqtt,'unknown');
  result=await readiness({...common,BAMBU_SIGNED_WRITE_TRANSPORT:'cloud',BAMBU_SIGNED_CLOUD_AUTH:'account'});assert.deepEqual(result.signed_controls,{selected:'selected',configuration:'unknown'});
});
