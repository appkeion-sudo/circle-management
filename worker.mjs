// All privileged calls stay in this Worker. No secrets are included in static assets.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}
});
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    try {
      const target = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
      const listing = url.pathname === '/api/admin/users';
      if (!listing && !target) throw new ApiError(404, '見つかりません。');
      if ((listing && request.method !== 'GET') || (target && request.method !== 'DELETE')) throw new ApiError(405, '許可されていない操作です。');
      if (request.method === 'DELETE' && request.headers.get('Origin') !== url.origin) throw new ApiError(403, '同じサイトから操作してください。');
      if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError(503, 'ユーザ管理のサーバ設定が完了していません。');
      const authorization = request.headers.get('Authorization') || '';
      if (!/^Bearer \S+$/.test(authorization) || authorization.length > 16000) throw new ApiError(401, 'ログインし直してください。');
      const base = env.SUPABASE_URL.replace(/\/$/, '');
      const upstream = async (path, init) => {
        const response = await fetch(base + path, {...init, signal:AbortSignal.timeout(20000)});
        const data = await response.json().catch(()=>null);
        return {response, data};
      };
      // getUser validates the token with Auth, rather than trusting decoded JWT claims.
      const identity = await upstream('/auth/v1/user', {headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY, Authorization:authorization}});
      if (!identity.response.ok || !uuid.test(identity.data?.id)) throw new ApiError(401, 'ログインし直してください。');
      const actor = identity.data.id;
      const headers = {apikey:env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json'};
      let name, args;
      if (listing) {
        const search = url.searchParams.get('q') || '';
        const offset = Number(url.searchParams.get('offset') || 0);
        if (search.length > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, '検索条件が不正です。');
        name = 'admin_users_list'; args = {p_actor:actor, p_search:search, p_offset:offset};
      } else {
        if (!uuid.test(target[1])) throw new ApiError(400, 'ユーザIDが不正です。');
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new ApiError(400, 'JSON形式で送信してください。');
        const bodyText = await request.text();
        if (bodyText.length > 1024) throw new ApiError(400, '入力が大きすぎます。');
        let body;
        try { body = JSON.parse(bodyText); } catch { throw new ApiError(400, '入力が不正です。'); }
        if (body.confirmation !== '削除' || !uuid.test(body.operation_id)) throw new ApiError(400, '「削除」と入力してください。');
        name = 'admin_user_delete'; args = {p_actor:actor, p_target:target[1], p_operation:body.operation_id, p_confirmation:body.confirmation};
      }
      const result = await upstream('/rest/v1/rpc/' + name, {method:'POST', headers, body:JSON.stringify(args)});
      if (!result.response.ok) {
        const code = result.data?.code;
        console.error(JSON.stringify({event:'user_admin_failure', requestId, actor, target:target?.[1], operationId:args.p_operation, code, status:result.response.status}));
        const safe = {KA403:'サイト管理者のみ操作できます。', KA400:'自分自身は削除できません。', KA409:'最後のサイト管理者は削除できません。', KA404:'対象ユーザが見つかりません。', KA422:'削除確認または操作IDが不正です。', KA412:'未確認のユーザ依存関係があります。管理者がDB構造を確認するまで削除できません。'};
        throw new ApiError(code === 'KA403' ? 403 : code === 'KA404' ? 404 : 409, safe[code] || '処理に失敗しました。状態を再確認してから再試行してください。');
      }
      console.info(JSON.stringify({event:'user_admin_success', requestId, actor, target:target?.[1], operation:name, operationId:args.p_operation}));
      return json({data:result.data, requestId});
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(JSON.stringify({event:'user_admin_exception', requestId, type:error.name}));
      return json({error:error instanceof ApiError ? error.message : '通信結果を確認できません。再読み込みして状態を確認してください。', requestId}, error.status || 503);
    }
  }
};
