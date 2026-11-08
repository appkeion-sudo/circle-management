"use strict";
(() => {
 if (!db) return;
 const $ = id => document.getElementById(id);
 const mk = (tag, text, cls) => {const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const add = (parent,...children) => {parent.append(...children);return parent;};
 const msg = (id,t) => {$(id).textContent=t||"";};
 const fmt = s => s ? new Date(s).toLocaleString('ja-JP') : '未設定';
 const statusText = {draft:'下書き',open:'エントリー受付中',scoring:'採点中',closed:'採点終了',published:'結果公開'};
 let president=false, canDelete=false, current=null, criteria=[], scoreVersion=0;
 const rpc=async (name,args={})=>{const {data,error}=await db.rpc(name,args);if(error)throw error;return data;};
 const select=async (table,cols='*')=>{const {data,error}=await db.from(table).select(cols);if(error)throw error;return data;};
 async function checkPresident(){president=false;canDelete=false;president=await rpc('is_circle_president')===true;canDelete=await rpc('audition_can_delete')===true;return president;}
 function field(label,type,value='',props={}){const l=mk('label',label),i=mk(type==='textarea'?'textarea':'input');if(type!=='textarea')i.type=type;i.value=value;Object.assign(i,props);l.append(i);return [l,i];}
 function btn(text,fn,cls=''){const b=mk('button',text,cls);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message);}finally{b.disabled=false;}});return b;}
 function go(id){showPage(id);}
 async function deleteAudition(a){
  if(!canDelete)return;
  if(!confirm(`「${a.title}」と関連するエントリー・採点・感想・結果・タイムテーブルを削除します。元に戻せません。削除しますか？`))return;
  await rpc('audition_delete',{p_audition_id:a.id});
  await openList();
 }
 $('open-audition-button').addEventListener('click',()=>openList());
 $('open-feedback-button').addEventListener('click',()=>openFeedback());
 for(const [id,page] of [['audition-back-list','audition-section'],['feedback-back-list','feedback-section']]) $(id).addEventListener('click',()=>page==='audition-section'?openList():page==='feedback-section'?openFeedback():go(page));
 $('audition-new').addEventListener('click',()=>openCreate());
 async function openList(){go('audition-section');msg('audition-message','読み込み中...');$('audition-list').replaceChildren();try{
  await checkPresident();$('audition-new').hidden=!president;
  const a=await select('auditions','id,title,status,entry_deadline,created_at');a.sort((x,y)=>y.created_at.localeCompare(x.created_at));
  for(const x of a){const card=mk('div',undefined,'audition-card');add(card,mk('h3',x.title),mk('p',`${statusText[x.status]||x.status} / エントリー締切：${fmt(x.entry_deadline)}`),btn('詳細を見る',()=>openDetail(x.id)));if(canDelete)card.append(btn('削除',()=>deleteAudition(x),'danger-button'));$('audition-list').append(card);}
  msg('audition-message',a.length?'':'オーディションはありません。');
 }catch(e){msg('audition-message',e.message);}}
 async function openCreate(){if(!president)return;go('audition-create-section');$('audition-form').reset();$('audition-criteria').replaceChildren();addCriterion('演奏点',10,1);addCriterion('表現点',5,0.6);msg('audition-create-message','');const prev=$('audition-previous-live');prev.replaceChildren();const none=mk('option','指定なし');none.value='';prev.append(none);try{const all=await select('auditions','id,title,status');for(const a of all.filter(a=>a.status==='published')){const o=mk('option',a.title);o.value=a.id;prev.append(o);}}catch(e){msg('audition-create-message',e.message);}}
 function addCriterion(name='',max=10,weight=1){const c=mk('div',undefined,'audition-criterion-row');const [n,ni]=field('採点項目名','text',name,{required:true,maxLength:100});const [m,mi]=field('満点','number',max,{required:true,min:'1',step:'1'});const [w,wi]=field('圧縮率','number',weight,{required:true,min:'0',step:'0.0001'});add(c,n,m,w,btn('削除',()=>c.remove(),'secondary-button'));c._fields={ni,mi,wi};$('audition-criteria').append(c);}
 $('audition-add-criterion').addEventListener('click',()=>addCriterion());
 $('audition-form').addEventListener('submit',async ev=>{ev.preventDefault();const b=$('audition-submit');b.disabled=true;msg('audition-create-message','保存中...');try{
  const rows=[...$('audition-criteria').children];if(!rows.length)throw Error('採点項目を追加してください');
  const cs=rows.map(r=>({name:r._fields.ni.value.trim(),max_score:Number(r._fields.mi.value),weight:Number(r._fields.wi.value)}));
  if(cs.some(c=>!c.name||!Number.isInteger(c.max_score)||c.max_score<=0||!Number.isFinite(c.weight)||c.weight<0))throw Error('採点項目の入力を確認してください');
  const start=$('audition-entry').value;if(!start)throw Error('エントリー締切を入力してください');
  const id=await rpc('audition_create_with_previous',{p_title:$('audition-title').value.trim(),p_description:$('audition-description').value,p_entry_deadline:new Date(start).toISOString(),p_scoring_deadline:null,p_general_slots:Number($('audition-general').value),p_freshman_slots:Number($('audition-freshman').value),p_criteria:cs,p_previous_live_id:$('audition-previous-live').value||null});await openDetail(id);
 }catch(e){msg('audition-create-message',e.message);}finally{b.disabled=false;}});
 async function openDetail(id){current=id;go('audition-detail-section');msg('audition-detail-message','読み込み中...');$('audition-detail').replaceChildren();try{
  await checkPresident();const {data:a,error}=await db.from('auditions').select('*').eq('id',id).single();if(error)throw error;
  const {data:cs,error:ce}=await db.from('audition_criteria').select('*').eq('audition_id',id).order('sort_order');if(ce)throw ce;criteria=cs;
  const es=await rpc('audition_entries_view',{p_audition_id:id});
  const root=$('audition-detail');add(root,mk('h2',a.title),mk('p',statusText[a.status]),mk('p',a.description||''),mk('p',`エントリー締切：${fmt(a.entry_deadline)}`),mk('p',`一般枠 ${a.general_slots} / 1年生枠 ${a.freshman_slots}`),mk('p',a.previous_live_audition_id?'前回ライブの出演バンドIDはエントリー禁止':'前回ライブ：未指定'),mk('h3','採点項目'));
  if(typeof TimetableUI!=='undefined')await TimetableUI.mountOD(a,es,root,president);
  cs.forEach(c=>root.append(mk('p',`${c.name}：${c.max_score}点 × ${c.weight}`)));
  if(president){const actions=mk('div');const next={draft:['open','エントリー受付を開始'],open:['scoring','採点を開始'],scoring:['closed','採点を終了'],closed:['published','結果を公開']};if(next[a.status])actions.append(btn(next[a.status][1],async()=>{if(!confirm(`${next[a.status][1]}しますか？`))return;await rpc('audition_change_status',{p_audition_id:id,p_status:next[a.status][0]});await openDetail(id);}));if(a.status==='closed'){actions.prepend(btn('結果を集計・再集計',async()=>{await rpc('audition_finalize',{p_audition_id:id});await openDetail(id);}));actions.prepend(btn('無効票を選択',()=>openInvalidVotes(id)));} root.append(actions);}
  if(canDelete)root.append(btn('このオーディションを削除',()=>deleteAudition(a),'danger-button'));
  if(a.status==='open'){
   root.append(mk('h3','バンドエントリー'));

   const {data:members,error:me}=await db.from('band_members').select('band_id,bands(name)').eq('user_id',currentAuthUser.id);if(me)throw me;
   for(const m of members){root.append(btn(`「${m.bands?.name||m.band_id}」をエントリー`,async()=>{await rpc('audition_enter',{p_audition_id:id,p_band_id:m.band_id});await openDetail(id);} ,'secondary-button'));}
  }
  root.append(mk('h3','エントリーバンド'));
  if(!es.length)root.append(mk('p','まだエントリーがありません。'));
  for(const e of es){
   const card=mk('div',undefined,'audition-card');
   add(card,mk('strong',e.band_name),mk('p',e.is_freshman_band?'1年生バンド':'一般バンド'));
   if(a.status==='open' && new Date(a.entry_deadline).getTime()>Date.now()){
    if(e.can_withdraw)card.append(btn('このバンドのエントリーを取り消す',async()=>{
     if(!confirm('このバンドのエントリーを取り消しますか？'))return;
     await rpc('audition_withdraw',{p_entry_id:e.id});
     await openDetail(id);
    },'danger-button'));
   }
   if(a.status==='scoring' && e.can_score)card.append(btn('採点・感想を入力',()=>openScore(e,cs)));
   root.append(card);
  }
  if(president && a.status==='published'){
   const performed=await rpc('audition_performed_list',{p_audition_id:id});
   const selected=new Set(performed.map(x=>x.band_id));
   const panel=mk('div',undefined,'audition-card');panel.append(mk('h3','このライブの実際の出演バンド'),mk('p','出演したバンドにチェックを付けてください。次回ライブのエントリー制限に使います。'));
   for(const e of es){const label=mk('label');const check=mk('input');check.type='checkbox';check.checked=selected.has(e.band_id);check.addEventListener('change',async()=>{check.disabled=true;try{await rpc('audition_set_performed',{p_audition_id:id,p_band_id:e.band_id,p_performed:check.checked});}catch(err){check.checked=!check.checked;alert(err.message);}finally{check.disabled=false;}});label.append(check,document.createTextNode(` ${e.band_name}`));panel.append(label);}
   root.append(panel);
  }
  if(a.status==='closed'||a.status==='published')await showResults(root,id,a.status==='closed'&&president);
  msg('audition-detail-message','');
 }catch(e){msg('audition-detail-message',e.message);}}
 async function openScore(entry,cs){
  const version=++scoreVersion;
  go('audition-score-section');$('audition-score-title').textContent=entry.band_name;
  $('audition-score-fields').replaceChildren();$('audition-score-comment').value='';
  $('audition-score-form').onsubmit=ev=>ev.preventDefault();
  $('audition-score-submit').disabled=true;msg('audition-score-message','保存済みの採点を読み込み中...');
  try{
   const saved=await rpc('audition_my_review',{p_entry_id:entry.id});
   if(version!==scoreVersion)return;
   for(const c of cs){const [l,i]=field(`${c.name}（0〜${c.max_score}点・整数）`,'number',saved.scores?.[c.id]??'',{required:true,min:'0',max:String(c.max_score),step:'1'});i.dataset.criterion=c.id;$('audition-score-fields').append(l);}
   $('audition-score-comment').value=saved.comment||'';msg('audition-score-message','');
   $('audition-score-form').onsubmit=async ev=>{ev.preventDefault();const b=$('audition-score-submit');b.disabled=true;try{const scores={};for(const i of $('audition-score-fields').querySelectorAll('input'))scores[i.dataset.criterion]=Number(i.value);await rpc('audition_save_review',{p_entry_id:entry.id,p_scores:scores,p_comment:$('audition-score-comment').value});if(version!==scoreVersion)return;alert('採点と感想を保存しました');await openDetail(current);}catch(e){if(version===scoreVersion)msg('audition-score-message',e.message);}finally{if(version===scoreVersion)b.disabled=false;}};
   $('audition-score-submit').disabled=false;
  }catch(e){if(version===scoreVersion)msg('audition-score-message',e.message);}
 }
 $('audition-score-back').addEventListener('click',()=>{scoreVersion++;return openDetail(current);});
 async function showResults(root,id,editable){const results=await rpc('audition_results_view',{p_audition_id:id});root.append(mk('h3','集計結果'));if(!results.length){root.append(mk('p','未集計です。'));return;}for(const r of results){const card=mk('div',undefined,'audition-card');add(card,mk('strong',`${r.overall_rank}位 ${r.band_name}：${r.total_score}点`),mk('p',`有効票：${r.valid_votes} / 判定：${r.passed===null?'未判定':r.passed?(r.result_category==='freshman'?'1年生枠合格':'一般枠合格'):'不合格'}`));if(editable){const choose=mk('select');for(const [v,t] of [['','未判定'],['general','一般枠合格'],['freshman','1年生枠合格'],['fail','不合格']]){const o=mk('option',t);o.value=v;choose.append(o);}choose.value=r.passed===null?'':r.passed?r.result_category:'fail';card.append(choose,btn('判定を保存',async()=>{if(!choose.value)throw Error('判定を選んでください');await rpc('audition_set_pass',{p_entry_id:r.entry_id,p_passed:choose.value!=='fail',p_category:choose.value==='fail'?null:choose.value});await openDetail(id);}));}root.append(card);}}
 async function openInvalidVotes(id){
  const root=$('audition-detail');const old=$('audition-invalid-panel');if(old)old.remove();
  const panel=mk('div',undefined,'audition-card');panel.id='audition-invalid-panel';panel.append(mk('h3','無効票の選択'),mk('p','チェックした採点者の票を集計から除外します。保存後に再集計してください。'));
  const judges=await rpc('audition_judges',{p_audition_id:id});
  if(!judges.length)panel.append(mk('p','採点者はまだいません。'));
  for(const j of judges){const label=mk('label'),check=mk('input');check.type='checkbox';check.checked=j.is_invalid;check.addEventListener('change',async()=>{check.disabled=true;try{await rpc('audition_set_invalid_vote',{p_audition_id:id,p_judge_id:j.judge_id,p_invalid:check.checked});}catch(e){check.checked=!check.checked;alert(e.message);}finally{check.disabled=false;}});label.append(check,document.createTextNode(` ${j.username}（${j.completed}/${j.required}項目入力）`));panel.append(label,mk('br'));}
  panel.append(btn('無効票を反映して再集計',async()=>{await rpc('audition_finalize',{p_audition_id:id});await openDetail(id);}));root.prepend(panel);
 }
 async function openFeedback(){go('feedback-section');msg('feedback-message','読み込み中...');$('feedback-list').replaceChildren();try{const rows=await rpc('audition_feedback_list');for(const r of rows){$('feedback-list').append(btn(`${r.audition_title} / ${r.band_name}`,()=>openFeedbackDetail(r)));}msg('feedback-message',rows.length?'':'公開された感想はありません。');}catch(e){msg('feedback-message',e.message);}}
 async function openFeedbackDetail(r){go('feedback-detail-section');$('feedback-title').textContent=`${r.audition_title} / ${r.band_name}`;$('feedback-comments').replaceChildren();msg('feedback-detail-message','読み込み中...');try{const comments=await rpc('audition_feedback',{p_entry_id:r.entry_id});for(const c of comments){$('feedback-comments').append(mk('div',c.comment,'audition-card'));}msg('feedback-detail-message',comments.length?'':'感想はまだありません。');}catch(e){msg('feedback-detail-message',e.message);}}
 db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){scoreVersion++;president=false;canDelete=false;current=null;criteria=[];$('audition-score-fields').replaceChildren();$('audition-score-comment').value='';$('audition-score-form').onsubmit=ev=>ev.preventDefault();$('audition-score-submit').disabled=true;}});
})();
