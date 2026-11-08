"use strict";

// ==========================================
// Supabase接続
// ==========================================

// 静的サイト用の公開設定。Cloudflare Pagesの環境変数は自動では読み込まれません。
// 既存SupabaseプロジェクトのURLと公開用キーを設定してください。
// service_roleキーは絶対に使用しないでください。
const SUPABASE_URL = "https://cjymelefxesbmbicemvf.supabase.co";
const SUPABASE_KEY = "sb_publishable_KxSQ8tpQH2rgVwRoirYd2w_WUP6TQRA";

let supabaseInitializationError = "";
const db = (() => {
  try {
    const url = SUPABASE_URL.trim();
    const key = SUPABASE_KEY.trim();
    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!key) missing.push("SUPABASE_KEY（公開用キー）");
    if (missing.length) {
      throw new Error(`app.js の ${missing.join("、")} が未設定です。設定して再デプロイしてください。Cloudflare Pagesの環境変数だけでは静的JavaScriptに反映されません。`);
    }
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { /* 下で設定エラーを表示する */ }
    if (!parsedUrl || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error("app.js の SUPABASE_URL にSupabaseプロジェクトのHTTPS URLを設定してください。");
    }
    // 公開用キーだけを許可する。旧形式はanonロールに限る。
    let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
    if (!publicKey) {
      try {
        const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        publicKey = key.split(".").length === 3 && JSON.parse(atob(payload)).role === "anon";
      } catch { /* 秘密キー・不正なキーは使用しない */ }
    }
    if (!publicKey) {
      throw new Error("app.js の SUPABASE_KEY にはpublishableキーまたはanonキーだけを設定してください。service_role・sb_secret_キーは使用できません。");
    }
    if (typeof window.supabase?.createClient !== "function") {
      throw new Error("Supabase SDKを読み込めませんでした。ネットワーク・CDNへの接続とindex.htmlのスクリプト読み込み順を確認してください。");
    }
    try {
      return window.supabase.createClient(url, key);
    } catch {
      // SDKの例外に設定値が含まれる可能性があるため、そのまま表示しない。
      throw new Error("Supabaseクライアントの初期化に失敗しました。app.jsのURL・公開用キーとSupabase SDKの読み込みを確認してください。");
    }
  } catch (error) {
    supabaseInitializationError = `Supabase設定エラー：${error.message}`;
    return null;
  }
})();

// ==========================================
// 共通設定
// ==========================================

const authSection = document.getElementById("auth-section");
const homeSection = document.getElementById("home-section");
const message = document.getElementById("message");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const usernameInput = document.getElementById("username");

const PAGE_IDS = [
  "takoika-section",
  "timetable-section",
  "home-section",
  "schedule-section",
  "band-section",
  "band-create-section",
  "band-leave-section",
  "band-detail-section",
  "profile-section",
  "admin-section",
  "user-management-section",
  "audition-section",
  "audition-create-section",
  "audition-detail-section",
  "audition-score-section",
  "feedback-section",
  "feedback-detail-section"
];

let currentAuthUser = null;
let currentProfileContext = null;
let screenVersion = 0;

// ==========================================
// 共通関数
// ==========================================

function showMessage(text) {
  message.textContent = text;
}

// 指定した画面だけを表示する
function showPage(pageId) {
  for (const id of PAGE_IDS) {
    const section = document.getElementById(id);

    if (section) {
      section.hidden = id !== pageId;
    }
  }
  document.dispatchEvent(new CustomEvent('circle-page-change', {detail:pageId}));
}

// 現在表示されている画面を取得
function getVisiblePage() {
  for (const id of PAGE_IDS) {
    const section = document.getElementById(id);

    if (section && !section.hidden) {
      return id;
    }
  }

  return null;
}

// ==========================================
// プロフィール・権限取得
// ==========================================

async function loadProfileContext() {
  const { data, error } = await db.rpc(
    "profile_context"
  );

  if (error) {
    throw error;
  }

  currentProfileContext = data;

  return data;
}

// 管理者かどうかを判定
function isAdmin(context) {
  return (
    context?.is_president === true ||
    context?.is_site_admin === true
  );
}

// ==========================================
// ログイン状態に応じて画面を更新
// ==========================================

async function updateScreen() {
  if (!db) return;
  const version = ++screenVersion;

  const { data, error } = await db.auth.getUser();

  if (version !== screenVersion) {
    return;
  }

  // 未ログイン
  if (error || !data.user) {
    currentAuthUser = null;
    currentProfileContext = null;

    authSection.hidden = false;

    showPage(null);
    document.dispatchEvent(new Event('circle-session-ready'));

    document.getElementById(
      "open-admin-button"
    ).hidden = true;

    return;
  }

  // ログイン済み
  currentAuthUser = data.user;

  authSection.hidden = true;

  try {
    const context = await loadProfileContext();

    if (version !== screenVersion) {
      return;
    }

    const profile = context?.profile;

    const username =
      profile?.username ||
      data.user.user_metadata?.username ||
      data.user.email;

    document.getElementById(
      "welcome"
    ).textContent = `ようこそ、${username} さん`;

    // 部長またはサイト管理者のみ表示
    document.getElementById(
      "open-admin-button"
    ).hidden = !isAdmin(context);

  } catch (err) {
    if (version !== screenVersion) {
      return;
    }

    document.getElementById(
      "welcome"
    ).textContent =
      `ようこそ、${data.user.email} さん`;

    document.getElementById(
      "open-admin-button"
    ).hidden = true;

    showMessage(
      "プロフィール情報の取得に失敗しました：" +
      err.message
    );
  }

  // 他の画面を開いていなければホームを表示
  if (!getVisiblePage()) {
    showPage("home-section");
  }
  document.dispatchEvent(new Event('circle-session-ready'));
}

// ==========================================
// 新規登録
// ==========================================

document.getElementById(
  "signup-button"
).addEventListener("click", async () => {
  if (!db) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const username = usernameInput.value.trim();

  if (!email || !username || password.length < 8) {
    showMessage(
      "ユーザー名、メール、8文字以上のパスワードを入力してください。"
    );
    return;
  }

  const button = document.getElementById(
    "signup-button"
  );

  button.disabled = true;

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: {
          username
        }
      }
    });

    if (error) {
      throw error;
    }

    if (!data.session) {
      showMessage(
        "確認メールを送信しました。メール内のリンクを開いてください。"
      );
    } else {
      showMessage("登録しました。");
      await updateScreen();
    }

  } catch (err) {
    showMessage(
      "新規登録エラー：" + err.message
    );

  } finally {
    button.disabled = false;
  }
});

// ==========================================
// ログイン
// ==========================================

document.getElementById(
  "auth-form"
).addEventListener("submit", async event => {

  event.preventDefault();
  if (!db) return;

  const button = document.getElementById(
    "login-button"
  );

  button.disabled = true;

  try {
    const { error } = await db.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value
    });

    if (error) {
      throw error;
    }

    showMessage("");

    await updateScreen();

  } catch (err) {
    showMessage(
      "ログインエラー：" + err.message
    );

  } finally {
    button.disabled = false;
  }
});

// ==========================================
// ログアウト
// ==========================================

document.getElementById(
  "logout-button"
).addEventListener("click", async () => {
  if (!db) return;

  const button = document.getElementById(
    "logout-button"
  );

  button.disabled = true;

  try {
    const { error } = await db.auth.signOut();

    if (error) {
      throw error;
    }

    currentAuthUser = null;
    currentProfileContext = null;

    showMessage("ログアウトしました。");

    await updateScreen();

  } catch (err) {
    showMessage(
      "ログアウトエラー：" + err.message
    );

  } finally {
    button.disabled = false;
  }
});

// ==========================================
// Supabase認証状態の監視
// ==========================================

if (db) db.auth.onAuthStateChange(() => {
  // 認証イベント内でSupabaseへの追加通信を
  // 直接awaitせず、次のタスクで画面を更新する
  setTimeout(() => {
    updateScreen();
  }, 0);
});

// ==========================================
// 初期表示
// ==========================================

if (db) {
  updateScreen();
} else {
  authSection.hidden = false;
  showPage(null);
  message.setAttribute("role", "alert");
  showMessage(supabaseInitializationError);
  document.getElementById("login-button").disabled = true;
  document.getElementById("signup-button").disabled = true;
}
