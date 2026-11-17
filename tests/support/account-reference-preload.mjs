import {appendFileSync} from 'node:fs';
import {AccountManager} from '../../dist/account/index.js';
import {BambuImplementation} from '../../dist/printers/bambu.js';
const log=value=>appendFileSync(process.env.REFERENCE_TEST_LOG,JSON.stringify(value)+'\n');
const serial='20PTEST';let checks=0,reads=0,profiles=0,lastStatus;
const task={id:'42',deviceId:serial,status:2,isPrintable:true,isDelete:false,mode:'cloud_file',modelId:'m',profileId:456,instanceId:789,plateIndex:2,deviceModel:'X2D',bedType:'textured_plate',useAms:true,isPublicProfile:false,amsMapping:[-1,1,128,-1,-1],amsMapping2:[{amsId:255,slotId:255},{amsId:0,slotId:1},{amsId:128,slotId:0},{amsId:255,slotId:255},{amsId:255,slotId:255}],amsDetailMapping:[{ams:1,nozzleId:1,amsId:0,slotId:1},{ams:128,nozzleId:0,amsId:128,slotId:0}]};
if(process.env.REFERENCE_TEST_SCENARIO?.startsWith('mapping_'))task.amsDetailMapping[0].amsId=9;
const profile={profileId:456,modelId:'m',extention:{modelInfo:{plates:[{index:2,nozzleDiameters:[0.4,0.4],filaments:[{id:'2',type:'PETG'},{id:'3',type:'PLA'}]}]}}};
AccountManager.prototype.beginCompletedJobAccount=async()=>({
 fetchTask:async()=>structuredClone(task),fetchProfile:async()=>{profiles++;const value=structuredClone(profile);if(process.env.REFERENCE_TEST_SCENARIO==='changed_ref'&&profiles>1)value.extention.modelInfo.plates[0].filaments[0].type='ABS';return value;},
 assertCurrent:async()=>{if(process.env.REFERENCE_TEST_SCENARIO==='account_flip'&&++checks>=2)throw Error('Account authority changed.');},
 assertGenerationCurrent:()=>{},
 withLockedAuthority:async fn=>fn(),
 dispatch:async(payload,_headers,on)=>{if(process.env.REFERENCE_TEST_SCENARIO==='stale_handoff')lastStatus.observation.requestedAt=Date.now()-200000;on();log({kind:'post',payload});if(process.env.REFERENCE_TEST_SCENARIO==='unknown')throw Error('lost');return '99';},
});
BambuImplementation.prototype.getSafetyStatus=async()=>{
 reads++;const scenario=process.env.REFERENCE_TEST_SCENARIO;
 if(scenario==='cancel'){log({kind:'status_waiting'});await new Promise(resolve=>setTimeout(resolve,200));}
 if(scenario==='status_error')throw Error('fresh telemetry unavailable');
 const tray={id:'1',tray_type:scenario==='mapping_missing_material'?'':(scenario==='material_change'||scenario==='mapping_changed_slot')&&reads===3?'ABS':'PETG'};
 if(scenario==='occupancy_state_zero'||scenario==='occupancy_zero_nomask')tray.state=0;
 const report={model:'x2d',gcode_state:'IDLE',nozzle_diameter:[scenario==='nozzle_mismatch'?'0.8':'0.4','0.4'],print_error:0,hms:[],ams:{...(['occupancy_missing','occupancy_zero_nomask'].includes(scenario)?{}:{tray_exist_bits:'2'}),ams:[{id:'0',tray:[tray]},{id:'128',tray_exist_bits:'1',tray:[{id:'0',tray_type:'PLA'}]}]}};
 return lastStatus={connected:true,serial,raw:report,observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now()}};
};
BambuImplementation.prototype.confirmHardwareAction=async(message,physical)=>{log({kind:'confirmation',physical,message});if(process.env.REFERENCE_TEST_SCENARIO==='declined')throw Error('confirmation declined');};
