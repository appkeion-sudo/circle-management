"use strict";
(() => {
  if (!db) return;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  let version = 0, offset = 0, total = 0, dialog, timer;
  const allowed = () => !!currentAuthUser && currentProfileContext?.is_site_admin === true;
  function clear() {
    version++; clearTimeout(timer);
    if (dialog) { dialog.close(); dialog = null; }
    $('users-list').replaceChildren(); $('users-search').value = '';
    $('users-message').textContent = ''; offset = total = 0;
    $('open-user-management').hidden = !allowed();
  }
  async function api(path, options = {}) {
    const actor = currentAuthUser?.id;
    const {data, error} = await db.auth.getSession();
    if (!actor || currentAuthUser?.id !== actor || error || !data.session?.access_token) throw Error('ログインし直してください。');
    const response = await fetch('/api/admin/users' + path, {
      ...options, headers:{Authorization:`Bearer ${data.session.access_token}`, 'Content-Type':'application/json'},
      credentials:'same-origin', cache:'no-store'
    });
    let result;
    try { result = await response.json(); } catch { throw Error('ユーザ管理APIを利用できません。サーバ設定を確認してください。'); }
    if (!response.ok) throw Error((result.error || '処理に失敗しました。') + (result.requestId ? `（問い合わせID：${result.requestId}）` : ''));
    return result.data;
  }
  async function load(success = '') {
    if (!allowed()) { clear(); return; }
    const requestVersion = ++version, actor = currentAuthUser.id;
    $('users-list').replaceChildren(); $('users-message').textContent = success || '読み込み中...';
    $('users-prev').disabled = $('users-next').disabled = true;
    try {
      const result = await api(`?q=${encodeURIComponent($('users-search').value.trim())}&offset=${offset}`);
      if (version !== requestVersion || currentAuthUser?.id !== actor) return;
      total = result.total;
      if (offset > 0 && offset >= total) { offset = Math.max(0, Math.floor((total - 1) / 100) * 100); return load(success); }
      $('users-message').textContent = `${success ? success + ' ' : ''}${total}件${total ? `（${offset + 1}〜${offset + result.users.length}件）` : ''}`;
      for (const user of result.users) {
        const card = el('article', undefined, 'admin-card user-management-card');
        const roles = [...user.roles];
        if (user.is_site_admin) roles.unshift('サイト管理者');
        if (user.is_president) roles.unshift('部長');
        card.append(el('h3', user.username), el('p', user.email || 'メールアドレス未設定'),
          el('p', `入学年度：${user.admission_year ?? '未登録'}`), el('p', `役職：${roles.join('・') || 'なし'}`));
        const remove = el('button', user.id === actor ? '自分自身は削除できません' : '削除', 'danger-button');
        remove.type = 'button'; remove.disabled = user.id === actor;
        remove.addEventListener('click', () => confirmDelete(user)); card.append(remove); $('users-list').append(card);
      }
      $('users-prev').disabled = offset === 0; $('users-next').disabled = offset + 100 >= total;
    } catch (error) {
      if (version === requestVersion && currentAuthUser?.id === actor) $('users-message').textContent = (success ? success + ' 一覧の再取得に失敗しました：' : '') + error.message;
    }
  }
  function confirmDelete(user) {
    if (!allowed() || user.id === currentAuthUser.id || dialog) return;
    const actor = currentAuthUser.id, operation = crypto.randomUUID();
    const d = el('dialog', undefined, 'circle-modal user-delete-modal'); dialog = d;
    d.setAttribute('aria-labelledby','user-delete-title');
    const title = el('h2','このユーザを完全に削除しますか？'); title.id = 'user-delete-title';
    const label = el('label','最終確認：「削除」と入力してください。'), input = el('input');
    input.autocomplete = 'off'; input.maxLength = 2; label.append(input);
    const status = el('p'); status.setAttribute('role','status');
    const cancel = el('button','キャンセル','secondary-button'), remove = el('button','完全削除','danger-button');
    cancel.type = remove.type = 'button'; remove.disabled = true;
    let busy = false;
    input.addEventListener('input',()=>{remove.disabled = busy || input.value !== '削除';});
    cancel.addEventListener('click',()=>d.close());
    d.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    d.addEventListener('close',()=>{d.remove();if(dialog===d)dialog=null;});
    remove.addEventListener('click',async()=>{
      if (busy || input.value !== '削除' || !allowed() || currentAuthUser.id !== actor) return;
      busy = true; remove.disabled = cancel.disabled = input.disabled = true;
      status.textContent = '削除中...';
      try {
        await api('/' + encodeURIComponent(user.id), {method:'DELETE', body:JSON.stringify({confirmation:input.value,operation_id:operation})});
        if (currentAuthUser?.id !== actor || dialog !== d) return;
        d.close(); document.dispatchEvent(new Event('circle-users-changed'));
        await load('ユーザを削除しました');
      } catch (error) {
        if (currentAuthUser?.id === actor && dialog === d) status.textContent = error.message + ' 通信結果が不明な場合は、一覧を再読み込みして確認できます。同じ画面からの再試行は重複実行されません。';
      } finally {
        busy = false; cancel.disabled = input.disabled = false; remove.disabled = input.value !== '削除';
      }
    });
    d.append(title,el('p',user.username),el('p',user.email || 'メールアドレス未設定'),
      el('p','削除すると元に戻せません。本人の予定・所属・役職なども削除されます。バンドや公開済み結果は保持され、係の担当は未割り当てになります。','user-delete-warning'),label,status,cancel,remove);
    document.body.append(d); d.showModal(); input.focus();
  }
  $('open-user-management').addEventListener('click',async()=>{
    const actor = currentAuthUser?.id;
    try {
      const {data,error} = await db.rpc('profile_context'); if(error)throw error;
      if (!actor || currentAuthUser?.id !== actor) return;
      currentProfileContext = data;
      if (!allowed()) { clear(); return; }
      showPage('user-management-section'); offset = 0; await load();
    } catch (error) { $('admin-message').textContent = error.message; }
  });
  $('users-back').addEventListener('click',()=>{clear();$('open-admin-button').click();});
  $('users-search-form').addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);offset=0;void load();});
  $('users-search').addEventListener('input',()=>{clearTimeout(timer);version++;timer=setTimeout(()=>{offset=0;void load();},300);});
  $('users-prev').addEventListener('click',()=>{offset=Math.max(0,offset-100);void load();});
  $('users-next').addEventListener('click',()=>{offset+=100;void load();});
  document.addEventListener('circle-session-ready',()=>{if(!allowed())clear();else $('open-user-management').hidden=false;});
  document.addEventListener('circle-page-change',event=>{
    $('open-user-management').hidden=!allowed();
    if(event.detail !== 'user-management-section')clear();
  });
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){clear();$('open-user-management').hidden=true;}});
  clear();
})();
