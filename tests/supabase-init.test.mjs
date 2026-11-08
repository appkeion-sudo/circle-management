import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const localScripts = [...html.matchAll(/<script src="([^":]+\.js)"><\/script>/g)].map(match => match[1]);
const jwt = role => `e30.${Buffer.from(JSON.stringify({role})).toString('base64url')}.signature`;

async function boot({url, key, sdkMissing=false, sdkThrows=false}={}) {
  const elements = new Map(), calls = [], timers = [], authCalls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden:false, disabled:false, textContent:'', value:'', listeners:{}, attributes:{},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; }
    });
    return elements.get(id);
  };
  const client = {auth:{
    getUser:async()=>({data:{user:null}}),
    onAuthStateChange:fn=>{timers.push(fn);},
    signInWithPassword:async args=>{authCalls.push(['login',args]);return {};},
    signUp:async args=>{authCalls.push(['signup',args]);return {data:{session:null}};},
    signOut:async()=>{authCalls.push(['logout']);return {};}
  }};
  const context = vm.createContext({URL,atob,TextEncoder,Event,CustomEvent,
    setTimeout:fn=>timers.push(fn),clearTimeout(){},console,
    window:{addEventListener(){},supabase:sdkMissing?undefined:{createClient:(...args)=>{
      calls.push(args);if(sdkThrows)throw Error('sensitive-sdk-detail');return client;
    }}},
    document:{getElementById:get,dispatchEvent(){}}
  });
  let code = source;
  if (url !== undefined) code = code.replace(/const SUPABASE_URL = .*;/, `const SUPABASE_URL = ${JSON.stringify(url)};`);
  if (key !== undefined) code = code.replace(/const SUPABASE_KEY = .*;/, `const SUPABASE_KEY = ${JSON.stringify(key)};`);
  vm.runInContext(code, context);
  await Promise.resolve();
  return {context,get,calls,authCalls,timers};
}

test('static public configuration initializes once and preserves login, signup and logout', async()=>{
  for (const key of [undefined, jwt('anon')]) {
    const env = await boot({key});
    assert.equal(env.calls.length,1);
    assert.match(env.calls[0][0], /^https:\/\//);
    assert.equal(env.timers.length,1);
    assert.equal(env.get('login-button').disabled,false);
    env.get('email').value='member@example.test';env.get('password').value='password123';env.get('username').value='部員';
    await env.get('auth-form').listeners.submit({preventDefault(){}});
    await env.get('signup-button').listeners.click();
    await env.get('logout-button').listeners.click();
    assert.deepEqual(env.authCalls.map(call=>call[0]),['login','signup','logout']);
    assert.equal(env.authCalls[0][1].email,'member@example.test');
    assert.equal(env.authCalls[1][1].options.data.username,'部員');
  }
});

for (const [name,options,expected] of [
  ['missing URL',{url:''},/SUPABASE_URL.*未設定/],
  ['missing public key',{key:'   '},/SUPABASE_KEY.*未設定/],
  ['both missing',{url:' ',key:''},/SUPABASE_URL.*SUPABASE_KEY.*未設定/],
  ['invalid URL',{url:'invalid'},/HTTPS URL/],
  ['secret key',{key:'sb_secret_test'},/publishable.*anon/],
  ['service role',{key:jwt('service_role')},/publishable.*anon/],
  ['malformed key',{key:'invalid'},/publishable.*anon/],
  ['missing SDK',{sdkMissing:true},/SDKを読み込めません/],
  ['SDK initialization failure',{sdkThrows:true},/初期化に失敗/]
]) {
  test(`${name}: visible error and no cascading failures in subsequent scripts`,async()=>{
    const env = await boot(options);
    for (const file of localScripts.filter(file=>file!=='app.js')) {
      vm.runInContext(await readFile(new URL('../'+file,import.meta.url),'utf8'),env.context,{filename:file});
    }
    assert.equal(vm.runInContext('db',env.context),null);
    assert.match(env.get('message').textContent,expected);
    assert.doesNotMatch(env.get('message').textContent,/sensitive-sdk-detail/);
    assert.equal(env.get('message').attributes.role,'alert');
    assert.equal(env.get('auth-section').hidden,false);
    assert.equal(env.get('home-section').hidden,true);
    assert.equal(env.get('login-button').disabled,true);
    assert.equal(env.get('signup-button').disabled,true);
    await env.get('auth-form').listeners.submit({preventDefault(){}});
    await env.get('signup-button').listeners.click();
    assert.equal(env.authCalls.length,0);
    assert.equal(env.calls.length,options.sdkThrows?1:0);
    assert.equal(env.timers.length,0);
  });
}
