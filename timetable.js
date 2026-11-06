"use strict";
const TimetableUI = (() => {
  const $ = id => document.getElementById(id), C = TimetableCore;
  const el = (tag, text, cls) => {const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e;};
  const rpc = async (name,args={}) => {const {data,error}=await db.rpc(name,args); if(error)throw error; return data;};
  let current, context, plan, viewingPublished=false, version=0, inboxVersion=0, dirty=false, automatic=false;
  const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
  function button(text, fn, cls='secondary-button') {
    const b=el('button',text,cls); b.type='button';
    b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message);}finally{b.disabled=false;}});return b;
  }
  function input(label,type,value,change,props={}) {
    const l=el('label',label),i=el('input');i.type=type;i.value=value;Object.assign(i,props);
    i.addEventListener('change',()=>change(i.value));l.append(i);return l;
  }
  const parseTime = value => {if(!/^\d{1,4}:\d{2}$/.test(value))throw Error('時刻はHH:MMで入力してください');const [h,m]=value.split(':').map(Number);if(m>59)throw Error('分は00〜59で入力してください');return h*60+m;};
  function modified(manual=true){if(manual)automatic=false;dirty=true;render();}
  async function list() {
    if(dirty&&!confirm('保存していない変更を破棄しますか？'))return;
    dirty=false;version++;showPage('timetable-section');$('timetable-body').replaceChildren();$('timetable-message').textContent='読み込み中…';
    const v=version;
    try{
      const {data,error}=await db.from('auditions').select('id,title,created_at').order('created_at',{ascending:false});if(error)throw error;
      if(v!==version)return;
      const root=$('timetable-body');root.append(el('h2','ODタイムテーブル'));
      for(const a of data)root.append(button(a.title,()=>open(a.id,a.title)));
      if(!data.length)root.append(el('p','ODはありません。'));
      $('timetable-message').textContent='';
    }catch(e){if(v===version)$('timetable-message').textContent=e.message;}
  }
  async function open(id,title) {
    const v=++version;current={id,title};showPage('timetable-section');$('timetable-message').textContent='読み込み中…';$('timetable-body').replaceChildren();
    try{
      const data=await rpc('od_timetable_context',{p_audition_id:id});if(v!==version)return;
      context=data;viewingPublished=!data.president||data.archived;plan=structuredClone(viewingPublished?data.published:data.draft);
      const upgrading=plan&&!viewingPublished&&plan.staff_scope!=='band';
      if(plan&&!viewingPublished){plan=C.bandDraft(plan);plan.people=data.people;}
      dirty=!!upgrading;automatic=false;render();$('timetable-message').textContent=upgrading?'旧形式の下書きをバンド単位に変換しました。先頭バンドの空欄を確認するか、係を全再生成して保存してください。':'';
    }catch(e){if(v===version)$('timetable-message').textContent=e.message;}
  }
  async function save(publish=false) {
    const warnings=C.warnings(plan);
    if(warnings.length&&!confirm(`${warnings.join('\n')}\n\n警告を確認し、条件違反は手動の例外として${publish?'公開':'保存'}しますか？`))return;
    if(publish&&!confirm('この下書きを公開し、サイト内通知を送信しますか？'))return;
    await rpc('od_timetable_save',{p_audition_id:current.id,p_plan:plan,p_revision:context.revision||0,p_publish:publish,p_allow_exceptions:warnings.length>0,p_automatic:automatic});
    await open(current.id,current.title);
    if(publish)await loadInbox();
  }
  function render() {
    const root=$('timetable-body');root.replaceChildren();
    root.append(button('← OD一覧',list),el('h2',current.title));
    const editable=context.president&&!context.archived&&!viewingPublished;
    root.append(el('p',context.archived?'過去OD・公開版（編集不可）':viewingPublished?'公開版':`下書き${dirty?'（未保存）':''} / 公開 ${context.publication||0}回`,'tt-status'));
    if(context.president&&!context.archived&&context.published)root.append(button(viewingPublished?'下書きを編集':'公開版を見る',()=>{
      if(dirty&&!confirm('未保存の変更を破棄しますか？'))return;
      viewingPublished=!viewingPublished;plan=structuredClone(viewingPublished?context.published:context.draft);const upgrading=plan&&!viewingPublished&&plan.staff_scope!=='band';if(!viewingPublished&&plan){plan=C.bandDraft(plan);plan.people=context.people;}dirty=!!upgrading;automatic=false;render();
    }));
    if(!plan){
      root.append(el('p','タイムテーブルはまだ公開されていません。'));
      if(editable){
        if(!context.order){root.append(el('p','OD詳細でエントリー締切後に演奏順を確定してください。'));return;}
        let date=today();root.append(input('開催日','date',date,v=>{date=v;}));
        root.append(button('タイムテーブルを生成',()=>{
          const items=[];
          context.order.forEach((id,i)=>{const entry=context.entries.find(e=>e.entry===id);if(!entry)throw Error('確定演奏順が古くなっています。OD詳細で確定し直してください。');if(i)items.push({kind:'transition',minutes:5,staff:[]});items.push({...entry,kind:'performance',minutes:15,staff:[null,null,null,null]});});
          plan=C.allocate({staff_scope:'band',date,pa:510,gather:570,start:600,items,people:context.people});automatic=true;dirty=true;render();
        }));
      }
      return;
    }
    if(editable){
      const fields=el('div',undefined,'tt-fields');
      fields.append(input('開催日','date',plan.date,v=>{plan.date=v;modified();}));
      for(const [key,label] of [['pa','PA集合'],['gather','一般集合'],['start','OD開始']])fields.append(input(label,'time',C.time(plan[key]),v=>{if(v){plan[key]=parseTime(v);modified();}}));
      root.append(fields);
      const actions=el('div',undefined,'tt-actions');
      actions.append(button('下書きを保存',()=>save()),button(context.published?'再公開':'公開',()=>save(true)),button('係だけを全再生成',()=>{
        if(!confirm('手動修正を含む全係割り当てを破棄して再生成します。演奏順と時刻は変わりません。実行しますか？'))return;
        plan=C.allocate(plan);automatic=true;modified(false);
      }));root.append(actions);
    }
    const schedule=C.rows(plan),end=schedule.at(-1)?.end??plan.start;
    root.append(el('p',`${plan.date}　PA集合 ${C.time(plan.pa)}　一般集合 ${C.time(plan.gather)}　OD開始 ${C.time(plan.start)}　終了 ${C.time(end)}`));
    root.append(el('p','青：自分の出演　緑：自分の係。横にスクロールして全列を確認できます。','hint'));
    root.append(el('p',plan.staff_scope==='band'?'各バンドにローディー2名・タイムキーパー2名を配置します。自分の出演や前後の転換と重なる割り当ては避けます。':'旧公開版：係は転換単位で表示しています。','hint'));
    const wrap=el('div',undefined,'tt-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label','ODタイムテーブル');
    const table=el('table',undefined,'tt-table'),head=el('thead'),hr=el('tr'),body=el('tbody');
    for(const label of ['時刻','内容','所要分','ローディー1','ローディー2','タイムキーパー1','タイムキーパー2']){const th=el('th',label);th.scope='col';hr.append(th);}head.append(hr);
    schedule.forEach((r,index)=>{
      const row=el('tr');
      if(r.kind==='performance'&&plan.people.find(p=>p.id===currentAuthUser.id)?.entries.includes(r.entry))row.className='tt-own-performance';
      if(r.kind===C.staffKind(plan)&&r.staff.includes(currentAuthUser.id)&&row.className!=='tt-own-performance')row.className='tt-own-staff';
      row.append(el('td',`${C.time(r.start)}〜${C.time(r.end)}`));
      const label=el('td',r.kind==='performance'?r.name:r.kind==='break'?'休憩':'転換');
      if(editable&&r.kind!=='performance')label.append(button(r.kind==='break'?'休憩を削除（転換5分）':'休憩に置換',()=>{
        plan.items[index]={kind:r.kind==='break'?'transition':'break',minutes:r.kind==='break'?5:10,staff:[]};modified();
      }));row.append(label);
      const duration=el('td');
      if(editable)duration.append(input('分','number',r.minutes,v=>{const n=Number(v);if(!Number.isInteger(n)||n<=0){alert('所要時間は正の整数で入力してください');render();return;}plan.items[index].minutes=n;modified();},{min:1,step:1,required:true}));else duration.textContent=r.minutes;
      row.append(duration);
      for(let slot=0;slot<4;slot++){
        const td=el('td');
        if(r.kind===C.staffKind(plan)){
          const id=r.staff[slot],name=plan.people.find(p=>p.id===id)?.name||'未割り当て';
          if(id===currentAuthUser.id)td.className='tt-mine';
          if(editable)td.append(button(name,()=>pick(index,slot)));else td.textContent=name;
        }else td.textContent='—';row.append(td);
      }
      body.append(row);
    });
    table.append(head,body);wrap.append(table);root.append(wrap);
    if(context.president&&!viewingPublished){
      const warnings=C.warnings(plan);
      // Keep a published snapshot intact while identifying canceled participants to the president.
      if(context.published?.items.some(r=>(r.staff||[]).some(id=>id&&!context.people.find(p=>p.id===id)?.registered)))warnings.push('公開版に現在OD参加未登録の担当者がいます。下書きを確認して再公開してください。');
      if(warnings.length){const box=el('div',undefined,'tt-warnings');box.setAttribute('role','status');box.append(el('h3','確認が必要な項目'));const ul=el('ul');warnings.forEach(w=>ul.append(el('li',w)));box.append(ul);root.append(box);}
    }
    const exports=el('div',undefined,'tt-actions');
    for(const [format,label] of [['pdf','PDF'],['png','PNG'],['excel','Excel']])exports.append(button(`${label}出力`,async()=>{
      if(document.fonts?.ready)await document.fonts.ready;
      await TimetableExport[format](plan,`${current.title}${viewingPublished?'':'（下書き）'}`);
    }));root.append(exports);
    if(editable){
      const settings=el('details');settings.append(el('summary','役職ごとの係対象外設定・参加取消'));
      for(const role of context.roles){const l=el('label',role.name),check=el('input');check.type='checkbox';check.checked=role.excluded;
        check.addEventListener('change',async()=>{check.disabled=true;try{await rpc('od_set_role_exclusion',{p_role_id:role.id,p_excluded:check.checked});context.people=await rpc('od_timetable_people',{p_audition_id:current.id});plan.people=context.people;role.excluded=check.checked;modified();}catch(e){check.checked=!check.checked;alert(e.message);}finally{check.disabled=false;}});l.append(check);settings.append(l);}
      for(const p of context.people.filter(p=>p.registered))settings.append(button(`${p.name}の参加を取り消す`,async()=>{
        if(dirty){alert('先に下書きを保存してください。');return;}
        if(!confirm(`${p.name}の参加を取り消し、下書きの係を空欄にしますか？`))return;
        await rpc('od_timetable_participation',{p_audition_id:current.id,p_user_id:p.id,p_registered:false});await open(current.id,current.title);
      }));root.append(settings);
    }
  }
  function pick(index,slot){
    const dialog=el('dialog',undefined,'tt-picker'),heading=el('h3','担当者を選択'),search=el('input'),results=el('div');
    search.type='search';search.placeholder='名前で検索';search.setAttribute('aria-label','担当者の名前を検索');
    const close=()=>{dialog.close();dialog.remove();};
    const choose=(id,why=[])=>{if(why.length&&!confirm(`${why.join('、')}\n手動の例外として割り当てますか？`))return;plan.items[index].staff[slot]=id;automatic=false;close();modified();};
    const update=()=>{
      results.replaceChildren(button('未割り当てにする',()=>choose(null)));
      plan.people.filter(p=>p.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map(p=>({p,why:C.reasons(p,plan,index,slot)}))
        .sort((a,b)=>Number(a.why.length>0)-Number(b.why.length>0)||a.p.name.localeCompare(b.p.name,'ja'))
        .forEach(({p,why})=>results.append(button(`${p.name}${why.length?' ⚠ '+why.join('、'):'（条件適合）'}`,()=>choose(p.id,why))));
    };
    search.addEventListener('input',update);dialog.append(heading,search,results,button('閉じる',close));dialog.addEventListener('cancel',()=>dialog.remove());document.body.append(dialog);update();dialog.showModal();search.focus();
  }
  async function mountOD(a,entries,root,chief){
    const data=await rpc('od_timetable_context',{p_audition_id:a.id});
    root.append(button('タイムテーブル',()=>{dirty=false;return open(a.id,a.title);}));
    if(!data.archived){
      const registration=el('div',undefined,'audition-card');registration.append(el('h3','OD参加登録'));
      if(!data.registered&&a.status==='open'&&new Date(a.entry_deadline)>new Date())registration.append(button('参加登録する',async()=>{await rpc('od_timetable_participation',{p_audition_id:a.id,p_user_id:currentAuthUser.id,p_registered:true});registration.replaceChildren(el('p','参加登録しました。OD詳細を開き直すと参加を取り消せます。'));}));
      else if(data.registered){registration.append(el('p','参加登録済み'));if(!data.published||chief)registration.append(button('自分の参加登録を取り消す',async()=>{
        if(!confirm('OD参加登録を取り消しますか？'))return;await rpc('od_timetable_participation',{p_audition_id:a.id,p_user_id:currentAuthUser.id,p_registered:false});registration.replaceChildren(el('p','参加を取り消しました。'));
      }));else registration.append(el('p','公開後の参加取消は部長に依頼してください。'));}
      root.append(registration);
    }
    if(!data.has_timetable){
      const available=el('div',undefined,'audition-card');available.append(el('h3','出演可能時間帯の申告'));
      for(const entry of entries.filter(e=>chief||e.can_withdraw))available.append(button(`${entry.band_name}の出演可能時間帯`,async()=>{
        const existing=(data.availability||[]).find(x=>x.entry===entry.id)?.windows||[];
        const raw=prompt('出演可能時間帯を1行ずつ入力（例 10:00-12:00）。空欄は制限なし。',existing.map(w=>w.map(C.time).join('-')).join('\n'));
        if(raw===null)return;
        const windows=raw.trim()?raw.trim().split(/\n/).map(line=>{const pair=line.trim().split(/[-〜～]/);if(pair.length!==2)throw Error('HH:MM-HH:MMの形式で入力してください');const [start,end]=pair.map(s=>parseTime(s.trim()));if(start>=end)throw Error('開始より後の終了時刻を入力してください');return [start,end];}):[];
        await rpc('audition_set_availability',{p_entry_id:entry.id,p_windows:windows});
        data.availability=(data.availability||[]).filter(x=>x.entry!==entry.id);data.availability.push({entry:entry.id,windows});alert('出演可能時間帯を保存しました。');
      }));if(available.children.length>1)root.append(available);
    }
    if(chief&&!data.draft){
      const panel=el('div',undefined,'audition-card');panel.append(el('h3','OD演奏順の確定'),el('p','確定した順序をタイムテーブルで使用します。生成後は変更できません。'));
      const ordered=(data.order||entries.map(e=>e.id)).map(id=>entries.find(e=>e.id===id)).filter(Boolean);
      for(const entry of entries)if(!ordered.some(e=>e.id===entry.id))ordered.push(entry);
      const orderList=el('ol');const draw=()=>{orderList.replaceChildren();ordered.forEach((entry,i)=>{
        const row=el('li',entry.band_name);row.append(button('↑',()=>{if(i){[ordered[i-1],ordered[i]]=[ordered[i],ordered[i-1]];draw();}}),button('↓',()=>{if(i<ordered.length-1){[ordered[i+1],ordered[i]]=[ordered[i],ordered[i+1]];draw();}}));orderList.append(row);
      });};draw();panel.append(orderList,button('この演奏順を確定',async()=>{await rpc('audition_confirm_order',{p_audition_id:a.id,p_entries:ordered.map(e=>e.id)});alert('演奏順を確定しました。タイムテーブルを生成できます。');}));root.append(panel);
    }
  }
  function scheduleText(value){
    if(!value||Array.isArray(value))return 'なし';
    return `${value.date} PA集合 ${C.time(value.pa)} / 一般集合 ${C.time(value.gather)}\n`+(value.schedule.map(s=>`${C.time(s.start)}〜${C.time(s.end)} ${s.role}`).join('\n')||'出演・係なし');
  }
  async function loadInbox(){
    const v=++inboxVersion,target=$('timetable-inbox');if(!target)return;const user=currentAuthUser?.id;if(!user){target.replaceChildren();return;}
    try{const messages=await rpc('od_timetable_inbox');if(currentAuthUser?.id!==user||v!==inboxVersion)return;target.replaceChildren();
      if(messages.length){const details=el('details');details.append(el('summary',`タイムテーブルのお知らせ（${messages.length}件）`));for(const m of messages){const card=el('div',undefined,'audition-card');card.append(el('strong',m.title),el('p',`${new Date(m.created_at).toLocaleString('ja-JP')} ${m.message}`),el('pre',`変更前：${scheduleText(m.before_schedule)}\n変更後：${scheduleText(m.after_schedule)}`),button('公開版を開く',async()=>{if(dirty&&!confirm('未保存の変更を破棄しますか？'))return;await open(m.audition_id,m.title);if(context.president&&!viewingPublished){viewingPublished=true;plan=structuredClone(context.published);render();}}));details.append(card);}target.append(details);}
    }catch(e){if(currentAuthUser?.id===user&&v===inboxVersion)target.textContent=`通知を取得できません：${e.message}`;}
  }
  $('open-timetable-button').addEventListener('click',list);
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){version++;inboxVersion++;plan=null;context=null;dirty=false;$('timetable-body').replaceChildren();$('timetable-inbox').replaceChildren();}else if(event==='SIGNED_IN'||event==='INITIAL_SESSION')setTimeout(loadInbox,0);});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadInbox();});
  document.addEventListener('circle-session-ready',loadInbox);
  if(currentAuthUser)setTimeout(loadInbox,0);
  return {mountOD};
})();
