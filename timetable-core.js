"use strict";
// Shared, dependency-free scheduling and allocation rules.
const TimetableCore = (() => {
  const staffKind = plan => plan.staff_scope === 'band' ? 'performance' : 'transition';
  function bandDraft(plan) {
    const result = structuredClone(plan);
    if (result.staff_scope === 'band') return result;
    // Upgrade only the editable draft. A transition's team follows the next band;
    // the first band has no predecessor and starts with four empty slots.
    result.items = result.items.map((item, i) => ({...item, staff: item.kind === 'performance'
      ? [...(plan.items[i - 1]?.kind === 'transition' ? plan.items[i - 1].staff : [null,null,null,null])]
      : []}));
    result.staff_scope = 'band';
    return result;
  }
  function rows(plan) {
    let minute = plan.start;
    return plan.items.map(item => {
      const row = {...item, start: minute, end: minute + item.minutes};
      minute = row.end;
      return row;
    });
  }
  const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  function reasons(person, plan, index, slot) {
    const item = plan.items[index], out = [];
    if (!person.registered) out.push('OD参加未登録');
    if (!person.entries.length) out.push('出演バンドなし');
    if (person.excluded) out.push('部長・対象外役職');
    const conflicts = plan.staff_scope === 'band'
      ? [item.entry, plan.items[index-1]?.kind === 'transition' ? plan.items[index-2]?.entry : null,
        plan.items[index+1]?.kind === 'transition' ? plan.items[index+2]?.entry : null]
      : [plan.items[index-1]?.entry, plan.items[index+1]?.entry];
    if (conflicts.some(id => id && person.entries.includes(id))) out.push('自分の出演中・直前・直後と重複');
    if (item.staff.some((id, i) => i !== slot && id === person.id)) out.push(plan.staff_scope === 'band' ? '同じバンドで重複' : '同じ転換で重複');
    const partner = item.staff[slot ^ 1];
    if (person.year === 1 && plan.people.find(p => p.id === partner)?.year === 1) out.push('同じ係が1年生2名');
    return out;
  }
  function warnings(plan) {
    const out = [], scheduled = rows(plan);
    scheduled.forEach((row, i) => {
      if (row.kind === 'performance') {
        if (row.available?.length && !row.available.some(([a,b]) => a <= row.start && row.end <= b)) out.push(`${row.name} ${time(row.start)}〜${time(row.end)}：出演可能時間帯外`);
      }
      if (row.kind === staffKind(plan)) {
        const label = `${row.name || '転換'} ${time(row.start)}`;
        row.staff.forEach((id, slot) => {
          const person = plan.people.find(p => p.id === id);
          if (!person) out.push(`${label} ${slot < 2 ? 'ローディー' : 'タイムキーパー'}${slot % 2 + 1}：未割り当て`);
          else {
            const violations = reasons(person, plan, i, slot);
            if (violations.length) out.push(`${label} ${person.name}：${violations.join('、')}`);
            const prev = scheduled.slice(0, i).reverse().find(r => r.kind === staffKind(plan) || r.kind === 'break');
            if (prev?.kind === staffKind(plan) && prev.staff.includes(id)) out.push(`${person.name}：${prev.name || '転換'} ${time(prev.start)}・${label} 連続担当`);
          }
        });
      }
    });
    return [...new Set(out)];
  }
  function allocate(plan, random = Math.random) {
    plan = bandDraft(plan);
    // Multiple feasible greedy passes. Maximize filled slots before fairness and adjacency.
    let best, bestScore;
    for (let pass = 0; pass < 80; pass++) {
      const trial = structuredClone(plan), counts = new Map(plan.people.map(p => [p.id, 0]));
      let previous = [], empty = 0, adjacent = 0;
      trial.items.forEach((item, index) => {
        if (item.kind === 'break') { previous = []; return; }
        if (item.kind !== 'performance') { item.staff = []; return; }
        item.staff = [null, null, null, null];
        // Fill both senior-required positions first to preserve feasible pairings.
        for (const slot of [0, 2, 1, 3]) {
          let candidates = trial.people.filter(p => !reasons(p, trial, index, slot).length)
            .map(p => ({p, jitter: random()}));
          // Reserve a non-freshman for each pair before filling the other slots.
          // Otherwise low-count freshmen can make a fully feasible transition look short-staffed.
          if ((slot === 0 || slot === 2) && candidates.some(({p}) => p.year !== 1)) candidates = candidates.filter(({p}) => p.year !== 1);
          candidates.sort((a,b) => counts.get(a.p.id) - counts.get(b.p.id) ||
            Number(previous.includes(a.p.id)) - Number(previous.includes(b.p.id)) ||
            ((slot === 0 || slot === 2) ? Number(a.p.year === 1) - Number(b.p.year === 1) : 0) || a.jitter - b.jitter);
          if (candidates.length) {
            const id = candidates[0].p.id;
            item.staff[slot] = id; counts.set(id, counts.get(id) + 1);
            if (previous.includes(id)) adjacent++;
          } else empty++;
        }
        previous = item.staff.filter(Boolean);
      });
      const score = [empty, [...counts.values()].reduce((n,v) => n + v*v, 0), adjacent];
      if (!bestScore || score.some((v,i) => v < bestScore[i] && score.slice(0,i).every((x,j) => x === bestScore[j]))) {best = trial; bestScore = score;}
    }
    return best;
  }
  return {rows, time, reasons, warnings, allocate, staffKind, bandDraft};
})();
if (typeof module !== 'undefined') module.exports = TimetableCore;
