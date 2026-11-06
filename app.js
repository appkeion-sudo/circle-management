"use strict";

// ==========================================
// Supabase接続
// ==========================================

// 移行先で新しく作成したSupabaseのURLと公開用キーを入力してください。
// service_roleキーは絶対に使用しないでください。
const SUPABASE_URL = "";
const SUPABASE_KEY = "";

const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

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
  "timetable-section",
  "home-section",
  "schedule-section",
  "band-section",
  "band-create-section",
  "band-leave-section",
  "band-detail-section",
  "profile-section",
  "admin-section",
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

db.auth.onAuthStateChange(() => {
  // 認証イベント内でSupabaseへの追加通信を
  // 直接awaitせず、次のタスクで画面を更新する
  setTimeout(() => {
    updateScreen();
  }, 0);
});

// ==========================================
// 初期表示
// ==========================================

updateScreen();
