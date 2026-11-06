"use strict";

(() => {
  const $ = id => document.getElementById(id);

  let context = null;
  let members = [];
  let roles = [];
  let siteAdmins = [];
  let selectedMember = null;
  let incomingTransferId = null;
  let requestVersion = 0;

  function note(id, text) {
    $(id).textContent = text;
  }

  function showProfilePage(pageId) {
    requestVersion++;

    showPage(pageId);
  }

  function makeElement(tag, text, className) {
    const element = document.createElement(tag);

    if (text !== undefined) {
      element.textContent = text;
    }

    if (className) {
      element.className = className;
    }

    return element;
  }

  function makeButton(text, handler, className = "") {
    const button = makeElement("button", text, className);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function makeSelectOptions(select, users) {
    select.replaceChildren();

    for (const user of users) {
      const option = document.createElement("option");
      option.value = user.user_id;
      option.textContent = user.username || "名前未設定";
      select.appendChild(option);
    }
  }

  function yearAt(admissionYear, override) {
    if (override != null) {
      return `${override}年生（例外設定）`;
    }

    if (admissionYear == null) {
      return "未登録";
    }

    const now = new Date();
    const schoolYear =
      now.getFullYear() - (now.getMonth() < 3 ? 1 : 0);

    const year = schoolYear - admissionYear + 1;

    return year > 0 ? `${year}年生` : "入学前";
  }

  async function rpc(name, params = {}) {
    const { data, error } = await db.rpc(name, params);

    if (error) {
      throw error;
    }

    return data;
  }

  async function refreshContext() {
    context = await rpc("profile_context");
    return context;
  }

  function isPresident() {
    return context?.is_president === true;
  }

  function isSiteAdmin() {
    return context?.is_site_admin === true;
  }

  function isManager() {
    return isPresident() || isSiteAdmin();
  }

  function memberName(userId) {
    return members.find(user => user.user_id === userId)
      ?.username || "名前未設定";
  }

  function roleName(roleId) {
    return roles.find(role => Number(role.id) === Number(roleId))
      ?.name || "不明な役職";
  }

  function clearRoleForm() {
    $("role-id").value = "";
    $("role-name").value = "";
    $("role-exclude").checked = false;
  }

  // ==========================================
  // プロフィール画面
  // ==========================================

  async function openProfile() {
    showProfilePage("profile-section");

    const version = requestVersion;

    note("profile-message", "読み込み中...");

    try {
      await refreshContext();

      if (version !== requestVersion) return;

      const profile = context.profile;

      if (!profile) {
        throw new Error("プロフィールが見つかりません");
      }

      $("profile-name").value = profile.username || "";

      $("profile-year").value =
        profile.admission_year ?? "";

      // 初回登録後は入学年度を直接編集できない
      $("profile-year").disabled =
        profile.admission_year != null;

      $("profile-year-current").textContent =
        `現在の入学年度：${profile.admission_year ?? "未登録"} / ` +
        `学年：${yearAt(
          profile.admission_year,
          profile.year_override
        )}`;

      $("profile-status").textContent =
        profile.member_status === "alumni"
          ? "OB・OG"
          : "現役生";

      const privileges = [];

      if (isPresident()) privileges.push("部長");
      if (isSiteAdmin()) privileges.push("サイト管理者");

      if (!privileges.length) {
        privileges.push("一般部員");
      }

      $("profile-privileges").textContent =
        privileges.join("・");

      $("profile-request-box").hidden =
        profile.admission_year == null;

      $("profile-pending").textContent =
        context.pending_year == null
          ? ""
          : `入学年度 ${context.pending_year} 年への変更を申請中です。`;

      incomingTransferId =
        context.incoming_transfer_id;

      $("profile-transfer-box").hidden =
        incomingTransferId == null;

      note("profile-message", "");

    } catch (error) {
      if (version === requestVersion) {
        note(
          "profile-message",
          "取得エラー：" + error.message
        );
      }
    }
  }

  $("open-profile-button").addEventListener(
    "click",
    openProfile
  );

  $("profile-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      note("profile-message", "保存中...");

      try {
        const name = $("profile-name").value.trim();

        const yearText = $("profile-year").value;

        const year =
          yearText === "" ? null : Number(yearText);

        await rpc("update_my_profile", {
          p_username: name,
          p_admission_year: year
        });

        note("profile-message", "保存しました。");

        await openProfile();
        await updateScreen();

      } catch (error) {
        note(
          "profile-message",
          "保存エラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // 入学年度変更申請
  // ==========================================

  $("profile-request-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const year = Number(
        $("profile-request-year").value
      );

      try {
        await rpc("request_admission_year", {
          p_year: year
        });

        await openProfile();

        note(
          "profile-message",
          "入学年度の変更を申請しました。"
        );

      } catch (error) {
        note(
          "profile-message",
          "申請エラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // 部長引き継ぎの承認
  // ==========================================

  $("accept-transfer").addEventListener(
    "click",
    async () => {
      if (incomingTransferId == null) return;

      if (!confirm("部長の引き継ぎを承認しますか？")) {
        return;
      }

      try {
        await rpc("accept_president", {
          p_transfer_id: incomingTransferId
        });

        await openProfile();
        await updateScreen();

        note(
          "profile-message",
          "部長の引き継ぎが完了しました。"
        );

      } catch (error) {
        note(
          "profile-message",
          "引き継ぎエラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // 管理者画面
  // ==========================================

  async function openAdmin() {
    showProfilePage("admin-section");

    const version = requestVersion;

    note("admin-message", "読み込み中...");

    try {
      await refreshContext();

      if (!isManager()) {
        throw new Error("管理者権限がありません");
      }

      const [memberData, roleData, requestData] =
        await Promise.all([
          rpc("circle_members_admin"),
          rpc("circle_roles_list"),
          rpc("pending_year_requests")
        ]);

      if (version !== requestVersion) return;

      members = memberData || [];
      roles = roleData || [];

      $("admin-role-area").hidden = !isPresident();

      $("admin-president-area").hidden =
        !isPresident();

      $("admin-site-area").hidden =
        !isSiteAdmin();

      makeSelectOptions(
        $("admin-member"),
        members
      );

      makeSelectOptions(
        $("admin-transfer-user"),
        members
      );

      makeSelectOptions(
        $("admin-site-user"),
        members
      );

      makeSelectOptions(
        $("admin-recover-user"),
        members
      );

      renderRequests(requestData || []);
      renderRoles();

      if (members.length) {
        selectedMember = members[0].user_id;
        $("admin-member").value = selectedMember;
        renderMember();
      } else {
        $("admin-member-list").replaceChildren();
      }

      if (isSiteAdmin()) {
        await loadSiteAdmins();
      }

      note("admin-message", "");

    } catch (error) {
      if (version === requestVersion) {
        note(
          "admin-message",
          "取得エラー：" + error.message
        );
      }
    }
  }

  $("open-admin-button").addEventListener(
    "click",
    openAdmin
  );

  // ==========================================
  // 入学年度変更申請の承認・却下
  // ==========================================

  function renderRequests(requests) {
    const container = $("admin-requests");
    container.replaceChildren();

    if (!requests.length) {
      container.appendChild(
        makeElement("p", "承認待ちの申請はありません。")
      );
      return;
    }

    for (const request of requests) {
      const card = makeElement("div", undefined, "admin-card");

      card.appendChild(
        makeElement(
          "p",
          `${request.username}：${request.requested_year}年への変更`
        )
      );

      const approve = makeButton(
        "承認",
        () => reviewRequest(request.id, true)
      );

      const reject = makeButton(
        "却下",
        () => reviewRequest(request.id, false),
        "danger-button"
      );

      const actions = makeElement(
        "div",
        undefined,
        "admin-actions"
      );

      actions.append(approve, reject);
      card.appendChild(actions);

      container.appendChild(card);
    }
  }

  async function reviewRequest(id, approve) {
    if (!confirm(
      approve ? "この申請を承認しますか？"
              : "この申請を却下しますか？"
    )) {
      return;
    }

    try {
      await rpc("review_year_request", {
        p_request_id: id,
        p_approve: approve
      });

      await openAdmin();

      note(
        "admin-message",
        approve ? "申請を承認しました。"
                : "申請を却下しました。"
      );

    } catch (error) {
      note(
        "admin-message",
        "処理エラー：" + error.message
      );
    }
  }

  // ==========================================
  // 役職管理
  // ==========================================

  function renderRoles() {
    const container = $("admin-roles");
    container.replaceChildren();

    if (!roles.length) {
      container.appendChild(
        makeElement("p", "役職はまだありません。")
      );
      return;
    }

    for (const role of roles) {
      const card = makeElement(
        "div",
        undefined,
        "admin-card"
      );

      card.appendChild(
        makeElement(
          "strong",
          role.name
        )
      );

      card.appendChild(
        makeElement(
          "p",
          role.exclude_from_staff_auto_assign
            ? "係の自動割り当て：対象外"
            : "係の自動割り当て：対象"
        )
      );

      const actions = makeElement(
        "div",
        undefined,
        "admin-actions"
      );

      actions.appendChild(
        makeButton("編集", () => {
          $("role-id").value = role.id;
          $("role-name").value = role.name;
          $("role-exclude").checked =
            role.exclude_from_staff_auto_assign;
        })
      );

      actions.appendChild(
        makeButton(
          "削除",
          async () => {
            if (!confirm(
              `役職「${role.name}」を削除しますか？`
            )) {
              return;
            }

            try {
              await rpc("delete_circle_role", {
                p_id: role.id
              });

              await openAdmin();

              note(
                "admin-message",
                "役職を削除しました。"
              );

            } catch (error) {
              note(
                "admin-message",
                "削除エラー：" + error.message
              );
            }
          },
          "danger-button"
        )
      );

      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  $("role-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const idText = $("role-id").value;

      try {
        await rpc("save_circle_role", {
          p_id: idText ? Number(idText) : null,
          p_name: $("role-name").value.trim(),
          p_exclude: $("role-exclude").checked
        });

        clearRoleForm();

        await openAdmin();

        note(
          "admin-message",
          "役職を保存しました。"
        );

      } catch (error) {
        note(
          "admin-message",
          "保存エラー：" + error.message
        );
      }
    }
  );

  $("role-reset").addEventListener(
    "click",
    clearRoleForm
  );

  // ==========================================
  // 部員管理
  // ==========================================

  $("admin-member").addEventListener(
    "change",
    event => {
      selectedMember = event.target.value;
      renderMember();
    }
  );

  function renderMember() {
    const container = $("admin-member-list");
    container.replaceChildren();

    const member = members.find(
      user => user.user_id === selectedMember
    );

    if (!member) return;

    const card = makeElement(
      "div",
      undefined,
      "admin-card"
    );

    card.appendChild(
      makeElement(
        "h3",
        member.username
      )
    );

    card.appendChild(
      makeElement(
        "p",
        `入学年度：${member.admission_year ?? "未登録"} / ` +
        `学年：${yearAt(
          member.admission_year,
          member.year_override
        )}`
      )
    );

    if (isPresident()) {
      const statusLabel = makeElement("label", "所属区分");

      const statusSelect = document.createElement("select");

      for (const [value, label] of [
        ["active", "現役生"],
        ["alumni", "OB・OG"]
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        statusSelect.appendChild(option);
      }

      statusSelect.value = member.member_status;

      const overrideLabel = makeElement(
        "label",
        "学年の例外設定（空欄なら自動計算）"
      );

      const overrideInput = document.createElement("input");
      overrideInput.type = "number";
      overrideInput.min = "1";
      overrideInput.max = "20";
      overrideInput.placeholder = "例：3";
      overrideInput.value = member.year_override ?? "";

      const saveButton = makeButton(
        "所属区分・学年を保存",
        async () => {
          try {
            await rpc("set_member_details", {
              p_user_id: member.user_id,
              p_status: statusSelect.value,
              p_year_override:
                overrideInput.value === ""
                  ? null
                  : Number(overrideInput.value)
            });

            await openAdmin();

            note(
              "admin-message",
              "部員情報を保存しました。"
            );

          } catch (error) {
            note(
              "admin-message",
              "保存エラー：" + error.message
            );
          }
        }
      );

      card.append(
        statusLabel,
        statusSelect,
        overrideLabel,
        overrideInput,
        saveButton
      );

      const roleHeading = makeElement(
        "h3",
        "役職の割り当て"
      );

      card.appendChild(roleHeading);

      for (const role of roles) {
        const label = makeElement(
          "label",
          undefined,
          "member-option"
        );

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";

        checkbox.checked =
          (member.role_ids || [])
            .map(Number)
            .includes(Number(role.id));

        checkbox.addEventListener(
          "change",
          async () => {
            checkbox.disabled = true;

            try {
              await rpc("set_user_role", {
                p_user_id: member.user_id,
                p_role_id: role.id,
                p_enabled: checkbox.checked
              });

              note(
                "admin-message",
                "役職を更新しました。"
              );

            } catch (error) {
              checkbox.checked = !checkbox.checked;

              note(
                "admin-message",
                "更新エラー：" + error.message
              );

            } finally {
              checkbox.disabled = false;
            }
          }
        );

        label.append(
          checkbox,
          makeElement("span", role.name)
        );

        card.appendChild(label);
      }

    } else {
      card.appendChild(
        makeElement(
          "p",
          "役職：" +
          (member.role_ids || [])
            .map(roleName)
            .join("、")
        )
      );
    }

    container.appendChild(card);
  }

  // ==========================================
  // 部長引き継ぎ
  // ==========================================

  $("admin-transfer").addEventListener(
    "click",
    async () => {
      const userId = $("admin-transfer-user").value;

      if (!userId) return;

      if (!confirm(
        `${memberName(userId)} さんに部長を引き継ぎますか？`
      )) {
        return;
      }

      try {
        await rpc("propose_president", {
          p_new_user: userId
        });

        note(
          "admin-message",
          "引き継ぎ依頼を送信しました。"
        );

      } catch (error) {
        note(
          "admin-message",
          "申請エラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // サイト管理者管理
  // ==========================================

  async function loadSiteAdmins() {
    siteAdmins = await rpc("site_admin_list") || [];

    const container = $("admin-site-list");
    container.replaceChildren();

    for (const admin of siteAdmins) {
      const card = makeElement(
        "div",
        undefined,
        "admin-card"
      );

      card.appendChild(
        makeElement(
          "strong",
          memberName(admin.user_id)
        )
      );

      card.appendChild(
        makeButton(
          "サイト管理者を解除",
          async () => {
            if (!confirm(
              "このユーザーのサイト管理者権限を解除しますか？"
            )) {
              return;
            }

            try {
              await rpc("set_site_admin", {
                p_user_id: admin.user_id,
                p_enabled: false
              });

              await loadSiteAdmins();

              note(
                "admin-message",
                "サイト管理者を解除しました。"
              );

            } catch (error) {
              note(
                "admin-message",
                "解除エラー：" + error.message
              );
            }
          },
          "danger-button"
        )
      );

      container.appendChild(card);
    }
  }

  $("admin-site-add").addEventListener(
    "click",
    async () => {
      const userId = $("admin-site-user").value;

      if (!userId) return;

      if (!confirm(
        `${memberName(userId)} さんをサイト管理者にしますか？`
      )) {
        return;
      }

      try {
        await rpc("set_site_admin", {
          p_user_id: userId,
          p_enabled: true
        });

        await loadSiteAdmins();

        note(
          "admin-message",
          "サイト管理者を追加しました。"
        );

      } catch (error) {
        note(
          "admin-message",
          "追加エラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // 部長権限の復旧
  // ==========================================

  $("admin-recover").addEventListener(
    "click",
    async () => {
      const userId = $("admin-recover-user").value;

      if (!userId) return;

      if (!confirm(
        `${memberName(userId)} さんを部長に設定しますか？\n` +
        "現在の部長は部長権限を失います。"
      )) {
        return;
      }

      try {
        await rpc("recover_president", {
          p_new_user: userId
        });

        await updateScreen();
        await openAdmin();

        note(
          "admin-message",
          "部長を再設定しました。"
        );

      } catch (error) {
        note(
          "admin-message",
          "復旧エラー：" + error.message
        );
      }
    }
  );

  // ==========================================
  // ログアウト時の初期化
  // ==========================================

  db.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") {
      requestVersion++;
      context = null;
      members = [];
      roles = [];
      siteAdmins = [];
      selectedMember = null;
      incomingTransferId = null;

      $("profile-section").hidden = true;
      $("admin-section").hidden = true;
    }
  });

})();
