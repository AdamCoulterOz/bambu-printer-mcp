/** TUTK datagram fixed-key obfuscation. Protocol facts from
 * open-bamboo-networking 77de55a, src/camera/tutk/IotcClient.cpp:179–344.
 * This transform is reversible obfuscation, not an authenticity check. */
const key=Buffer.from('Charlie is the d','ascii');
const perm=[[15,8,9,11],[14,12,10,13],[0,5,1,2],[3,7,4,6]];
const turns=[1,5,9,13], inner=[3,7,11,15],tail=[7,4,3,2,1,6,5,0];
const ror=(n:number,k:number)=>((n>>>k)|(n<<(32-k)))>>>0;
const rol=(n:number,k:number)=>((n<<k)|(n>>>(32-k)))>>>0;
export function transcode(input:Uint8Array, direction:'encode'|'decode'):Buffer {
 const out=Buffer.from(input),limit=out.length-out.length%16;
 for(let pos=0;pos<limit;pos+=16){
  const block=Buffer.from(out.subarray(pos,pos+16)), middle=Buffer.alloc(16);
  if(direction==='encode'){
   for(let i=0;i<4;i++)middle.writeUInt32LE((ror(block.readUInt32LE(i*4),turns[i])^key.readUInt32LE(i*4))>>>0,i*4);
   for(let i=0;i<4;i++){const v=perm[i].reduce((a,j)=>((a<<8)|middle[j])>>>0,0);out.writeUInt32LE(ror(v,inner[i]),pos+i*4);}
  }else{
   for(let i=0;i<4;i++){const v=rol(block.readUInt32LE(i*4),inner[i]);for(let j=0;j<4;j++)middle[perm[i][j]]=(v>>>(24-8*j))&255;}
   for(let i=0;i<4;i++)out.writeUInt32LE(rol((middle.readUInt32LE(i*4)^key.readUInt32LE(i*4))>>>0,turns[i]),pos+i*4);
  }
 }
 if(out.length-limit===8){const orig=Buffer.from(out.subarray(limit));for(let i=0;i<8;i++){if(direction==='encode')out[limit+i]=orig[tail[i]]^key[tail[i]];else out[limit+tail[i]]=orig[i]^key[tail[i]];}}
 else for(let i=limit;i<out.length;i++)out[i]^=key[i%16];
 return out;
}
/** The first header block is always scrambled; remaining data packets stop at byte 64. */
export function decodeDatagram(raw:Buffer):Buffer {
 if(raw.length<16||raw.length>65535)throw Error('Invalid datagram');
 const head=transcode(raw.subarray(0,16),'decode');const n=head[3]===0x0b?Math.min(raw.length,64):raw.length;
 return Buffer.concat([head,transcode(raw.subarray(16,n),'decode'),raw.subarray(n)]);
}
