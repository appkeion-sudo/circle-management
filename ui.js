"use strict";
const CircleUI = (() => {
  if (!db) return;
  const $ = id => document.getElementById(id);
  const el = (tag,text,cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
  const rpc = async (name,args={}) => {const {data,error}=await db.rpc(name,args);if(error)throw error;return data;};
  const button = (text,fn) => {const b=el('button',text,'secondary-button');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message);}finally{b.disabled=false;}};return b;};
  function modal(title,content) {
    const d=el('dialog',undefined,'circle-modal');d.append(el('h2',title),content,button('閉じる',()=>d.close()));
    d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();return d;
  }
  const sidebar=$('sidebar'),toggle=$('sidebar-toggle');
  function drawer(open){sidebar.classList.toggle('is-open',open);$('sidebar-backdrop').hidden=!open;toggle.setAttribute('aria-expanded',String(open));}
  toggle.onclick=()=>drawer(!sidebar.classList.contains('is-open'));
  $('sidebar-backdrop').onclick=()=>drawer(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')drawer(false);});
  let touch;
  document.addEventListener('touchstart',e=>{touch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:true});
  document.addEventListener('touchend',e=>{if(!touch)return;const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;if(Math.abs(dx)>70&&Math.abs(dy)<60){if(touch.x<28&&dx>0)drawer(true);if(dx<0)drawer(false);}touch=null;},{passive:true});
  function settings() {
    const box=el('div');
    box.append(button('メンバー・役職管理',()=>$('open-admin-button').click()),button('ログアウト',()=>$('logout-button').click()),button('タコイカゲーム',()=>{dialog.close();showPage('takoika-section');}));
    box.firstChild.hidden=!isAdmin(currentProfileContext);
    const dialog=modal('設定',box);
  }
  const links=[['ホーム',[['⌂ ホーム',()=>showPage('home-section')]]],['スケジュール',[['◷ MY','open-schedule-button'],['♫ BAND','open-band-button']]],['イベント',[['★ オーディション','open-audition-button'],['▦ タイムテーブル','open-timetable-button']]],['アカウント',[['☺ プロフィール','open-profile-button'],['⚙ 設定',settings]]]];
  for(const [group,items] of links){sidebar.append(el('h3',group));for(const [label,target] of items)sidebar.append(button(label,()=>{drawer(false);typeof target==='function'?target():$(target).click();}));}
  let dashboardVersion=0;
  function auth(){const signed=!!currentAuthUser;$('app-header').hidden=!signed;sidebar.hidden=!signed;document.body.classList.toggle('signed-in',signed);if(!signed){dashboardVersion++;drawer(false);CircleSave.clear();document.querySelectorAll('.circle-modal').forEach(d=>d.close());$('dashboard-notices').replaceChildren();$('dashboard-next').textContent='';$('dashboard-deadlines').replaceChildren();$('notice-manage').hidden=true;$('notification-count').textContent='0';}}
  async function dashboard(){
    auth();if(!currentAuthUser)return;const user=currentAuthUser.id,version=++dashboardVersion;
    try{
      const data=await rpc('ui_dashboard');if(currentAuthUser?.id!==user||version!==dashboardVersion)return;
      const next=data.events[0];$('dashboard-next').textContent=next?`${next.title} · ${next.event_date||'開催日未設定'}`:'次回の予定はありません';
      $('dashboard-deadlines').replaceChildren();for(const a of data.events){for(const [key,label] of [['entry_deadline','エントリー'],['scoring_deadline','採点']])if(a[key])$('dashboard-deadlines').append(el('p',`${a.title} ${label}：${new Date(a[key]).toLocaleString('ja-JP')}`));}
      const notices=$('dashboard-notices');notices.replaceChildren();for(const n of data.notices.slice(0,3))notices.append(button(`${n.title} · ${new Date(n.created_at).toLocaleDateString('ja-JP')}`,()=>modal(n.title,el('p',n.body,'notice-body'))));if(!data.notices.length)notices.append(el('p','お知らせはありません。'));
      $('notice-manage').hidden=!data.can_post;$('notification-count').textContent=data.unread;
    }catch(e){if(currentAuthUser?.id===user&&version===dashboardVersion){$('dashboard-notices').replaceChildren(el('p',`読み込み失敗：${e.message}`),button('再読み込み',dashboard));}}
  }
  async function notices(){
    const user=currentAuthUser?.id,data=await rpc('ui_dashboard'),root=el('div');if(!user||currentAuthUser?.id!==user)return;
    if(data.can_post)root.append(button('＋ お知らせを作成',()=>editNotice()));
    for(const n of data.notices){const card=el('article',undefined,'audition-card');card.append(button(n.title,()=>modal(n.title,el('p',n.body,'notice-body'))));if(data.can_post)card.append(button('編集',()=>editNotice(n)),button('削除',async()=>{if(!confirm(`「${n.title}」を削除しますか？`))return;await rpc('ui_notice_delete',{p_id:n.id});card.remove();await dashboard();}));root.append(card);}if(!data.notices.length)root.append(el('p','お知らせはありません。'));modal('お知らせ一覧・管理',root);
  }
  function editNotice(n={}){
    const noticeId=n.id||crypto.randomUUID();
    const f=el('form'),title=el('input'),body=el('textarea'),submit=el('button','保存'),status=el('p');title.value=n.title||'';title.required=true;title.maxLength=100;title.setAttribute('aria-label','タイトル');body.value=n.body||'';body.required=true;body.maxLength=10000;body.rows=10;body.setAttribute('aria-label','本文');status.setAttribute('role','status');f.append(title,body,submit,status);const d=modal(n.id?'お知らせを編集':'お知らせを作成',f);
    f.onsubmit=async e=>{e.preventDefault();if(submit.disabled)return;submit.disabled=true;try{await rpc('ui_notice_save',{p_id:noticeId,p_title:title.value,p_body:body.value});d.close();await dashboard();}catch(err){status.textContent=err.message;}finally{submit.disabled=false;}};
  }
  const openNotices=()=>notices().catch(e=>alert(e.message));
  $('notice-all').onclick=openNotices;$('notice-manage').onclick=openNotices;
  $('notification-bell').onclick=async()=>{
    const user=currentAuthUser?.id;
    try{const rows=await rpc('ui_notifications'),root=el('div');if(!user||currentAuthUser?.id!==user)return;if(!rows.length)root.append(el('p','通知はありません。'));for(const n of rows)root.append(el('article',`${n.read_at?'':'● '}${n.title}\n${n.body}`,'notice-body audition-card'));modal('通知',root);await rpc('ui_notifications_read',{p_ids:rows.map(n=>n.id)});await dashboard();}catch(e){if(currentAuthUser?.id===user)alert(e.message);}
  };
  document.addEventListener('circle-session-ready',dashboard);
  document.addEventListener('circle-page-change',e=>{if(e.detail==='home-section')void dashboard();});
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')setTimeout(auth,0);});
  auth();
  if(currentAuthUser)void dashboard();
  return {modal,el,button,dashboard,rpc};
})();
