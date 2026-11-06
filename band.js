
"use strict";

(() => {
  const $ = id => document.getElementById(id);

  const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

  const SLOT_LABELS = {
    1: "1限",
    2: "2限",
    3: "3限",
    4: "4限",
    5: "5限",
    6: "18:00〜19:00",
    7: "19:00〜20:00",
    8: "20:00〜21:00"
  };

  const ICON_BUCKET = "band-icons";

  let currentUser = null;
  let allUsers = [];
  let myBands = [];
  let currentBand = null;
  let currentMembers = [];
  let selectedMemberIds = [];
  let selectedIconFile = null;
  let previewUrl = null;

  function page(id) {
    showPage(id);
  }

  function message(id, text) {
    $(id).textContent = text;
  }

  function element(tag, text, className = "") {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function button(text, handler, className = "") {
    const el = element("button", text, className);
    el.type = "button";
    el.addEventListener("click", handler);
    return el;
  }

  async function getUser() {
    const { data, error } = await db.auth.getUser();
    if (error) throw error;
    if (!data.user) throw new Error("ログインしてください。");
    currentUser = data.user;
    return currentUser;
  }

  async function rpc(name, params = {}) {
    const { data, error } = await db.rpc(name, params);
    if (error) throw error;
    return data;
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDate(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function dateRange(start, end) {
    const dates = [];
    const current = parseDate(start);
    const last = parseDate(end);

    if (
      Number.isNaN(current.getTime()) ||
      Number.isNaN(last.getTime())
    ) {
      throw new Error("正しい日付を指定してください。");
    }

    if (current > last) {
      throw new Error("終了日は開始日以降にしてください。");
    }

    while (current <= last) {
      if (dates.length >= 31) {
        throw new Error("表示期間は31日以内にしてください。");
      }
      dates.push(formatDate(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  function defaultDates(startId, endId) {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 6);
    $(startId).value = formatDate(today);
    $(endId).value = formatDate(end);
  }

  function normalizeUsers(data) {
    return (data || []).map(user => ({
      id: String(user.id || user.user_id),
      username: user.username || "名前未設定"
    }));
  }

  function username(id) {
    return allUsers.find(
      user => user.id === String(id)
    )?.username || "名前未設定";
  }

  async function loadUsers() {
    allUsers = normalizeUsers(await rpc("list_circle_users"));
  }

  async function loadMyBands() {
    await getUser();

    const { data: memberships, error } = await db
      .from("band_members")
      .select("band_id")
      .eq("user_id", currentUser.id);

    if (error) throw error;

    const ids = (memberships || []).map(row => row.band_id);

    if (!ids.length) {
      myBands = [];
      return;
    }

    const { data, error: bandError } = await db
      .from("bands")
      .select("id, name, icon_path, created_by")
      .in("id", ids)
      .order("name");

    if (bandError) throw bandError;
    myBands = data || [];
  }

  async function iconUrl(path) {
    if (!path) return null;

    const { data } = db.storage
      .from(ICON_BUCKET)
      .getPublicUrl(path);

    return data.publicUrl;
  }

  async function renderBandList() {
    const container = $("band-list");
    container.replaceChildren();

    if (!myBands.length) {
      container.appendChild(
        element("p", "所属しているバンドはありません。")
      );
      return;
    }

    for (const band of myBands) {
      const card = button(
        band.name,
        () => openBandDetail(band.id),
        "band-card"
      );

      card.replaceChildren();

      const url = await iconUrl(band.icon_path);

      if (url) {
        const img = element("img");
        img.src = url;
        img.alt = `${band.name}のアイコン`;
        img.className = "band-icon";
        card.appendChild(img);
      } else {
        card.appendChild(
          element("div", "🎸", "band-icon-placeholder")
        );
      }

      card.appendChild(element("span", band.name));
      container.appendChild(card);
    }
  }

  async function openBandList() {
    page("band-section");
    message("band-list-message", "読み込み中...");

    try {
      await loadMyBands();
      await renderBandList();
      message("band-list-message", "");
    } catch (error) {
      message(
        "band-list-message",
        "読み込みエラー：" + error.message
      );
    }
  }

  $("open-band-button").addEventListener(
    "click", openBandList
  );

  // =====================================
  // バンド作成
  // =====================================

  function renderCreateMembers() {
    const container = $("create-member-list");
    container.replaceChildren();

    for (const user of allUsers) {
      if (user.id === String(currentUser.id)) continue;

      const label = element(
        "label", undefined, "member-option"
      );

      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.value = user.id;

      label.append(
        checkbox,
        element("span", user.username)
      );

      container.appendChild(label);
    }
  }

  async function openCreateBand() {
    page("band-create-section");
    $("create-band-form").reset();
    $("band-icon-preview").hidden = true;
    selectedIconFile = null;

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    message("create-band-message", "部員一覧を読み込み中...");

    try {
      await getUser();
      await loadUsers();
      renderCreateMembers();
      message("create-band-message", "");
    } catch (error) {
      message(
        "create-band-message",
        "読み込みエラー：" + error.message
      );
    }
  }

  $("open-create-band").addEventListener(
    "click", openCreateBand
  );

  $("create-back-band").addEventListener(
    "click", openBandList
  );

  $("band-icon").addEventListener("change", event => {
    const file = event.target.files?.[0];
    const preview = $("band-icon-preview");

    selectedIconFile = null;
    preview.hidden = true;

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    if (!file) return;

    const allowed = [
      "image/jpeg", "image/png", "image/webp"
    ];

    if (!allowed.includes(file.type)) {
      message(
        "create-band-message",
        "JPEG、PNG、WebP画像を選択してください。"
      );
      event.target.value = "";
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      message(
        "create-band-message",
        "画像は2MB以下にしてください。"
      );
      event.target.value = "";
      return;
    }

    selectedIconFile = file;
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
    message("create-band-message", "");
  });

  async function uploadIcon(file) {
    if (!file) return null;

    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp"
    };

    const extension = extensions[file.type];

    if (!extension) {
      throw new Error("対応していない画像形式です。");
    }

    const path =
      `${currentUser.id}/${crypto.randomUUID()}.${extension}`;

    const { data, error } = await db.storage
      .from(ICON_BUCKET)
      .upload(path, file, {
        contentType: file.type,
        upsert: false
      });

    if (error) throw error;
    return data.path;
  }

  $("create-band-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const name = $("band-name").value.trim();

      if (!name) {
        message(
          "create-band-message",
          "バンド名を入力してください。"
        );
        return;
      }

      const members = Array.from(
        $("create-member-list").querySelectorAll(
          "input:checked"
        )
      ).map(input => input.value);

      const submit = $("create-band-submit");
      submit.disabled = true;

      message("create-band-message", "作成中...");

      let uploadedPath = null;
      let bandCreated = false;
      try {
        await getUser();

        uploadedPath = selectedIconFile
          ? await uploadIcon(selectedIconFile)
          : null;

        await rpc("create_band", {
          p_name: name,
          p_icon_path: uploadedPath,
          p_member_ids: members
        });
        bandCreated = true;

        await openBandList();
      } catch (error) {
        // 通信切断時にはRPCが既に成功していることがあるため、参照を確認する。
        let cleanupNote = "";
        if (uploadedPath && !bandCreated) {
          try {
            const { data: bands, error: lookupError } = await db
              .from("bands").select("id").eq("icon_path", uploadedPath).limit(1);
            if (lookupError) throw lookupError;
            if (bands?.length) {
              await openBandList();
              return;
            }
            const { error: cleanupError } = await db.storage
              .from(ICON_BUCKET).remove([uploadedPath]);
            if (cleanupError) throw cleanupError;
          } catch (cleanupError) {
            console.warn("未使用アイコンの削除に失敗しました:", cleanupError.message);
            cleanupNote = "\n画像の後片付けを確認できませんでした。";
          }
        }
        message(
          "create-band-message",
          "作成エラー：" + error.message + cleanupNote
        );
      } finally {
        submit.disabled = false;
      }
    }
  );

  // =====================================
  // バンド脱退
  // =====================================

  async function openLeaveBand() {
    page("band-leave-section");
    message("leave-band-message", "読み込み中...");

    try {
      await loadMyBands();

      const container = $("leave-band-options");
      container.replaceChildren();

      for (const band of myBands) {
        const label = element(
          "label", undefined, "member-option"
        );

        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.value = band.id;

        label.append(
          checkbox,
          element("span", band.name)
        );

        container.appendChild(label);
      }

      if (!myBands.length) {
        container.appendChild(
          element("p", "脱退できるバンドがありません。")
        );
      }

      message("leave-band-message", "");
    } catch (error) {
      message(
        "leave-band-message",
        "読み込みエラー：" + error.message
      );
    }
  }

  $("open-leave-band").addEventListener(
    "click", openLeaveBand
  );

  $("leave-back-band").addEventListener(
    "click", openBandList
  );

  $("leave-band-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const selected = Array.from(
        $("leave-band-options").querySelectorAll(
          "input:checked"
        )
      ).map(input => input.value);

      if (!selected.length) {
        message(
          "leave-band-message",
          "脱退するバンドを選択してください。"
        );
        return;
      }

      if (!confirm(
        `${selected.length}件のバンドから脱退しますか？`
      )) return;

      const submit = $("leave-band-submit");
      submit.disabled = true;

      try {
        await getUser();

        const { error } = await db
          .from("band_members")
          .delete()
          .eq("user_id", currentUser.id)
          .in("band_id", selected);

        if (error) throw error;

        await openBandList();
      } catch (error) {
        message(
          "leave-band-message",
          "脱退エラー：" + error.message
        );
      } finally {
        submit.disabled = false;
      }
    }
  );

  // =====================================
  // バンド詳細
  // =====================================

  async function openBandDetail(bandId) {
    page("band-detail-section");
    $("band-schedule-results").hidden = true;
    message("band-detail-message", "読み込み中...");

    try {
      await getUser();

      currentBand = myBands.find(
        band => String(band.id) === String(bandId)
      );

      if (!currentBand) {
        throw new Error("バンドが見つかりません。");
      }

      $("detail-band-name").textContent =
        currentBand.name;

      const icon = $("detail-band-icon");
      icon.hidden = true;

      const url = await iconUrl(currentBand.icon_path);

      if (url) {
        icon.src = url;
        icon.hidden = false;
      }

      await loadUsers();

      const { data, error } = await db
        .from("band_members")
        .select("user_id")
        .eq("band_id", bandId);

      if (error) throw error;

      currentMembers = (data || []).map(row => ({
        user_id: String(row.user_id),
        username: username(row.user_id)
      }));

      selectedMemberIds = currentMembers.map(
        member => member.user_id
      );

      renderDetailMembers();

      defaultDates(
        "band-start-date",
        "band-end-date"
      );

      await showBandSchedule();
    } catch (error) {
      message(
        "band-detail-message",
        "読み込みエラー：" + error.message
      );
    }
  }

  $("detail-back-band").addEventListener(
    "click", openBandList
  );

  function renderDetailMembers() {
    const container = $("detail-member-list");
    container.replaceChildren();

    for (const member of currentMembers) {
      const label = element(
        "label", undefined, "member-option"
      );

      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.value = member.user_id;
      checkbox.checked = selectedMemberIds.includes(
        member.user_id
      );

      label.append(
        checkbox,
        element("span", member.username)
      );

      container.appendChild(label);
    }
  }

  $("apply-band-members").addEventListener(
    "click",
    async () => {
      const selected = Array.from(
        $("detail-member-list").querySelectorAll(
          "input:checked"
        )
      ).map(input => input.value);

      if (!selected.length) {
        message(
          "band-detail-message",
          "1人以上のメンバーを選択してください。"
        );
        return;
      }

      selectedMemberIds = selected;
      await showBandSchedule();
    }
  );

  $("band-date-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();
      await showBandSchedule();
    }
  );

  // =====================================
  // スケジュール取得・集計
  // =====================================

  function isAvailable(value) {
    return (
      value === true ||
      value === 1 ||
      value === "true" ||
      value === "1" ||
      value === "t"
    );
  }

  function normalizeRows(data) {
    if (!Array.isArray(data)) {
      throw new Error(
        "get_band_schedules の戻り値が配列ではありません。"
      );
    }

    return data.map(row => ({
      user_id: String(row.user_id ?? ""),
      schedule_date: String(
        row.schedule_date ?? ""
      ).slice(0, 10),
      slot: Number(row.slot),
      available: isAvailable(row.available)
    }));
  }

  async function showBandSchedule() {
    if (!currentBand) return;

    const start = $("band-start-date").value;
    const end = $("band-end-date").value;

    if (!start || !end) {
      message(
        "band-detail-message",
        "開始日と終了日を指定してください。"
      );
      return;
    }

    $("band-schedule-results").hidden = true;

    try {
      const dates = dateRange(start, end);

      if (!selectedMemberIds.length) {
        throw new Error(
          "集計対象のメンバーを選択してください。"
        );
      }

      message(
        "band-detail-message",
        "スケジュールを集計中..."
      );

      const response = await rpc(
        "get_band_schedules",
        {
          p_band_id: currentBand.id,
          p_start_date: start,
          p_end_date: end
        }
      );

      const rows = normalizeRows(response || []);

      const matched = rows.filter(row =>
        selectedMemberIds.includes(row.user_id) &&
        dates.includes(row.schedule_date) &&
        SLOTS.includes(row.slot)
      );

      renderScheduleTable(dates, matched);

      $("band-selected-range").textContent =
        `${start} ～ ${end}`;

      $("band-member-count").textContent =
        `集計対象：${selectedMemberIds.length}人`;

      $("band-schedule-results").hidden = false;

      const positives = matched.filter(
        row => row.available
      ).length;

      if (positives === 0) {
        message(
          "band-detail-message",
          "参加可能な予定が取得できませんでした。" +
          "MYスケジュールで〇を登録済みの場合は、" +
          "Supabaseの get_band_schedules 関数を確認してください。" +
          `（取得行数：${rows.length}、対象一致：${matched.length}）`
        );
      } else {
        message("band-detail-message", "");
      }

    } catch (error) {
      $("band-schedule-results").hidden = true;

      message(
        "band-detail-message",
        "集計エラー：" + error.message
      );
    }
  }

  // =====================================
  // 日付が縦、8時間帯が横の表
  // =====================================

  function renderScheduleTable(dates, rows) {
    const table = $("band-schedule-table");
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");

    thead.replaceChildren();
    tbody.replaceChildren();

    const availability = new Map();

    for (const row of rows) {
      const key =
        `${row.user_id}|${row.schedule_date}|${row.slot}`;

      availability.set(
        key,
        availability.get(key) === true ||
        row.available
      );
    }

    // 横方向：時間帯
    const header = element("tr");
    header.appendChild(element("th", "日付"));

    for (const slot of SLOTS) {
      const isMobile = window.innerWidth <= 600;

      const shortLabels = {
        1: "1限",
        2: "2限",
        3: "3限",
        4: "4限",
        5: "5限",
        6: "18",
        7: "19",
        8: "20"
      };

      const th = element(
        "th",
        isMobile ? shortLabels[slot] : SLOT_LABELS[slot]
      );

      th.style.minWidth = "85px";
      th.style.fontSize = "12px";
      th.style.whiteSpace = "normal";

      header.appendChild(th);
    }

    thead.appendChild(header);

    const weekdays = [
      "日", "月", "火", "水", "木", "金", "土"
    ];

    const total = selectedMemberIds.length;

    // 縦方向：日付
    for (const date of dates) {
      const tr = element("tr");
      const parsed = parseDate(date);

      const label =
        `${parsed.getMonth() + 1}/` +
        `${parsed.getDate()}` +
        `(${weekdays[parsed.getDay()]})`;

      const dateCell = element("th", label);
      dateCell.scope = "row";
      dateCell.style.whiteSpace = "nowrap";

      tr.appendChild(dateCell);

      for (const slot of SLOTS) {
        let count = 0;

        for (const userId of selectedMemberIds) {
          const key =
            `${userId}|${date}|${slot}`;

          if (availability.get(key) === true) {
            count++;
          }
        }

        const td = element(
          "td",
          `${count}/${total}`,
          "availability-cell"
        );

        const ratio = total > 0
          ? count / total
          : 0;

        td.title =
          `${date} ${SLOT_LABELS[slot]}：` +
          `${total}人中${count}人参加可能`;

        td.style.textAlign = "center";
        td.style.fontWeight = "bold";
        td.style.padding = "12px 6px";
        td.style.whiteSpace = "nowrap";

        // 参加可能割合が高いほど目立つ色
        if (ratio === 1) {
          td.style.backgroundColor = "#e53935";
          td.style.color = "#ffffff";
        } else if (ratio >= 0.75) {
          td.style.backgroundColor = "#fb8c00";
          td.style.color = "#ffffff";
        } else if (ratio >= 0.5) {
          td.style.backgroundColor = "#ffd54f";
          td.style.color = "#3c3000";
        } else if (ratio > 0) {
          td.style.backgroundColor = "#b3e5fc";
          td.style.color = "#16415b";
        } else {
          td.style.backgroundColor = "#eef0f3";
          td.style.color = "#657181";
        }

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    // 画面幅が狭い場合は横スクロール
    const container = table.parentElement;

    if (container) {
      container.style.overflowX = "auto";
      container.style.width = "100%";
    }

    table.style.minWidth = "850px";
    table.style.borderCollapse = "collapse";
  }

  // =====================================
  // ログアウト時の初期化
  // =====================================

  db.auth.onAuthStateChange(event => {
    if (event !== "SIGNED_OUT") return;

    currentUser = null;
    allUsers = [];
    myBands = [];
    currentBand = null;
    currentMembers = [];
    selectedMemberIds = [];
    selectedIconFile = null;

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    for (const id of [
      "band-section",
      "band-create-section",
      "band-leave-section",
      "band-detail-section"
    ]) {
      $(id).hidden = true;
    }
  });
})();
