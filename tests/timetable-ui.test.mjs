import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const read=f=>readFile(new URL('../'+f,import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this._text='';this.value='';this.dataset={};this.style={};}
 set textContent(v){this._text=String(v);this.children=[];} get textContent(){return this._text+this.children.map(c=>c.textContent||'').join('');}
 append(...nodes){nodes.forEach(n=>{n.parent=this;this.children.push(n);});}
 replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
 setAttribute(name,value){this[name]=value;}
 async emit(name){for(const fn of this.listeners[name]||[])await fn({target:this,preventDefault(){}});}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
 showModal(){} close(){} focus(){} click(){this.clicked=true;}
}
const walk=e=>[e,...e.children.flatMap(walk)];
const copy=v=>JSON.parse(JSON.stringify(v));
function sample(){return {staff_scope:'band',date:'2099-01-01',pa:510,gather:570,start:600,people:[
 {id:'me',name:'本人',entries:['entry1'],year:2,registered:true,excluded:false},
 {id:'other',name:'他の人',entries:['entry2'],year:2,registered:true,excluded:false},
 {id:'invalid',name:'未参加',entries:[],year:1,registered:false,excluded:false}
 ],items:[{kind:'performance',entry:'entry1',name:'バンド1',minutes:15,available:[],staff:[null,null,null,null]},
 {kind:'transition',minutes:5,staff:[]},
 {kind:'performance',entry:'entry2',name:'バンド2',minutes:15,available:[],staff:['me',null,null,null]}]};}
async function environment(data){
 const ids=new Map(),get=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},calls=[],confirmations=[],exports=[],auth=[];
 const sandbox=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t),body:new Element('body'),addEventListener(){}},
  currentAuthUser:{id:'me'},showPage(){},window:{addEventListener(){}},setTimeout(){},structuredClone,Intl,console,
  alert:message=>{throw Error(message);},confirm:message=>{confirmations.push(message);return true;},
  TimetableExport:Object.fromEntries(['pdf','png','excel'].map(f=>[f,p=>exports.push({format:f,plan:copy(p)})])),
  db:{auth:{onAuthStateChange:fn=>auth.push(fn)},from:()=>({select:()=>({order:async()=>({data:[{id:'od',title:'テストOD'}]})})}),
   rpc:async(name,args={})=>{calls.push({name,args:copy(args)});if(name==='od_timetable_context')return {data:copy(data)};
    if(name==='od_timetable_save'){data.draft=copy(args.p_plan);data.revision++;if(args.p_publish)data.published=copy(args.p_plan);return {data:null};}
    if(name==='od_timetable_inbox')return {data:[]};throw Error(name);}}
 });
 for(const f of ['timetable-core.js','timetable.js'])vm.runInContext(await read(f),sandbox);
 const find=(text,tag='button',root=get('timetable-body'))=>walk(root).find(e=>e.tagName===tag&&e.textContent===text);
 const open=async()=>{await get('open-timetable-button').emit('click');await find('テストOD').emit('click');};
 return {get,find,open,calls,confirmations,exports,sandbox,auth};
}
test('member sees no draft or controls before first publication',async()=>{
 const e=await environment({president:false,published:null,archived:false,revision:1});await e.open();
 assert.ok(e.get('timetable-body').textContent.includes('まだ公開されていません'));assert.equal(e.find('公開'),undefined);assert.equal(e.find('タイムテーブルを生成'),undefined);
});
test('new generation creates four editable slots per band, no transition slots, and preserves teams when adding a break',async()=>{
 const p=sample(),e=await environment({president:true,draft:null,published:null,archived:false,revision:0,people:p.people,roles:[],order:['entry1','entry2'],entries:p.items.filter(r=>r.kind==='performance')});
 await e.open();await e.find('タイムテーブルを生成').emit('click');
 let table=walk(e.get('timetable-body')).find(n=>n.tagName==='tbody');
 assert.equal(walk(table.children[0]).filter(n=>n.tagName==='button').length,4);assert.equal(walk(table.children[2]).filter(n=>n.tagName==='button').length,4);
 assert.equal(walk(table.children[1]).filter(n=>n.tagName==='button').length,1);
 await e.find('休憩に置換').emit('click');await e.find('下書きを保存').emit('click');
 const saved=e.calls.find(c=>c.name==='od_timetable_save').args.p_plan;
 assert.equal(saved.staff_scope,'band');assert.ok(saved.items.filter(r=>r.kind==='performance').every(r=>r.staff.length===4));assert.deepEqual(saved.items[1].staff,[]);
});
test('legacy published versions remain readable and exportable while drafts upgrade independently',async()=>{
 const legacy=sample();delete legacy.staff_scope;legacy.items[1].staff=['me',null,null,null];delete legacy.items[0].staff;delete legacy.items[2].staff;
 const original=copy(legacy),e=await environment({president:true,draft:legacy,published:copy(legacy),archived:false,revision:1,people:legacy.people,roles:[]});
 await e.open();assert.ok(e.get('timetable-message').textContent.includes('旧形式の下書き'));
 await e.find('下書きを保存').emit('click');const saved=e.calls.find(c=>c.name==='od_timetable_save').args.p_plan;
 assert.equal(saved.staff_scope,'band');assert.deepEqual(saved.items[2].staff,['me',null,null,null]);
 await e.find('公開版を見る').emit('click');await e.find('Excel出力').emit('click');assert.deepEqual(e.exports[0].plan,original);
});
test('published and archive tables highlight own performances and duties and expose all exports',async()=>{
 const e=await environment({president:true,published:sample(),draft:sample(),archived:true,revision:1});await e.open();
 const nodes=walk(e.get('timetable-body'));assert.ok(nodes.some(n=>n.className==='tt-own-performance'));assert.ok(nodes.some(n=>n.className==='tt-own-staff'));assert.ok(nodes.some(n=>n.className==='tt-mine'));
 assert.equal(e.find('下書きを保存'),undefined);assert.equal(e.find('係だけを全再生成'),undefined);
 for(const label of ['PDF出力','PNG出力','Excel出力'])await e.find(label).emit('click');assert.deepEqual(e.exports.map(e=>e.format),['pdf','png','excel']);
});
test('president edits start time independently, replaces breaks, and saves draft only',async()=>{
 const p=sample(),e=await environment({president:true,draft:p,published:copy(p),archived:false,revision:1,people:p.people,roles:[]});await e.open();
 const start=walk(e.get('timetable-body')).find(n=>n.tagName==='label'&&n._text==='OD開始').children[0];start.value='11:00';await start.emit('change');
 await e.find('休憩に置換').emit('click');await e.find('下書きを保存').emit('click');
 const call=e.calls.find(c=>c.name==='od_timetable_save');assert.equal(call.args.p_plan.start,660);assert.equal(call.args.p_plan.pa,510);assert.equal(call.args.p_plan.gather,570);assert.equal(call.args.p_publish,false);
 assert.equal(call.args.p_plan.items[1].kind,'break');assert.deepEqual(call.args.p_plan.items[1].staff,[]);
 await e.find('公開版を見る').emit('click');assert.ok(e.get('timetable-body').textContent.includes('OD開始 10:00'));
});
test('regeneration confirms overwrite, preserves times and manual selection warns explicitly',async()=>{
 const p=sample(),e=await environment({president:true,draft:p,published:null,archived:false,revision:1,people:p.people,roles:[]});await e.open();
 await e.find('係だけを全再生成').emit('click');assert.ok(e.confirmations.some(m=>m.includes('手動修正を含む全係割り当て')));
 const slots=walk(e.get('timetable-body')).filter(n=>n.tagName==='button'&&n.textContent==='未割り当て');await slots[0].emit('click');
 const dialog=e.sandbox.document.body.children[0],buttons=walk(dialog).filter(n=>n.tagName==='button');
 const invalid=buttons.find(n=>n.textContent.startsWith('未参加 ⚠'));await invalid.emit('click');assert.ok(e.confirmations.some(m=>m.includes('OD参加未登録')&&m.includes('手動の例外')));
 await e.find('下書きを保存').emit('click');const call=e.calls.find(c=>c.name==='od_timetable_save');assert.equal(call.args.p_plan.start,600);assert.equal(call.args.p_plan.items[0].minutes,15);assert.equal(call.args.p_plan.items[1].minutes,5);assert.equal(call.args.p_allow_exceptions,true);assert.equal(call.args.p_automatic,false);
});
test('XLSX is an OOXML ZIP with literal strings; PDF has valid offsets and multiple pages',async()=>{
 const downloads=[],urls=new Map();let serial=0;const canvas=()=>({width:0,height:0,
  getContext:()=>({fillRect(){},strokeRect(){},fillText(){},measureText:s=>({width:s.length*20})}),
  toDataURL:()=> 'data:image/jpeg;base64,/9j/2Q==',toBlob:fn=>fn(new Blob(['PNG']))});
 const sandbox=vm.createContext({TextEncoder,Uint8Array,DataView,Blob,atob,setTimeout(){},URL:{createObjectURL:b=>{const key=String(++serial);urls.set(key,b);return key;},revokeObjectURL(){}},
  document:{createElement:t=>t==='canvas'?canvas():{click(){downloads.push({name:this.download,blob:urls.get(this.href)});}}}});
 for(const f of ['timetable-core.js','timetable-export.js'])vm.runInContext(await read(f),sandbox);
 const p=sample();p.items[0].name='=1+1 & <バンド>';sandbox.p=p;
 vm.runInContext('TimetableExport.excel(p,"OD")',sandbox);
 const bytes=new Uint8Array(await downloads[0].blob.arrayBuffer()),view=new DataView(bytes.buffer);assert.equal(view.getUint32(0,true),0x04034b50);
 let offset=0;const files={};
 while(view.getUint32(offset,true)===0x04034b50){const length=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true),start=offset+30+nameLength+extra;
  const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameLength));files[name]=new TextDecoder().decode(bytes.slice(start,start+length));offset=start+length;}
 assert.ok(files['xl/worksheets/sheet1.xml'].includes('=1+1 &amp; &lt;バンド&gt;'));assert.ok(!files['xl/worksheets/sheet1.xml'].includes('<f>'));
 const end=bytes.length-22;assert.equal(view.getUint32(end,true),0x06054b50);assert.equal(view.getUint32(end+16,true),offset);assert.equal(view.getUint16(end+10,true),5);
 p.items=Array.from({length:60},(_,i)=>({kind:'performance',name:'バンド'+i,minutes:15,entry:'entry1',staff:[null,null,null,null]}));
 vm.runInContext('TimetableExport.pdf(p,"OD")',sandbox);const pdf=new Uint8Array(await downloads[1].blob.arrayBuffer()),text=new TextDecoder('latin1').decode(pdf);
 assert.ok(text.startsWith('%PDF-1.4'));assert.ok(text.includes('/Count 3'));const xref=Number(text.match(/startxref\n(\d+)/)[1]);assert.equal(text.slice(xref,xref+4),'xref');
 const entries=text.slice(xref).split('\n').slice(3).filter(l=>/^\d{10} 00000 n/.test(l));entries.forEach((entry,i)=>assert.ok(text.slice(Number(entry.slice(0,10))).startsWith(`${i+1} 0 obj`)));
 await vm.runInContext('TimetableExport.png(p,"OD")',sandbox);assert.equal(downloads[2].blob.type,'image/png');
});
