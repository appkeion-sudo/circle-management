import {mkdir, copyFile, readFile, rm} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const scripts = [...html.matchAll(/<script src="([^":]+\.js)"><\/script>/g)].map(m=>m[1]);
const files = ['index.html', 'style.css', ...scripts];
for (const file of files) {
  if (!/^[a-z0-9-]+\.(html|css|js)$/.test(file)) throw Error('Invalid asset name');
}
const output = new URL('dist', root);
// Rebuild the generated directory so removed source files cannot be republished.
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
// Explicit asset allowlist: never publish SQL, tests, credentials, or Worker source.
for (const file of files) {
  await copyFile(new URL(file,root), new URL('dist/'+file,root));
}
await mkdir(new URL('dist/assets/takoika/', root), {recursive:true});
for (const file of ['pot.png','octopus.png','squid.png']) {
  await copyFile(new URL('assets/takoika/'+file,root), new URL('dist/assets/takoika/'+file,root));
}
