"use strict";
// One in-flight write per key. A retry always writes the latest desired value.
const CircleSave = (() => {
  const jobs = new Map();
  let generation = 0;
  const report = job => job.status?.(job.running ? '保存中' : job.error ? '保存失敗／再試行中' : job.dirty ? '保存中' : '保存済み', job.error);
  async function run(job) {
    if (job.running || !job.dirty || job.generation !== generation) return;
    clearTimeout(job.timer);
    job.running = true; job.error = null; report(job);
    const revision = job.revision;
    try {
      const value = structuredClone(job.value);
      await job.write(value);
      if (job.generation !== generation) return;
      if (revision === job.revision) job.dirty = false;
      job.attempts = 0;
    } catch (error) {
      job.error = error;
      if (job.generation === generation && ++job.attempts < 4) job.timer = setTimeout(() => run(job), 1000 * 2 ** job.attempts);
    } finally {
      job.running = false;
      if (job.generation === generation) {
        report(job);
        if (job.dirty && (!job.error || revision !== job.revision)) void run(job);
      }
    }
  }
  function put(key, value, write, status) {
    let job = jobs.get(key);
    if (!job) { job = {generation, revision:0, attempts:0}; jobs.set(key, job); }
    Object.assign(job, {value, write, status, dirty:true, error:null}); job.revision++;
    report(job); void run(job);
  }
  const pending = (prefix = '') => [...jobs].some(([key,j]) => key.startsWith(prefix) && j.dirty);
  const retry = (prefix = '') => { for (const [key,j] of jobs) if (key.startsWith(prefix)) { j.attempts=0; void run(j); } };
  const clear = () => { generation++; for (const j of jobs.values()) clearTimeout(j.timer); jobs.clear(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => retry());
    window.addEventListener('beforeunload', e => { if (pending()) { e.preventDefault(); e.returnValue=''; } });
  }
  return {put,pending,retry,clear};
})();
