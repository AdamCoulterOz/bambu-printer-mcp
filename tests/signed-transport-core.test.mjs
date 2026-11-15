import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {X509Certificate,createPrivateKey,privateDecrypt,verify,constants} from 'node:crypto';
import {SignedTransport} from '../dist/signing-transport.js';
import {fingerprint,validateAppMaterial} from '../dist/signing/pki.js';
import {SigningSession} from '../dist/signing/session.js';

function certFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'signed-core-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const put=(name,data)=>writeFileSync(join(dir,name),data,{mode:0o600});
  const run=(...args)=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
  mkdirSync(join(dir,'newcerts'));put('index','');put('serial','1001');put('crlnumber','1001');
  run('req','-x509','-newkey','rsa:2048','-noenc','-keyout','ca.key','-out','ca.pem','-days','10','-subj','/CN=Test CA','-addext','basicConstraints=critical,CA:true,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','subjectKeyIdentifier=hash');
  put('ca.cnf',`[ca]\ndefault_ca=main\n[main]\ndir=${dir}\ndatabase=$dir/index\nnew_certs_dir=$dir/newcerts\ncertificate=$dir/ca.pem\nprivate_key=$dir/ca.key\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\ndefault_days=5\ndefault_crl_days=3\npolicy=policy\n[policy]\ncommonName=supplied\n[app]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n[device]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,keyEncipherment,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n`);
  for(const [name,cn,ext] of [['app','Test App','app'],['device','SERIAL1234','device']]) {
    run('req','-new','-newkey','rsa:2048','-noenc','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+cn);
    run('ca','-batch','-notext','-config','ca.cnf','-extensions',ext,'-in',name+'.csr','-out',name+'.pem');
  }
  run('ca','-gencrl','-config','ca.cnf','-out','current.crl');
  const read=name=>readFileSync(join(dir,name),'utf8');
  const ca=read('ca.pem');return {ca,appKey:read('app.key'),appChain:read('app.pem')+ca,crl:read('current.crl'),device:read('device.pem')+ca,deviceKey:read('device.key')};
}

test('real signing session and mock MQTT exchange authenticate, encrypt and sign a command',async t=>{
  const f=certFixture(t);
  const app=await validateAppMaterial(f.appKey,f.appChain,f.crl,Date.now(),fingerprint(new X509Certificate(f.ca)));
  let seq=0; const session=new SigningSession('SERIAL1234',app,f.ca,{next:async()=>String(++seq)});
  class Broker extends EventEmitter {
    connected=false; sent=[];
    subscribe(topic,opts,cb){cb(null,[{topic,qos:1}]);}
    publish(topic,payload,opts,cb){
      const value=JSON.parse(payload.toString());this.sent.push({topic,value,opts});cb();
      if(value.security) queueMicrotask(()=>{
        const security={command:'app_cert_install',sequence_id:value.security.sequence_id,result:'SUCCESS',printer_cert:f.device};
        this.emit('message','device/WRONG/report',Buffer.from(JSON.stringify({security})), {retain:false});
        this.emit('message','device/SERIAL1234/report',Buffer.from(JSON.stringify({security:{...security,sequence_id:'999'}})), {retain:false});
        this.emit('message','device/SERIAL1234/report',Buffer.from(JSON.stringify({security})), {retain:false});
      });
    }
    end(){this.connected=false;this.emit('close');}
  }
  const broker=new Broker();
  const writer=new SignedTransport({serial:'SERIAL1234',url:'mqtts://printer.example',username:'test',password:'dummy',sessionFactory:async()=>session,connect:()=>{queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker;},timeoutMs:5000});
  await writer.send({command:'gcode_line',param:'M104 S0\n'});
  assert.equal(broker.sent.length,2);assert.ok(broker.sent.every(e=>e.topic==='device/SERIAL1234/request'&&e.opts.qos===1&&!e.opts.retain));
  const packet=broker.sent[1].value; const bytes=Buffer.from(JSON.stringify({print:packet.print}));
  assert.equal(packet.header.payload_len,bytes.length);
  assert.equal(verify('sha256',bytes,new X509Certificate(f.appChain).publicKey,Buffer.from(packet.header.sign_string,'base64')),true);
  const clear=privateDecrypt({key:createPrivateKey(f.deviceKey),padding:constants.RSA_PKCS1_PADDING},Buffer.from(packet.print.param_enc,'base64'));
  assert.equal(clear.toString(),'M104 S0\n');assert.equal(packet.print.sequence_id,'2');assert.equal(session.readiness().state,'DISCONNECTED');
});

test('real signing session cancellation during sequence reservation cannot publish late',async t=>{
  const f=certFixture(t);
  const app=await validateAppMaterial(f.appKey,f.appChain,f.crl,Date.now(),fingerprint(new X509Certificate(f.ca)));
  let count=0,release;
  const session=new SigningSession('SERIAL1234',app,f.ca,{next:async()=>++count===1?'1':await new Promise(resolve=>{release=resolve})});
  class Broker extends EventEmitter {
    connected=false;sent=[];
    subscribe(topic,opts,cb){cb(null,[{topic,qos:1}]);}
    publish(topic,payload,opts,cb){const value=JSON.parse(payload.toString());this.sent.push(value);cb();if(value.security)queueMicrotask(()=>this.emit('message','device/SERIAL1234/report',Buffer.from(JSON.stringify({security:{command:'app_cert_install',sequence_id:'1',result:'SUCCESS',printer_cert:f.device}})), {retain:false}));}
    end(){this.connected=false;this.emit('close');}
  }
  const broker=new Broker(), abort=new AbortController();
  const writer=new SignedTransport({serial:'SERIAL1234',url:'mqtts://printer.example',username:'test',password:'dummy',sessionFactory:async()=>session,connect:()=>{queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker},timeoutMs:5000});
  const task=writer.send({command:'stop',param:''},abort.signal);
  while(!release) await new Promise(resolve=>setTimeout(resolve,5));
  abort.abort(new Error('cancelled'));await assert.rejects(task,/cancelled/);
  release('2');await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(broker.sent.length,1);assert.equal(session.readiness().state,'DISCONNECTED');
});

test('HMS clear runs approval and fresh recheck before actual signing',async t=>{
  const f=certFixture(t), {BambuImplementation}=await import('../dist/printers/bambu.js');
  const app=await validateAppMaterial(f.appKey,f.appChain,f.crl,Date.now(),fingerprint(new X509Certificate(f.ca)));
  let count=0,confirmed=0,rechecks=0;
  const session=new SigningSession('SERIAL1234',app,f.ca,{next:async()=>String(++count)});
  class Broker extends EventEmitter {
    connected=false;sent=[];
    subscribe(topic,opts,cb){cb(null,[{topic,qos:1}]);}
    publish(topic,payload,opts,cb){const value=JSON.parse(payload.toString());this.sent.push(value);cb();if(value.security)queueMicrotask(()=>this.emit('message','device/SERIAL1234/report',Buffer.from(JSON.stringify({security:{command:'app_cert_install',sequence_id:'1',result:'SUCCESS',printer_cert:f.device}})),{retain:false}));}
    end(){this.connected=false;this.emit('close');}
  }
  const broker=new Broker(), bambu=new BambuImplementation(async()=>{confirmed++;return true});
  bambu.getSafetyStatus=async()=>{rechecks++;return {model:'h2s',raw:{print_error:42,hms:[],gcode_file:'job.gcode'}}};
  const result=await bambu.clearHmsErrors('printer.invalid','SERIAL1234','DUMMY',async(assertActive,beforeDispatch)=>{
    const writer=new SignedTransport({serial:'SERIAL1234',url:'mqtts://printer.example',username:'test',password:'dummy',sessionFactory:async()=>session,connect:()=>{queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker},beforePublish:beforeDispatch,assertActive,timeoutMs:5000});
    await writer.send({command:'clean_print_error'});
  });
  assert.equal(result.status,'success');assert.equal(confirmed,1);assert.ok(rechecks>=3);
  assert.equal(broker.sent.length,2);assert.equal(broker.sent[1].print.command,'clean_print_error');
  assert.equal('param' in broker.sent[1].print,false);
  const packet=broker.sent[1];assert.equal(verify('sha256',Buffer.from(JSON.stringify({print:packet.print})),new X509Certificate(f.appChain).publicKey,Buffer.from(packet.header.sign_string,'base64')),true);
});

test('real signing session accepts AMS-HT address 128 and rejects other unsupported addresses',async t=>{
  const f=certFixture(t);
  const app=await validateAppMaterial(f.appKey,f.appChain,f.crl,Date.now(),fingerprint(new X509Certificate(f.ca)));
  let seq=0;const session=new SigningSession('SERIAL1234',app,f.ca,{next:async()=>String(++seq)});
  class Broker extends EventEmitter {
    connected=false;sent=[];
    subscribe(topic,opts,cb){cb(null,[{topic,qos:1}]);}
    publish(topic,payload,opts,cb){const value=JSON.parse(payload.toString());this.sent.push(value);cb();if(value.security)queueMicrotask(()=>this.emit('message','device/SERIAL1234/report',Buffer.from(JSON.stringify({security:{command:'app_cert_install',sequence_id:value.security.sequence_id,result:'SUCCESS',printer_cert:f.device}})),{retain:false}));}
    end(){this.connected=false;this.emit('close');}
  }
  const broker=new Broker();
  const writer=new SignedTransport({serial:'SERIAL1234',url:'mqtts://printer.example',username:'test',password:'dummy',sessionFactory:async()=>session,connect:()=>{queueMicrotask(()=>{broker.connected=true;broker.emit('connect')});return broker;},timeoutMs:5000});
  await writer.send({command:'ams_control',ams_id:128,param:'stop_drying'});
  assert.equal(broker.sent[1].print.ams_id,128);assert.equal(broker.sent[1].print.param,'stop_drying');
  const {encodeSignedPrint}=await import('../dist/signing/wire.js');
  assert.throws(()=>encodeSignedPrint({command:'ams_control',sequence_id:'1',ams_id:129,param:'stop_drying'},app.certId,app.privateKey,new X509Certificate(f.device).publicKey),/Invalid AMS drying/);
});
