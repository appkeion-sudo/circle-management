import {mkdir, copyFile, readFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const scripts = [...html.matchAll(/<script src="([^":]+\.js)"><\/script>/g)].map(m=>m[1]);
await mkdir(new URL('dist/', root), {recursive:true});
// Explicit asset allowlist: never publish SQL, tests, credentials, or Worker source.
for (const file of ['index.html','style.css',...scripts]) {
  if (!/^[a-z0-9-]+\.(html|css|js)$/.test(file)) throw Error('Invalid asset name');
  await copyFile(new URL(file,root), new URL('dist/'+file,root));
}
