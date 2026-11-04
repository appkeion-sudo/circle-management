import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), C=require('../timetable-core.js');
const person=(id,entries,props={})=>({id,name:id,entries,year:2,registered:true,excluded:false,...props});
function plan(){return {staff_scope:'band',date:'2026-11-10',pa:510,gather:570,start:600,
 people:[person('a',['a']),person('b',['b']),person('c',['c']),person('d',['d']),person('e',['e']),person('f',['e']),person('g',['e']),person('h',['e'])],
 items:['a','b','c','d','e'].flatMap((entry,i)=>[...(i?[{kind:'transition',minutes:5,staff:[]}]:[]),{kind:'performance',name:entry,entry,minutes:15,available:[],staff:[null,null,null,null]}])};}
test('time propagation, independent gathering times, and break replacement',()=>{
 const p=plan();assert.equal(C.rows(p)[2].start,620);p.items[0].minutes=20;assert.equal(C.rows(p)[2].start,625);
 const before=C.rows(p);p.start+=45;
 assert.deepEqual(C.rows(p).map(r=>r.start),before.map(r=>r.start+45));assert.equal(p.pa,510);assert.equal(p.gather,570);
 p.items[1]={kind:'break',minutes:30,staff:[]};assert.equal(C.rows(p)[2].start,p.start+50);assert.deepEqual(p.items[1].staff,[]);
});
test('automatic staff respect every performance, participation, exclusions, uniqueness and freshman pairs',()=>{
 const p=plan();p.people.push(person('no-show',[]),person('unregistered',['e'],{registered:false}),person('president',['e'],{excluded:true}),person('multi',['a','c','e']));
 p.people[4].year=1;p.people[5].year=1;p.people[6].year=1;
 const result=C.allocate(p);
 result.items.forEach((row,i)=>{if(row.kind==='performance'){
  assert.equal(new Set(row.staff.filter(Boolean)).size,row.staff.filter(Boolean).length);
  row.staff.forEach((id,slot)=>{if(id)assert.deepEqual(C.reasons(result.people.find(p=>p.id===id),result,i,slot),[]);});
 }});
 assert.deepEqual(C.rows(result).map(({staff,...r})=>r),C.rows(p).map(({staff,...r})=>r));
 assert.equal(result.start,p.start);assert.deepEqual(p.items[0].staff,[null,null,null,null]);
});
test('shortage remains empty; available warnings and repeated assignments do not block allocation',()=>{
 const p=plan();p.people=[person('only',['e'])];p.items[0].available=[[0,10]];
 const result=C.allocate(p);assert.ok(result.items[0].staff.includes(null));
 assert.ok(C.warnings(result).some(w=>w.includes('未割り当て')));assert.ok(C.warnings(result).some(w=>w.includes('出演可能時間帯外')));
 assert.ok(C.warnings(result).some(w=>w.includes('only')&&w.includes('連続担当')));
});
test('all-freshman candidates leave holes rather than relaxing pair constraints',()=>{
 const p=plan();p.people=Array.from({length:8},(_,i)=>person('f'+i,['e'],{year:1}));const result=C.allocate(p);
 assert.equal(result.items[0].staff.filter(Boolean).length,2);
});
test('two seniors and two freshmen always fill the four feasible slots',()=>{
 const p=plan();p.people=[person('s1',['e']),person('s2',['e']),person('f1',['e'],{year:1}),person('f2',['e'],{year:1})];
 const result=C.allocate(p);assert.ok(result.items[0].staff.every(Boolean));assert.equal(new Set(result.items[0].staff).size,4);
});
test('fairness is by total duties, independent of number of performing bands',()=>{
 const p=plan();p.items=Array.from({length:12},(_,i)=>[
  ...(i?[{kind:'transition',minutes:5,staff:[]}]:[]),{kind:'performance',name:'b'+i,entry:'b'+i,minutes:15,available:[]}
 ]).flat();
 p.people=Array.from({length:8},(_,i)=>person('person'+i,['outside'+i]));
 const result=C.allocate(p),counts=p.people.map(p=>result.items.reduce((n,r)=>n+(r.staff?.includes(p.id)?1:0),0));
 assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
 const before=C.rows(result).map(({start,end})=>({start,end}));assert.deepEqual(C.rows(C.allocate(result)).map(({start,end})=>({start,end})),before);
});
test('manual exceptions report all relevant reasons',()=>{
 const p=plan(),candidate=person('invalid',['a'],{registered:false,excluded:true,year:1});p.people.push(candidate,person('fresh',['c'],{year:1}));
 p.items[0].staff=['invalid','fresh','invalid',null];const reasons=C.reasons(candidate,p,0,0);
 for(const text of ['OD参加未登録','部長・対象外役職','自分の出演中・直前・直後と重複','同じバンドで重複','同じ係が1年生2名'])assert.ok(reasons.includes(text));
});
test('every band including first, last and immediately after a break gets four slots',()=>{
 const p=plan();p.items[3]={kind:'break',minutes:10,staff:[]};const result=C.allocate(p);
 assert.equal(result.staff_scope,'band');
 assert.ok(result.items.filter(r=>r.kind==='performance').every(r=>r.staff.length===4));
 assert.ok(result.items.filter(r=>r.kind!=='performance').every(r=>r.staff.length===0));
 assert.equal(result.items[0].staff.length,4);assert.equal(result.items.at(-1).staff.length,4);assert.equal(result.items[4].staff.length,4);
});
test('all own performances and their neighboring transitions stay protected, breaks carry no duties',()=>{
 const p=plan(),multi=person('multi',['a','e']);p.people.push(multi);
 for(const i of [0,2,6,8])assert.ok(C.reasons(multi,p,i,0).some(r=>r.includes('出演中・直前・直後')));
 assert.ok(!C.reasons(multi,p,4,0).some(r=>r.includes('出演中・直前・直後')));
 p.items[1]={kind:'break',minutes:10,staff:[]};assert.deepEqual(C.reasons(multi,p,2,0),[]);
});
test('legacy draft conversion preserves times and maps each transition to the following band without mutating publication',()=>{
 const legacy=plan();delete legacy.staff_scope;
 legacy.items=legacy.items.map(r=>({...r,staff:r.kind==='transition'?['a','b',null,null]:undefined}));
 const before=structuredClone(legacy),draft=C.bandDraft(legacy);
 assert.equal(C.staffKind(legacy),'transition');assert.equal(C.staffKind(draft),'performance');
 assert.deepEqual(draft.items[0].staff,[null,null,null,null]);assert.deepEqual(draft.items[2].staff,['a','b',null,null]);assert.deepEqual(draft.items[1].staff,[]);
 assert.deepEqual(C.rows(draft).map(({start,end})=>[start,end]),C.rows(legacy).map(({start,end})=>[start,end]));assert.deepEqual(legacy,before);
 assert.deepEqual(C.bandDraft(draft),draft);
});
