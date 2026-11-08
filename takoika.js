"use strict";
const Takoika = (() => {
  if (!db) return;
  const $ = id => document.getElementById('takoika-' + id);
  const pots = [...$('pots').querySelectorAll('button')];
  let generation = 0, player = null, phase = 'closed', score = 0, rows = null;
  let timer, loading = false, settling = false, pending = null, rankingTask = null;
  const active = token => token === generation && player === currentAuthUser?.id && phase !== 'closed';
  const rpc = async (name, args = {}) => {
    const {data, error} = await db.rpc(name, args);
    if (error) throw error;
    return data;
  };
  function resetPots() {
    for (const pot of pots) {
      pot.disabled = false;
      pot.classList.remove('is-shaking', 'is-revealed');
      const img = pot.querySelector('img');
      img.src = 'assets/takoika/pot.png'; img.alt = 'ツボ';
    }
  }
  function renderResult() {
    const mine = rows?.find(r => r.user_id === player);
    $('final').textContent = score + '匹';
    $('best').textContent = rows === null ? '取得できません' : (mine?.best_score || 0) + '匹';
    $('rank').textContent = rows === null ? '取得できません' : mine ? mine.rank + '位' : '未ランクイン';
  }
  function renderRanking() {
    $('ranking-list').replaceChildren();
    for (const row of rows || []) {
      const li = document.createElement('li');
      if (row.user_id === player) li.className = 'is-me';
      for (const text of [row.rank + '位', row.username + (row.user_id === player ? '（あなた）' : ''), row.best_score + '匹']) {
        const span = document.createElement('span'); span.textContent = text; li.append(span);
      }
      $('ranking-list').append(li);
    }
    $('ranking-status').textContent = rows?.length ? rows.length + '人がランクイン' : 'まだ記録はありません。最初のタコをつかまえよう！';
    renderResult();
  }
  function loadRanking(token) {
    if (rankingTask) return rankingTask;
    rankingTask = fetchRanking(token).finally(() => { if (token === generation) rankingTask = null; });
    return rankingTask;
  }
  async function fetchRanking(token) {
    loading = true; $('refresh').disabled = true;
    $('ranking-status').textContent = 'ランキングを読み込み中…';
    try {
      const data = await rpc('takoika_ranking');
      if (!active(token)) return false;
      rows = data; renderRanking(); return true;
    } catch {
      if (active(token)) $('ranking-status').textContent = 'ランキングを取得できませんでした。再読み込みしてください。';
      return false;
    } finally {
      if (active(token)) { loading = false; $('refresh').disabled = false; }
    }
  }
  async function settle() {
    if (settling || phase !== 'ended') return;
    const token = generation;
    settling = true; $('save-retry').hidden = true; $('again').disabled = true; $('refresh').disabled = true;
    $('save-status').textContent = '記録を確認中…';
    try {
      // A failed initial read must never be mistaken for a personal best of zero.
      if (rows === null && !(await loadRanking(token))) throw Error('read');
      if (!active(token)) return;
      const best = rows.find(r => r.user_id === player)?.best_score || 0;
      if (score > best) {
        $('save-status').textContent = '自己ベストを保存中…';
        await rpc('takoika_save_best', {p_score: score});
        if (!active(token)) return;
      }
      // Refresh even for a non-record finish, to reflect other members' scores.
      if (!(await loadRanking(token))) throw Error('refresh');
      if (!active(token)) return;
      pending = null;
      $('save-status').textContent = score > best ? '自己ベストを保存しました！' : '今回の記録を確認しました。';
    } catch {
      if (active(token)) {
        pending = score;
        $('save-status').textContent = '記録の保存・確認が完了していません。再試行できます。再挑戦や画面移動をすると未確認の記録は破棄されます。';
        $('save-retry').hidden = false;
      }
    } finally {
      if (active(token)) {
        settling = false; $('again').disabled = false; $('refresh').disabled = false; renderResult();
      }
    }
  }
  function start() {
    score = 0; pending = null; phase = 'ready';
    $('score').textContent = '0'; $('result').hidden = true;
    $('save-status').textContent = ''; $('save-retry').hidden = true;
    $('cue').textContent = 'ツボをひとつ選んでね'; resetPots();
  }
  function choose(index) {
    if (phase !== 'ready' || !active(generation)) return;
    phase = 'shaking'; const token = generation;
    // Independent 50% draw on each selection, regardless of side.
    const octopus = Math.random() < 0.5;
    pots.forEach(p => { p.disabled = true; });
    const selected = pots[index]; selected.classList.add('is-shaking');
    $('cue').textContent = '何が出るかな…';
    timer = setTimeout(() => {
      if (!active(token)) return;
      selected.classList.remove('is-shaking'); selected.classList.add('is-revealed');
      const img = selected.querySelector('img');
      img.src = 'assets/takoika/' + (octopus ? 'octopus' : 'squid') + '.png';
      img.alt = octopus ? 'タコ' : 'イカ';
      if (octopus) {
        score++; $('score').textContent = score;
        $('cue').textContent = 'タコ！ +1匹';
        timer = setTimeout(() => {
          if (!active(token)) return;
          phase = 'ready'; resetPots(); $('cue').textContent = '次のツボを選んでね';
        }, 650);
      } else {
        phase = 'ended'; $('cue').textContent = 'イカ！ 今回はここまで';
        $('result').hidden = false; renderResult(); void settle();
      }
    }, 280);
  }
  function close() {
    generation++; clearTimeout(timer); phase = 'closed'; player = null;
    score = 0; rows = null; loading = false; settling = false; pending = null; rankingTask = null;
    $('ranking-list').replaceChildren(); $('result').hidden = true;
  }
  document.addEventListener('circle-page-change', e => {
    close();
    if (e.detail !== 'takoika-section' || !currentAuthUser) return;
    player = currentAuthUser.id; start(); void loadRanking(generation);
  });
  document.addEventListener('circle-session-ready', () => {
    if (player && player !== currentAuthUser?.id) close();
  });
  db.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') close(); });
  pots.forEach((pot, i) => { pot.onclick = () => choose(i); });
  $('again').onclick = () => { if (phase === 'ended' && !settling) start(); };
  $('save-retry').onclick = () => { if (pending !== null) void settle(); };
  $('refresh').onclick = () => { if (!loading && !settling) void loadRanking(generation); };
  $('back').onclick = () => showPage('home-section');
})();
