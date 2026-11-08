"use strict";

(() => {
  if (!db) return;
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

  let currentUser = null;
  let scheduleData = new Map();
  let currentDates = [];
  let loadingVersion = 0;
  let loadingSchedule = false;
  let deletingSchedule = false;

  function showSchedulePage(pageId) {
    showPage(pageId);
  }

  function showScheduleMessage(text) {
    $("schedule-message").textContent = text;
  }

  function createElement(tag, text, className = "") {
    const el = document.createElement(tag);

    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;

    return el;
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function parseDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function getDateRange(start, end) {
    const first = parseDate(start);
    const last = parseDate(end);

    if (
      Number.isNaN(first.getTime()) ||
      Number.isNaN(last.getTime())
    ) {
      throw new Error("日付を正しく入力してください。");
    }

    if (first > last) {
      throw new Error("終了日は開始日以降にしてください。");
    }

    const dates = [];
    const current = new Date(first);

    while (current <= last) {
      dates.push(formatDate(current));
      current.setDate(current.getDate() + 1);

      if (dates.length > 31) {
        throw new Error("表示期間は31日以内にしてください。");
      }
    }

    return dates;
  }

  function scheduleKey(date, slot) {
    return `${date}|${slot}`;
  }

  async function getCurrentUser() {
    const { data, error } = await db.auth.getUser();

    if (error) throw error;
    if (!data.user) throw new Error("ログインしてください。");

    currentUser = data.user;
    return currentUser;
  }

  function setDefaultDates() {
    const today = new Date();
    const end = new Date(today);

    end.setDate(end.getDate() + 6);

    $("start-date").value = formatDate(today);
    $("end-date").value = formatDate(end);
  }

  async function openSchedule() {
    showSchedulePage("schedule-section");
    if (deletingSchedule) return;
    if (CircleSave.pending('schedule:')) {
      showScheduleMessage('未保存の変更があります。再保存してください。');
      return;
    }
    setDefaultDates();
    $("schedule-results").hidden = true;

    await loadSchedule();
  }

  $("open-schedule-button").addEventListener(
    "click",
    openSchedule
  );

  $("date-range-form").addEventListener(
    "submit",
    async event => {
      event.preventDefault();
      await loadSchedule();
    }
  );

  async function loadSchedule() {
    if (deletingSchedule) return;
    if (CircleSave.pending('schedule:')) {
      showScheduleMessage('未保存の変更があります。再保存してから期間を変更してください。');
      return;
    }
    const version = ++loadingVersion;
    loadingSchedule = true;
    $('schedule-table').querySelectorAll('button').forEach(button => { button.disabled = true; });

    const start = $("start-date").value;
    const end = $("end-date").value;

    showScheduleMessage("スケジュールを読み込み中...");

    try {
      const dates = getDateRange(start, end);
      const user = await getCurrentUser();

      const { data, error } = await db
        .from("schedules")
        .select("schedule_date, slot, available")
        .eq("user_id", user.id)
        .gte("schedule_date", start)
        .lte("schedule_date", end);

      if (error) throw error;
      if (version !== loadingVersion) return;

      currentDates = dates;
      scheduleData = new Map();

      for (const row of data || []) {
        const date = String(row.schedule_date).slice(0, 10);

        scheduleData.set(
          scheduleKey(date, Number(row.slot)),
          row.available === true
        );
      }

      renderSchedule();

      $("selected-range").textContent = `${start} ～ ${end}`;
      $("schedule-results").hidden = false;

      showScheduleMessage("");
    } catch (error) {
      if (version === loadingVersion) {
        $("schedule-results").hidden = true;
        showScheduleMessage("読み込みエラー：" + error.message);
      }
    } finally {
      if (version === loadingVersion) {
        loadingSchedule = false;
        $('schedule-table').querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    }
  }

  function renderSchedule() {
    const table = $("schedule-table");
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");

    thead.replaceChildren();
    tbody.replaceChildren();

    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

    // 横方向：8つの時間帯
    const headerRow = document.createElement("tr");
    headerRow.appendChild(createElement("th", "日付"));

    for (const slot of SLOTS) {
      const heading = createElement('th', slot <= 5 ? SLOT_LABELS[slot] : `${slot + 12}:00`);
      heading.title = SLOT_LABELS[slot];
      headerRow.appendChild(heading);
    }

    thead.appendChild(headerRow);

    // 縦方向：日付
    for (const date of currentDates) {
      const row = document.createElement("tr");
      const parsed = parseDate(date);

      const dateLabel =
        `${parsed.getMonth() + 1}/${parsed.getDate()}` +
        `(${weekdays[parsed.getDay()]})`;

      row.appendChild(createElement("th", dateLabel));

      for (const slot of SLOTS) {
        const td = document.createElement("td");
        const key = scheduleKey(date, slot);

        const available = scheduleData.get(key) === true;

        const cellButton = createElement(
          "button",
          available ? "○" : "ー",
          available ? "slot-button yes" : "slot-button"
        );

        cellButton.type = "button";

        cellButton.setAttribute(
          "aria-label",
          `${date} ${SLOT_LABELS[slot]}：` +
          (available ? "参加可能" : "参加不可")
        );

        cellButton.addEventListener("click", () => {
          toggleSchedule(date, slot, cellButton);
        });

        td.appendChild(cellButton);
        row.appendChild(td);
      }

      tbody.appendChild(row);
    }
  }

  async function toggleSchedule(date, slot, cellButton) {
    if (loadingSchedule || deletingSchedule) return;
    const user = currentUser;

    if (!user) {
      showScheduleMessage("ログイン情報がありません。");
      return;
    }

    const key = scheduleKey(date, slot);
    const oldValue = scheduleData.get(key) === true;
    const newValue = !oldValue;

    scheduleData.set(key, newValue);
    cellButton.textContent = newValue ? '○' : 'ー';
    cellButton.classList.toggle('yes', newValue);
    cellButton.setAttribute('aria-label', `${date} ${SLOT_LABELS[slot]}：${newValue ? '参加可能' : '参加不可'}`);
    CircleSave.put(`schedule:${user.id}:${key}`, newValue, async value => {
      if (currentUser?.id !== user.id) throw Error('ログインし直してください');
      const {error} = await db.rpc('ui_schedule_save', {p_date:date,p_slot:slot,p_available:value});
      if (error) throw error;
    }, (status,error) => {
      if (currentUser?.id !== user.id) return;
      cellButton.dataset.saveState = error ? 'error' : status === '保存済み' ? 'saved' : 'saving';
      showScheduleMessage(status + (error ? `：${error.message}` : CircleSave.pending('schedule:') ? '（未保存のセルあり）' : ''));
    });
  }

  const retry = createElement('button','再保存','secondary-button');
  retry.type='button';retry.addEventListener('click',()=>CircleSave.retry('schedule:'));
  $('schedule-message').after(retry);

  const deleteAll = createElement('button','入力した日程をすべて削除','danger-button');
  deleteAll.id='schedule-delete-all';
  deleteAll.type='button';
  deleteAll.style.display='block';
  deleteAll.addEventListener('click',async()=>{
    if (deletingSchedule) return;
    if (CircleSave.pending('schedule:')) {
      showScheduleMessage('未保存の変更があります。再保存してから削除してください。');
      return;
    }
    if (!confirm('表示期間外も含め、入力したすべての日程を削除します。元に戻せません。削除しますか？')) return;
    const version=++loadingVersion;
    deletingSchedule=true;
    deleteAll.disabled=true;
    retry.disabled=true;
    $('schedule-table').querySelectorAll('button').forEach(button=>{button.disabled=true;});
    showScheduleMessage('日程を削除中...');
    try {
      await getCurrentUser();
      if (version!==loadingVersion) return;
      const {error}=await db.rpc('ui_schedule_delete_all');
      if (error) throw error;
      if (version!==loadingVersion) return;
      scheduleData.clear();
      renderSchedule();
      showScheduleMessage('入力した日程をすべて削除しました。');
    } catch(error) {
      if (version===loadingVersion) showScheduleMessage('削除エラー：'+error.message);
    } finally {
      if (version===loadingVersion) {
        deletingSchedule=false;
        loadingSchedule=false;
        deleteAll.disabled=false;
        retry.disabled=false;
        $('schedule-table').querySelectorAll('button').forEach(button=>{button.disabled=false;});
      }
    }
  });
  retry.after(deleteAll);

  db.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") {
      loadingVersion++;
      loadingSchedule = false;
      deletingSchedule = false;
      deleteAll.disabled = false;
      retry.disabled = false;
      currentUser = null;
      scheduleData.clear();
      currentDates = [];

      $("schedule-section").hidden = true;
      $("schedule-results").hidden = true;
    }
  });
})();
