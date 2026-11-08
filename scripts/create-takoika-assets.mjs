// Original 16 × 16 pixel sprites, encoded directly as transparent PNGs.
import {mkdir, writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
const palette={'.':[0,0,0,0],o:[85,55,45,255],b:[153,89,60,255],h:[218,157,96,255],r:[213,83,87,255],p:[246,143,133,255],w:[255,249,230,255],k:[38,52,59,255],s:[107,164,171,255],t:[189,225,216,255]};
const sprites={
pot:[
'................','................','....oooooooo....','...ohhhhhhhho...','....obbbbboo....','....obhhbbo.....','...obhhbbbbo....','..obhhhbbbbbo...','..obhhhbbbbbo...','..obhhbbbbbbo...','..obbbbbbbbbo...','...obbbbbbbo....','...obbbbbbbo....','....ooooooo.....','................','................'],
octopus:[
'................','......rrrr......','....rrpppprr....','...rppppprrrr...','...rpppprrrrr...','...rpkwrrkwrr...','...rpkwrrkwrr...','....rrrrrrrr....','.....rwwrrr.....','...rrrrrrrrrr...','..rrprrprrprrr..','..rprrprrprrpr..','.rrr.rr..rr.rrr.','..r...r..r...r..','................','................'],
squid:[
'................','.......ss.......','......swws......','.....swwwws.....','....swwwwwws....','...swwwwwwwws...','..swtwwwwwwtws..','...sswwwwwwss...','....swkwwkws....','....swkwwkws....','....swwwwwws....','.....swwwws.....','....swswwsws....','...swswsswsws...','....s.s..s.s....','................']};
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]);}
const directory=new URL('../assets/takoika/',import.meta.url);await mkdir(directory,{recursive:true});
for(const [name,lines] of Object.entries(sprites)){
  if(lines.length!==16||lines.some(l=>l.length!==16))throw Error('Invalid sprite '+name);
  const header=Buffer.alloc(13);header.writeUInt32BE(16,0);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
  const raw=Buffer.concat(lines.map(line=>Buffer.from([0,...[...line].flatMap(p=>palette[p])])));
  await writeFile(new URL(name+'.png',directory),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
