"use strict";

(() => {
  const profileButton = document.getElementById(
    "open-profile-button"
  );

  const profileSection = document.getElementById(
    "profile-section"
  );

  if (!profileButton || !profileSection) {
    console.error("プロフィール画面が見つかりません。");
    return;
  }

  // HTMLにある表示欄を再利用し、同じIDの要素を追加しない。
  const rolesContainer = document.getElementById("profile-roles");
  if (!rolesContainer) return;
  let rolesVersion = 0;

  // 自分に割り当てられた役職を取得
  async function loadMyRoles() {
    const version = ++rolesVersion;
    rolesContainer.textContent = "読み込み中...";

    try {
      const { data, error } = await db.rpc(
        "my_circle_roles"
      );

      if (error) {
        throw error;
      }

      if (version !== rolesVersion) return;

      rolesContainer.replaceChildren();

      if (!data || data.length === 0) {
        rolesContainer.textContent = "役職なし";
        return;
      }

      for (const role of data) {
        const tag = document.createElement("span");

        tag.className = "profile-role-tag";
        tag.textContent = role.name;

        rolesContainer.appendChild(tag);
      }

    } catch (error) {
      if (version !== rolesVersion) return;
      rolesContainer.textContent =
        "役職の取得に失敗しました：" + error.message;

      console.error(error);
    }
  }

  // プロフィールを開いたら役職を更新
  profileButton.addEventListener(
    "click",
    loadMyRoles
  );

  // ログアウト時に表示を消す
  db.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") {
      rolesVersion++;
      rolesContainer.replaceChildren();
    }
  });
})();
