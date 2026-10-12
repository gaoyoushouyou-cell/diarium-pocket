/*
 * Diarium Pocket — 画面。
 *
 * 書いた記録はまずこの端末の「未送信」に入り(オフラインでも保存できる)、
 * 送れるときに OneDrive へ1件1ファイルで送る(日記宛ては inbox/、タスクは tasks/)。
 * 送れたら端末から本文・写真を消し、「送った記録」には日付と種類だけを残す。
 *
 * 逆向きに、PC(ランチャー)が書いた outbox/pocket_today.json(予定・タスク・勉強時間・
 * プロジェクトの前線・睡眠の数字)を読んで「やること」「勉強」「プロジェクト」「生活」タブに出す。
 * 読めたものは端末にしまうので、電波が無いときやサインインが切れているときも、前回の内容を表示できる。
 *
 * タブ(2026-10-12 に「今日」を分けた): アイデア(タスク追加・メモ追記)/ やること(予定・タスク。見るだけ)/
 * 勉強(勉強時間・ルーティン)/ プロジェクト(前線。見るだけ)/ 日記(日記・写真は別々に送る)/ 生活(睡眠・家計簿)。
 * 「送る」はヘッダーのボタンから開く。使い方の説明は各カードの「?」の中にだけ置く。
 *
 * 可用性のための方針:
 *  - どの通信が失敗しても、書く・保存する・前回の情報を見ることは止めない。
 *  - 写真は大きいので localStorage ではなく IndexedDB に置く(使えない端末では写真だけ無効)。
 *  - 1件が送れなくても(写真が消えていた等)、ほかの記録は送る。
 */
(function () {
  "use strict";

  const C = window.PocketCore;
  const A = window.PocketAuth;
  const APP_VERSION = "2026-10-12.1";

  const KEYS = {
    queue: "pocket.queue",
    sent: "pocket.sent",
    draft: "pocket.draft.entry",
    prefs: "pocket.prefs",
    outbox: "pocket.outbox",
    outboxCheckedAt: "pocket.outbox.checkedAt",
    memoDraft: "pocket.draft.memo",
    // 勉強時間: 送った記録の控え(日付と分と ID だけ。PC の集計に入るまで数字に足すため。14日で消す)と計測中の状態
    studyLocal: "pocket.study.local",
    studyTimer: "pocket.study.timer",
    // ルーティン: 送った「やった」の控え(プロジェクト・名前・日付・ID だけ。PC の集計に入るまで点に足すため。14日で消す)
    routineLocal: "pocket.routine.local",
  };
  const TABS = ["idea", "todo", "study", "project", "entry", "life", "send"];
  // 以前の版のタブ名 → 今のタブ(と切り替えの側)
  const OLD_TABS = { today: ["todo"], memo: ["idea", "memo"], sleep: ["life", "sleep"], money: ["life", "money"] };
  const MAX_SENT_LOG = 30;
  const OUTBOX_REFRESH_MS = 10 * 60 * 1000;
  const DRAFT_PHOTO_KEY = "draft-photo";
  const WEEK = "日月火水木金土";

  // ---------- 端末内の保存(使えない端末でも落ちないように) ----------
  let storageOk = true;
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      storageOk = false;
      return false;
    }
  }
  function drop(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  }

  // ---------- 写真の置き場 ----------
  // iPhone の Safari(とくにホーム画面から開いたアプリ)は、IndexedDB に Blob を
  // そのまま入れると失敗したり、読み出すと空になったりすることがある。
  // そこで画像は ArrayBuffer にしてから入れ、入れた直後に読み戻して大きさを確かめる。
  // それでもだめなら localStorage に base64 で入れる(縮小後の写真は数百KBなので入る)。
  const Photos = (function () {
    const LS_PREFIX = "pocket.photo.";
    let dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) { reject(new Error("IndexedDB がありません")); return; }
        const req = indexedDB.open("pocket", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("blobs");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB を開けません"));
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }
    async function run(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("blobs", mode);
        const req = fn(tx.objectStore("blobs"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("保存を中止しました"));
      });
    }
    async function toBuffer(blob) {
      if (blob.arrayBuffer) return blob.arrayBuffer();
      return new Response(blob).arrayBuffer();
    }
    async function idbGet(key) {
      const v = await run("readonly", (s) => s.get(key));
      if (!v) return null;
      if (v instanceof Blob) return v.size ? v : null; // 以前の版で入れた形
      if (v.buf) return new Blob([v.buf], { type: v.type || "image/jpeg" });
      return null;
    }
    async function idbPut(key, blob) {
      const buf = await toBuffer(blob);
      await run("readwrite", (s) => s.put({ type: blob.type || "image/jpeg", buf }, key));
      const back = await idbGet(key);
      if (!back || back.size !== blob.size) throw new Error("読み戻した写真の大きさが一致しません");
    }
    function lsGet(key) {
      try {
        const v = JSON.parse(localStorage.getItem(LS_PREFIX + key) || "null");
        if (!v || !v.b64) return null;
        const bin = atob(v.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: v.type || "image/jpeg" });
      } catch (_) {
        return null;
      }
    }
    function lsDel(key) {
      try { localStorage.removeItem(LS_PREFIX + key); } catch (_) { /* noop */ }
    }
    return {
      /** 保存して、どこに入れたか("idb" / "local")を返す。どこにも入らなければ例外。 */
      async put(key, blob) {
        try {
          await idbPut(key, blob);
          lsDel(key);
          return "idb";
        } catch (_) {
          try { await run("readwrite", (s) => s.delete(key)); } catch (__) { /* noop */ }
          const b64 = await blobToBase64(blob);
          try {
            localStorage.setItem(LS_PREFIX + key, JSON.stringify({ type: blob.type || "image/jpeg", b64 }));
            return "local";
          } catch (__) {
            throw new Error("写真をこの端末に保存できませんでした(空き容量を確認してください)。");
          }
        }
      },
      async get(key) {
        let blob = null;
        try { blob = await idbGet(key); } catch (_) { blob = null; }
        return blob || lsGet(key);
      },
      async del(key) {
        try { await run("readwrite", (s) => s.delete(key)); } catch (_) { /* noop */ }
        lsDel(key);
      },
    };
  })();

  const $ = (id) => document.getElementById(id);
  const today = () => C.localDateStr(new Date());
  const prefs = Object.assign(
    {
      bedTime: "", category: {}, lastTab: "todo", taskCategoryId: null, memoNoteId: null, studyAskDismissed: null,
      seg: { idea: "task", entry: "entry", life: "sleep" },
    },
    load(KEYS.prefs, {}),
  );
  const savePrefs = () => save(KEYS.prefs, prefs);
  const pad = (n) => String(n).padStart(2, "0");

  function shortDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`;
  }

  let toastTimer = null;
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("on"), 2800);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "text") node.textContent = v;
      else if (k === "on") Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => c && node.append(c));
    return node;
  }

  // ---------- タブ ----------
  // 「送る」は下のタブに無いので、開いても prefs.lastTab は変えない(閉じると元のタブに戻る)。
  prefs.seg = Object.assign({ idea: "task", entry: "entry", life: "sleep" }, prefs.seg);
  function currentTab() {
    return TABS.find((t) => !$(`tab-${t}`).hidden) || null;
  }
  function showTab(name) {
    if (OLD_TABS[name]) {
      const [tab, side] = OLD_TABS[name];
      if (side) prefs.seg[tab] = side;
      name = tab;
    }
    if (!TABS.includes(name)) name = "todo";
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    TABS.forEach((t) => ($(`tab-${t}`).hidden = t !== name));
    if (name !== "send") prefs.lastTab = name;
    savePrefs();
    if (name === "todo") todoDay = null; // 開き直したら今日から
    renderTab(name);
    syncSegs();
    window.scrollTo(0, 0);
  }
  function renderTab(name) {
    if (name === "send") renderSend();
    if (name === "idea") { renderTaskCats(); renderMemoTargets(); }
    if (name === "todo") renderTodo();
    if (name === "study") { renderStudy(); renderRoutines(); renderTimer(); }
    if (name === "project") renderFront();
    if (name === "life") renderSleepHistory();
  }
  // PC から届いた情報を使う表示をすべて描き直す(更新で新しい outbox を読んだとき)
  function renderOutboxViews() {
    renderTodo();
    renderStudy();
    renderRoutines();
    renderFront();
    renderTaskCats();
    renderMemoTargets();
    renderSleepHistory();
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("openSend").addEventListener("click", () => showTab("send"));
  $("closeSend").addEventListener("click", () => showTab(prefs.lastTab));

  // ---------- タブの中の切り替え(アイデア: タスク/メモ、日記: 日記/写真、生活: 睡眠/家計簿) ----------
  function syncSegs() {
    Object.keys(prefs.seg).forEach((tab) => {
      const section = $(`tab-${tab}`);
      const side = prefs.seg[tab];
      section.querySelectorAll(".seg.top button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.seg === side)));
      section.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== side));
    });
  }
  Object.keys(prefs.seg).forEach((tab) => {
    $(`tab-${tab}`).querySelectorAll(".seg.top button").forEach((b) => b.addEventListener("click", () => {
      prefs.seg[tab] = b.dataset.seg;
      savePrefs();
      syncSegs();
    }));
  });

  // ---------- 「?」(使い方の説明は押したときだけ出す) ----------
  document.querySelectorAll(".help-btn").forEach((b) => {
    const help = b.closest(".card").querySelector(".help");
    if (!help) return;
    b.addEventListener("click", () => {
      const open = help.hidden;
      help.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
    });
  });

  // ---------- 日付チップ(今日/昨日) ----------
  const dateInputs = { entry: $("entryDate"), sleep: $("sleepDate"), money: $("moneyDate"), study: $("studyDate"), photo: $("photoDate") };
  function setupDateChips(kind, onChange) {
    const input = dateInputs[kind];
    const holder = document.querySelector(`[data-date-chips="${kind}"]`);
    const chips = [
      ["今日", () => today()],
      ["昨日", () => C.addDays(today(), -1)],
    ].map(([label, value]) => {
      const b = el("button", { class: "chip", type: "button", text: label });
      b.addEventListener("click", () => { input.value = value(); sync(); onChange && onChange(); });
      b._value = value;
      return b;
    });
    chips.forEach((c) => holder.append(c));
    function sync() {
      input.max = today();
      chips.forEach((c) => c.setAttribute("aria-pressed", String(c._value() === input.value)));
    }
    input.addEventListener("change", () => { sync(); onChange && onChange(); });
    input.value = today();
    sync();
    return sync;
  }

  // =====================================================================
  // アイデア: タスクの追加
  // =====================================================================
  let taskDue = null; // null | "YYYY-MM-DD"
  const dueChoices = [
    ["期限なし", () => null],
    ["今日", () => today()],
    ["明日", () => C.addDays(today(), 1)],
    ["日付を選ぶ", () => "pick"],
  ];
  const dueChips = dueChoices.map(([label, value]) => {
    const b = el("button", { class: "chip", type: "button", text: label });
    b.addEventListener("click", () => {
      const v = value();
      if (v === "pick") {
        $("taskDueDate").hidden = false;
        $("taskDueDate").min = today();
        if (!$("taskDueDate").value) $("taskDueDate").value = C.addDays(today(), 7);
        taskDue = $("taskDueDate").value;
      } else {
        $("taskDueDate").hidden = true;
        taskDue = v;
      }
      syncDue();
    });
    b._value = value;
    $("taskDue").append(b);
    return b;
  });
  function syncDue() {
    dueChips.forEach((b) => {
      const v = b._value();
      const on = v === "pick" ? !$("taskDueDate").hidden : $("taskDueDate").hidden && v === taskDue;
      b.setAttribute("aria-pressed", String(on));
    });
  }
  $("taskDueDate").addEventListener("change", () => { taskDue = $("taskDueDate").value || null; syncDue(); });
  syncDue();

  // ---------- タスクのカテゴリ(PC から届いた Todo 列の一覧から選ぶ) ----------
  function taskCategories() {
    const ob = outbox();
    return (ob && ob.tasks && Array.isArray(ob.tasks.categories)) ? ob.tasks.categories : [];
  }
  function renderTaskCats() {
    const cats = taskCategories();
    const box = $("taskCats");
    box.replaceChildren();
    $("taskCatsNote").hidden = cats.length > 0;
    if (prefs.taskCategoryId && !cats.some((c) => c.id === prefs.taskCategoryId)) prefs.taskCategoryId = null;
    const choices = [{ id: null, name: "おまかせ" }].concat(cats);
    choices.forEach((c) => {
      const b = el("button", { class: "chip", type: "button", "aria-pressed": String(c.id === prefs.taskCategoryId), text: c.name });
      b.addEventListener("click", () => { prefs.taskCategoryId = c.id; savePrefs(); renderTaskCats(); });
      box.append(b);
    });
  }

  function saveTask() {
    const cat = taskCategories().find((c) => c.id === prefs.taskCategoryId) || null;
    const data = {
      text: $("taskText").value, due_date: taskDue,
      category_id: cat ? cat.id : null, category: cat ? cat.name : null,
    };
    if (!enqueue("task", data, $("taskError"))) return;
    $("taskText").value = "";
    taskDue = null;
    $("taskDueDate").hidden = true;
    syncDue();
    renderTodo();
  }
  $("taskSave").addEventListener("click", saveTask);
  $("taskText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveTask(); }
  });

  function outbox() {
    const data = load(KEYS.outbox, null);
    return data && data.format === "diarium-pocket-outbox" ? data : null;
  }

  function dueBadge(due) {
    if (!due) return null;
    const t = today();
    if (due < t) return el("span", { class: "due over", text: "期限切れ" });
    if (due === t) return el("span", { class: "due today", text: "今日" });
    if (due === C.addDays(t, 1)) return el("span", { class: "due", text: "明日" });
    return el("span", { class: "due", text: shortDate(due) });
  }

  // 項目の先頭の日付(「10/15(木) 」など)。日付はバッジで見せるので、本文からは外す
  function stripLeadDate(text) {
    const s = String(text || "");
    return s.replace(/^\d{1,2}\/\d{1,2}(\([^)]*\))?\s*/, "") || s;
  }

  // 押すと1行に切った文が全文になる
  const toggleOpen = (e) => e.currentTarget.classList.toggle("open");

  // =====================================================================
  // やること(PCから届いた予定とタスク。見るだけ)
  // 予定は7日の帯で日を選び、その日の時間帯(6〜24時)と一覧を出す。タスクは期限で分けて並べる。
  // =====================================================================
  let todoDay = null; // 帯で選んだ日(null なら今日)
  const TL_START = 6 * 60;
  const TL_END = 24 * 60;
  function hmToMin(s) {
    const hm = C.parseHHMM(s);
    return hm ? hm.h * 60 + hm.min : null;
  }
  function planMinutes(item) {
    const a = hmToMin(item.start), b = hmToMin(item.end);
    if (a === null || b === null) return 0;
    return b > a ? b - a : b + 24 * 60 - a;
  }
  const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  function planRow(item, past) {
    const time = item.start ? `${item.start}〜${item.end || ""}` : "時間未定";
    return el("div", { class: "plan", on: { click: toggleOpen } }, [
      el("div", { class: "time", text: time }),
      el("div", { class: "what clip" + (past ? " past" : "") }, [
        document.createTextNode(item.name || "(名前なし)"),
        item.category ? el("span", { class: "cat", text: item.category }) : null,
      ]),
    ]);
  }

  function dayLine(items, isToday) {
    const span = TL_END - TL_START;
    const line = el("div", { class: "tl", role: "img", "aria-label": "その日の時間帯(6時〜24時)" });
    items.forEach((i) => {
      let a = hmToMin(i.start), b = hmToMin(i.end);
      if (a === null) return;
      if (b === null || b <= a) b = TL_END; // 日をまたぐ予定は24時まで
      a = Math.max(TL_START, a);
      b = Math.min(TL_END, b);
      if (b <= a) return;
      line.append(el("i", { class: "blk", style: `left:${(a - TL_START) / span * 100}%;width:${(b - a) / span * 100}%` }));
    });
    const now = nowMinutes();
    if (isToday && now >= TL_START) line.append(el("i", { class: "now", style: `left:${(now - TL_START) / span * 100}%` }));
    const scale = el("div", { class: "tl-scale" }, [6, 9, 12, 15, 18, 21, 24].map((h) => el("span", { text: String(h) })));
    return [line, scale];
  }

  const tstat = (label, n, warn) => el("div", { class: "tstat" + (warn ? " warn" : "") }, [el("small", { text: label }), el("b", { text: String(n) })]);

  function taskRow(x, showDue) {
    const tags = (x.tags || []).length ? el("span", { class: "tg", text: `  ${x.tags.map((g) => "#" + g).join(" ")}` }) : null;
    return el("div", { class: "task", on: { click: toggleOpen } }, [
      x.priority === 3 ? el("span", { class: "prio", text: "!" }) : null,
      el("div", { class: "what clip" }, [document.createTextNode(x.title), tags]),
      showDue ? dueBadge(x.due_date) : null,
    ]);
  }

  function renderTodo() {
    const ob = outbox();
    const t = today();
    const week = $("week"), lineBox = $("dayLine"), plans = $("dayPlans"), tasksBox = $("todoTasks");
    [week, lineBox, plans, tasksBox].forEach((n) => n.replaceChildren());
    $("dayTitle").textContent = "";
    $("dayCount").textContent = "";

    const pendingTasks = queue().filter((r) => r.kind === "task");
    if (pendingTasks.length) {
      tasksBox.append(el("p", { class: "muted", style: "margin:0 0 6px", text: `スマホから送信待ちのタスク ${pendingTasks.length}件` }));
    }

    const fresh = $("freshness").querySelector("span");
    if (!ob) {
      week.hidden = true;
      plans.append(el("p", { class: "muted", text: "PCでランチャーを起動すると、予定とタスクがここに届きます(「送る」でサインインしておいてください)。" }));
      fresh.textContent = "まだPCから受け取っていません";
      $("freshness").classList.remove("stale");
      $("tasksCard").hidden = !pendingTasks.length;
      return;
    }
    $("tasksCard").hidden = false;
    const gen = new Date(ob.generated_at);
    const genLabel = isNaN(gen) ? ob.generated_at : `${gen.getMonth() + 1}/${gen.getDate()} ${pad(gen.getHours())}:${pad(gen.getMinutes())}`;
    const stale = ob.today !== t;
    fresh.textContent = stale ? `PCで ${genLabel} に更新(今日の分ではありません)` : `PCで ${genLabel} に更新`;
    $("freshness").classList.toggle("stale", stale);

    // 予定(今日から先の日だけ。帯で選んだ日を出す)
    const sched = ob.schedule || {};
    const days = sched.available ? (sched.days || []).filter((d) => d.date >= t) : [];
    week.hidden = !days.length;
    if (!sched.available) {
      plans.append(el("p", { class: "muted", text: `予定表を読めませんでした(${sched.reason || "不明"})。` }));
    } else if (!days.length) {
      plans.append(el("p", { class: "muted", text: "今日の予定はまだ届いていません。PCでランチャーを起動してください。" }));
    } else {
      if (!days.some((d) => d.date === todoDay)) todoDay = days[0].date;
      const loadOf = (d) => (d.items || []).reduce((s, i) => s + planMinutes(i), 0);
      const maxLoad = Math.max(60, ...days.map(loadOf));
      days.forEach((d) => {
        const [y, m, dd] = d.date.split("-").map(Number);
        const n = (d.items || []).length;
        const b = el("button", {
          type: "button", class: "day" + (d.date === t ? " is-today" : "") + (n ? "" : " free"),
          "aria-pressed": String(d.date === todoDay), "aria-label": `${shortDate(d.date)} 予定${n}件`,
        }, [
          el("span", { class: "w", text: d.date === t ? "今日" : WEEK[new Date(y, m - 1, dd).getDay()] }),
          el("span", { class: "d", text: String(dd) }),
          el("span", { class: "load" }, [el("i", { style: `width:${Math.round(loadOf(d) / maxLoad * 100)}%` })]),
        ]);
        b.addEventListener("click", () => { todoDay = d.date; renderTodo(); });
        week.append(b);
      });
      const day = days.find((d) => d.date === todoDay);
      const items = day.items || [];
      const isToday = day.date === t;
      $("dayTitle").textContent = isToday ? `今日 ${shortDate(day.date)}` : shortDate(day.date);
      $("dayCount").textContent = items.length ? `${items.length}件` : "";
      lineBox.append(...dayLine(items, isToday));
      if (!items.length) plans.append(el("p", { class: "muted", style: "margin:6px 0 0", text: isToday ? "今日の予定はありません。" : "予定はありません。" }));
      const now = nowMinutes();
      items.forEach((i) => {
        const a = hmToMin(i.start), b = hmToMin(i.end);
        plans.append(planRow(i, isToday && a !== null && b !== null && b > a && b <= now));
      });
    }

    // タスク(期限で分ける)
    const tk = ob.tasks || {};
    if (!tk.available) {
      tasksBox.append(el("p", { class: "muted", text: `カンバンを読めませんでした(${tk.reason || "不明"})。` }));
      return;
    }
    const items = tk.items || [];
    const tomorrow = C.addDays(t, 1);
    const weekEnd = C.addDays(t, 7);
    const overdue = items.filter((x) => x.due_date && x.due_date < t).length;
    tasksBox.append(el("div", { class: "tstats" }, [
      tstat("期限切れ", overdue, overdue > 0),
      tstat("今日", items.filter((x) => x.due_date === t).length),
      tstat("未完了", tk.open_count || 0),
    ]));
    if (!items.length) tasksBox.append(el("p", { class: "muted", style: "margin:4px 0 0", text: "期限の近いタスクはありません。" }));
    const groups = [
      ["期限切れ", (x) => x.due_date && x.due_date < t, false],
      ["今日", (x) => x.due_date === t, false],
      ["明日", (x) => x.due_date === tomorrow, false],
      ["7日以内", (x) => x.due_date && x.due_date > tomorrow && x.due_date <= weekEnd, true],
      ["そのあと・期限なし", () => true, true],
    ];
    const shown = new Set();
    groups.forEach(([label, test, showDue]) => {
      const list = items.filter((x) => !shown.has(x) && test(x));
      if (!list.length) return;
      list.forEach((x) => shown.add(x));
      tasksBox.append(el("div", { class: "grp", text: label }));
      list.forEach((x) => tasksBox.append(taskRow(x, showDue)));
    });
    if (tk.truncated) tasksBox.append(el("p", { class: "muted", text: "ほかにもあります(PCのカンバンで確認できます)。" }));
  }

  // =====================================================================
  // 勉強時間(直近7日・事後報告・計測・昨日の分)  2026-10-06
  // 記録は study/ フォルダへ送る(PC の予定表アプリ・ランチャーが確認なしで取り込む)。
  // 数字は PC から届いた集計(outbox.study)に、まだ PC に届いていない分(端末の控え)を足して出す。
  // 連続日数・ノルマ・未達の赤表示は出さない。
  // =====================================================================
  const STUDY_LOCAL_DAYS = 14;
  const TIMER_NUDGE_MIN = 15;
  const TIMER_LONG_MIN = 180;

  function studyLocal() {
    const list = load(KEYS.studyLocal, []);
    return Array.isArray(list) ? list.filter((r) => r && C.isValidDateStr(r.date) && Number.isInteger(r.minutes)) : [];
  }

  function saveStudy(date, minutes, source, errorEl) {
    const data = { date, minutes };
    if (source === "timer") data.source = "timer";
    const problem = C.validate("study", data, today());
    errorEl.textContent = problem || "";
    if (problem) return false;
    const rec = C.buildRecord("study", data, new Date());
    if (!enqueueRecord(rec, errorEl, { quiet: true })) return false;
    const since = C.addDays(today(), -STUDY_LOCAL_DAYS);
    const list = studyLocal().filter((r) => r.date >= since);
    list.push({ id: rec.id, date, minutes, at: rec.created_at });
    save(KEYS.studyLocal, list);
    toast(`${shortDate(date)} に ${C.formatMinutes(minutes)} を記録しました`);
    renderStudy();
    return true;
  }

  const syncStudyDate = setupDateChips("study", () => {});
  C.STUDY_QUICK_MINUTES.forEach((m) => {
    const b = el("button", { class: "chip", type: "button", text: `+${m}分` });
    b.addEventListener("click", () => saveStudy(dateInputs.study.value, m, null, $("studyError")));
    $("studyQuick").append(b);
  });
  function saveStudyInput() {
    const digits = C.normalizeNumber($("studyMinutes").value);
    if (!digits) { $("studyError").textContent = "分を数字で入力してください。"; return; }
    if (saveStudy(dateInputs.study.value, Number(digits), null, $("studyError"))) $("studyMinutes").value = "";
  }
  $("studySave").addEventListener("click", saveStudyInput);
  $("studyMinutes").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveStudyInput(); }
  });

  // 昨日の分(未報告のときだけ。「あとで」でその日は聞かない)
  [0].concat(C.STUDY_QUICK_MINUTES).forEach((m) => {
    const b = el("button", { class: "chip", type: "button", text: `${m}分` });
    b.addEventListener("click", () => saveStudy(C.addDays(today(), -1), m, null, $("studyError")));
    $("studyAskChips").append(b);
  });
  const askLater = el("button", { class: "chip", type: "button", text: "あとで" });
  askLater.addEventListener("click", () => { prefs.studyAskDismissed = today(); savePrefs(); renderStudy(); });
  $("studyAskChips").append(askLater);

  function renderStudy() {
    const ob = outbox();
    const t = today();
    const st = ob && ob.study;
    const w = C.studyWindow(st, studyLocal(), t, 7);
    $("studyTotal").textContent = w.trackingStart ? C.formatMinutes(w.total) : "まだ記録がありません";
    const parts = [];
    if (w.ratio !== null) parts.push(`勉強できた時間の ${Math.round(w.ratio * 100)}%`);
    if (!ob) parts.push("PCの集計はまだ届いていません");
    else if (st && !st.available) parts.push(`PCの集計を読めませんでした(${st.reason || "不明"})`);
    else if (!st) parts.push("PCを更新すると勉強できた時間も出ます");
    if (w.pending) parts.push(`PCに未反映 ${w.pending}件を含む`);
    $("studyRatio").textContent = parts.join("・");

    const bars = $("studyBars");
    bars.replaceChildren();
    const top = Math.max(60, ...w.days.map((d) => Math.max(d.capacity || 0, d.reported || 0)));
    w.days.forEach((d) => {
      const [y, m, dd] = d.date.split("-").map(Number);
      const full = Math.max(d.capacity || 0, d.reported || 0);
      const track = el("div", { class: "track" + (d.counted ? "" : " off"), style: `height:${Math.max(3, Math.round(full / top * 100))}%` });
      if (d.reported) track.append(el("i", { class: "fill", style: `height:${Math.round(d.reported / full * 100)}%` }));
      const label = d.rest ? "休養" : !d.counted ? "" : d.reported === null ? "—" : `${Math.floor(d.reported / 60)}:${pad(d.reported % 60)}`;
      bars.append(el("div", { class: "sbar" + (d.date === t ? " today" : "") }, [
        el("small", { text: label }), track, el("span", { text: `${WEEK[new Date(y, m - 1, dd).getDay()]}${dd}` }),
      ]));
    });

    $("studyToday").textContent = `今日 ${C.formatMinutes(w.todayReported)}`;

    const y = C.addDays(t, -1);
    const localY = studyLocal().some((r) => r.date === y);
    const obY = st && Array.isArray(st.days) ? st.days.find((d) => d.date === y) : null;
    const reportedY = !!(obY && obY.reported_minutes !== null && obY.reported_minutes !== undefined);
    $("studyAsk").hidden = localY || reportedY || prefs.studyAskDismissed === t;
    $("studyAskText").textContent = `昨日 ${shortDate(y)} は何分勉強しましたか?(0分でも大丈夫です)`;
  }

  // ---------- 計測(開始時刻を端末に置き、差で数える。閉じても・ロックしても狂わない) ----------
  // 2026-10-12 から画面には出さない(#timerBox を hidden のまま)。仕組みと保存済みの状態はそのまま残す。
  let timerTick = null;
  function timerState() { return load(KEYS.studyTimer, null); }
  function clockText(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  function updateTimerRead() {
    const s = timerState();
    if (!s || s.stoppedAt) return;
    const ms = Date.now() - s.startedAt;
    $("timerRead").textContent = clockText(ms);
    $("timerNote").textContent = ms >= TIMER_NUDGE_MIN * 60000
      ? "15分たちました。止めても、続けても大丈夫です。"
      : "まず15分。終わったら「終わる」を押してください。";
  }
  function renderTimer() {
    const s = timerState();
    clearInterval(timerTick);
    timerTick = null;
    const running = !!(s && s.startedAt && !s.stoppedAt);
    if (running && C.elapsedMinutes(s.startedAt, Date.now()) >= TIMER_LONG_MIN) {
      stopTimer(true);   // 止め忘れ: 終わった時刻を聞く
      return;
    }
    const done = !!(s && s.stoppedAt);
    $("timerStart").hidden = !!s;
    $("timerRunning").hidden = !running;
    $("timerDone").hidden = !done;
    $("timerLong").hidden = !(done && s.long);
    if (running) {
      updateTimerRead();
      timerTick = setInterval(updateTimerRead, 1000);
    } else if (done) {
      $("timerRead").textContent = clockText(s.stoppedAt - s.startedAt);
      $("timerNote").textContent = "記録すると送ります。";
    } else {
      $("timerRead").textContent = "0:00";
      $("timerNote").textContent = "計り忘れても大丈夫。あとから上で記録できます。";
    }
  }
  function stopTimer(long) {
    const s = timerState();
    if (!s) return;
    s.stoppedAt = Date.now();
    s.long = !!long;
    save(KEYS.studyTimer, s);
    $("timerMinutes").value = String(C.elapsedMinutes(s.startedAt, s.stoppedAt));
    if (long) {
      const now = new Date();
      $("timerEnd").value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    $("timerError").textContent = "";
    renderTimer();
  }
  $("timerStart").addEventListener("click", () => {
    save(KEYS.studyTimer, { startedAt: Date.now(), date: today() });
    renderTimer();
  });
  $("timerStop").addEventListener("click", () => stopTimer(false));
  $("timerCancel").addEventListener("click", () => {
    if (!confirm("計測をやめますか?(記録はしません)")) return;
    drop(KEYS.studyTimer);
    renderTimer();
  });
  $("timerEnd").addEventListener("change", () => {
    const s = timerState();
    const hm = C.parseHHMM($("timerEnd").value);
    if (!s || !hm) return;
    const start = new Date(s.startedAt);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hm.h, hm.min);
    if (end.getTime() < s.startedAt) end.setDate(end.getDate() + 1);
    s.stoppedAt = Math.min(end.getTime(), Date.now());
    save(KEYS.studyTimer, s);
    $("timerMinutes").value = String(C.elapsedMinutes(s.startedAt, s.stoppedAt));
    renderTimer();
  });
  $("timerSave").addEventListener("click", () => {
    const s = timerState();
    if (!s) return;
    const digits = C.normalizeNumber($("timerMinutes").value);
    if (!digits) { $("timerError").textContent = "分を数字で入力してください。"; return; }
    if (saveStudy(s.date, Number(digits), "timer", $("timerError"))) {
      drop(KEYS.studyTimer);
      renderTimer();
    }
  });
  $("timerDiscard").addEventListener("click", () => {
    if (!confirm("この計測を捨てますか?(記録はしません)")) return;
    drop(KEYS.studyTimer);
    renderTimer();
  });

  // =====================================================================
  // ルーティン(単語・リスニングなど毎日に近いこと。2026-10-07)
  // 「やった」は routine/ フォルダへ送る(PC のカンバン・ランチャー・プロジェクトアプリが確認なしで取り込む)。
  // 見せるのは直近7日の点と「何日」だけ。連続日数・目安・やらなかった日の色は出さない。取り消しは PC(カンバン)で。
  // =====================================================================
  const ROUTINE_LOCAL_DAYS = 14;

  function routineLocal() {
    const list = load(KEYS.routineLocal, []);
    return Array.isArray(list) ? list.filter((r) => r && C.isValidDateStr(r.date) && typeof r.routine === "string") : [];
  }

  function saveRoutine(projectId, key, date) {
    const data = { project: projectId, routine: key, date };
    const problem = C.validate("routine", data, today());
    if (problem) { toast(problem); return false; }
    const rec = C.buildRecord("routine", data, new Date());
    if (!enqueueRecord(rec, { textContent: "" }, { quiet: true })) { toast("端末に保存できませんでした"); return false; }
    const since = C.addDays(today(), -ROUTINE_LOCAL_DAYS);
    const list = routineLocal().filter((r) => r.date >= since);
    list.push({ id: rec.id, project: projectId, routine: key, date, at: rec.created_at });
    save(KEYS.routineLocal, list);
    toast(`${date === today() ? "今日" : shortDate(date)}の「${key}」を記録しました`);
    renderRoutines();
    return true;
  }

  // 勉強タブの「ルーティン」カード。ルーティンのあるプロジェクトごとに並べる
  function renderRoutines() {
    const box = $("routineList");
    box.replaceChildren();
    const ob = outbox();
    const fr = ob && ob.front;
    const lanes = (fr && fr.available && Array.isArray(fr.lanes) ? fr.lanes : [])
      .filter((ln) => Array.isArray(ln.routines) && ln.routines.some((v) => v && v.key));
    $("routineCard").hidden = !lanes.length;
    const t = today();
    const recordIds = (fr && fr.routine_record_ids) || [];
    lanes.forEach((ln) => {
      box.append(el("div", { class: "rt-proj", text: ln.title || "(無題)" }));
      ln.routines.forEach((v) => {
        if (!v || !v.key) return;
        const w = C.routineWindow(ln.id, v, routineLocal(), recordIds, t, 7);
        const dots = el("span", { class: "rt-dots", "aria-label": `直近7日で${w.count}日` },
          w.days.map((d) => el("i", { class: d.done ? "on" : "", text: d.done ? "●" : "・" })));
        const btn = el("button", {
          class: "chip rt-btn", type: "button", text: w.todayDone ? "✓ 今日" : "今日やった",
          "aria-pressed": w.todayDone ? "true" : "false",
        });
        if (w.todayDone) btn.disabled = true;
        else btn.addEventListener("click", () => saveRoutine(ln.id, v.key, t));
        box.append(el("div", { class: "rt-row" }, [
          el("div", { class: "rt-name" }, [el("b", { text: v.key }), v.text ? el("small", { class: "muted", text: v.text }) : null]),
          dots, el("span", { class: "muted rt-count", text: `${w.count}日` }), btn,
        ]));
        if (!w.yesterdayDone) {
          const y = C.addDays(t, -1);
          const yb = el("button", { class: "rt-y", type: "button", text: `昨日 ${shortDate(y)} もやった` });
          yb.addEventListener("click", () => saveRoutine(ln.id, v.key, y));
          box.append(yb);
        }
        if (w.pending) box.append(el("div", { class: "muted rt-note", text: `PCに未反映 ${w.pending}件を含む` }));
      });
    });
  }

  // =====================================================================
  // プロジェクト(進行中のプロジェクトの一番手前の項目。見るだけ)
  // 1件1行(名前・一番手前の期日・進み具合・一番手前の項目)。一番手前の期日が近い順。
  // 押すと系列ごとの一番手前と次の項目を開く。
  // =====================================================================
  const openLanes = new Set();

  // 一番手前の項目(系列があれば、待ちでない系列の一番手前のうち期日の最も早いもの)
  function laneFront(ln) {
    const branches = Array.isArray(ln.branches) ? ln.branches : [];
    const fronts = branches.length > 1
      ? branches.filter((b) => !b.waiting_for && b.front).map((b) => b.front)
      : (ln.front ? [ln.front] : []);
    const dated = fronts.filter((f) => f.date).sort((a, b) => a.date.localeCompare(b.date));
    return dated[0] || fronts[0] || null;
  }

  // 期日のバッジ(過ぎていても責めない色で)
  function frontBadge(date) {
    if (!date) return null;
    const t = today();
    if (date < t) return el("span", { class: "late", text: `${shortDate(date)}・過ぎ` });
    if (date === t) return el("span", { class: "due soon", text: "今日" });
    if (date === C.addDays(t, 1)) return el("span", { class: "due", text: "明日" });
    return el("span", { class: "due", text: shortDate(date) });
  }

  const laneName = (ln) => (ln.title || "(無題)").replace(/^\d+年[春夏秋冬]\s+/, "");

  function laneBody(ln) {
    const body = el("div", { class: "pj-body" });
    const branches = Array.isArray(ln.branches) ? ln.branches : [];
    const frontLine = (it) => el("div", { class: "br-front" }, [el("span", { text: stripLeadDate(it.text) }), frontBadge(it.date)]);
    if (ln.kind === "明文化") {
      body.append(el("div", { class: "br" }, [el("div", { class: "br-front" }, [el("span", { text: `次の一歩: ${ln.next_step || "(まだありません)"}` })])]));
    } else if (branches.length > 1) {
      branches.forEach((b) => {
        const kids = [el("div", { class: "br-h" }, [
          el("span", {}, [el("b", { text: b.name }), b.ahead ? el("span", { class: "ahead", text: "先取り" }) : null]),
          el("span", { class: "prog", text: `${b.done}/${b.total}` }),
        ])];
        if (b.waiting_for) kids.push(el("div", { class: "br-next", text: `「${stripLeadDate(b.waiting_for)}」が済んだら始まります` }));
        else if (b.front) {
          kids.push(frontLine(b.front));
          (b.next || []).slice(0, 1).forEach((n) => kids.push(el("div", { class: "br-next", text: `次: ${stripLeadDate(n.text)}` })));
        } else kids.push(el("div", { class: "br-next", text: "この系列はすべて済み" }));
        body.append(el("div", { class: "br" }, kids));
      });
    } else if (ln.front) {
      const kids = [frontLine(ln.front)];
      (ln.next || []).forEach((n) => kids.push(el("div", { class: "br-next", text: `次: ${stripLeadDate(n.text)}` })));
      body.append(el("div", { class: "br" }, kids));
    } else {
      body.append(el("div", { class: "br-next", text: "すべて終わりました。" }));
    }
    return body;
  }

  function renderFront() {
    const box = $("frontList");
    box.replaceChildren();
    $("frontTitle").textContent = "進行中のプロジェクト";
    const ob = outbox();
    const fr = ob && ob.front;
    if (!ob) {
      box.append(el("p", { class: "muted", text: "PCでランチャーを起動すると、各プロジェクトの次の項目がここに届きます。" }));
      return;
    }
    if (!fr || !fr.available) {
      box.append(el("p", { class: "muted", text: `プロジェクトを読めませんでした(${(fr && fr.reason) || "PCのアプリが古いかもしれません"})。` }));
      return;
    }
    const lanes = Array.isArray(fr.lanes) ? fr.lanes : [];
    if (!lanes.length) box.append(el("p", { class: "muted", text: "進行中のプロジェクトはありません。" }));
    else $("frontTitle").textContent = `進行中のプロジェクト ${lanes.length}件`;
    // 一番手前の期日が近い順(期日の無いものは後ろ。同じなら PC の順のまま)
    const rows = lanes.map((ln) => ({ ln, f: laneFront(ln) })).sort((a, b) => {
      const da = a.f && a.f.date, db = b.f && b.f.date;
      if (da && db) return da.localeCompare(db);
      return da ? -1 : db ? 1 : 0;
    });
    rows.forEach(({ ln, f }) => {
      const key = ln.id || ln.title;
      const branches = Array.isArray(ln.branches) ? ln.branches : [];
      let item;
      if (ln.kind === "明文化") item = `次の一歩: ${ln.next_step || "(まだありません)"}`;
      else if (f) item = stripLeadDate(f.text) + (branches.length > 1 ? `  ほか${branches.length - 1}系列` : "");
      else item = "すべて終わりました。";
      const open = openLanes.has(key);
      const node = el("div", { class: "pj" + (open ? " open" : "") });
      const row = el("button", { class: "pj-row", type: "button", "aria-expanded": String(open) }, [
        el("span", { class: "pj-name clip", text: laneName(ln) }),
        el("span", { class: "pj-meta" }, [
          f ? frontBadge(f.date) : null,
          ln.total ? el("span", { class: "prog", text: `${ln.done}/${ln.total}` }) : null,
          el("span", { class: "caret", "aria-hidden": "true", text: "▶" }),
        ]),
        el("span", { class: "pj-item clip", text: item }),
      ]);
      row.addEventListener("click", () => {
        if (openLanes.has(key)) openLanes.delete(key); else openLanes.add(key);
        renderFront();
      });
      node.append(row);
      if (open) node.append(laneBody(ln));
      box.append(node);
    });
  }

  // ---------- PC から届いた情報を読む ----------
  let outboxBusy = false;
  async function refreshOutbox(interactive) {
    if (outboxBusy) return;
    const st = A.status();
    if (st.state === "unconfigured") { if (interactive) toast("OneDriveの設定がまだです"); return; }
    if (st.state !== "signed-in") {
      if (interactive) await A.signIn("refresh");
      return;
    }
    if (!navigator.onLine) { if (interactive) toast("オフラインです。前回の情報を表示しています"); return; }
    outboxBusy = true;
    $("refreshOutbox").textContent = "更新中…";
    try {
      const r = await A.downloadOutbox();
      save(KEYS.outboxCheckedAt, Date.now());
      if (r.ok && r.data && r.data.format === "diarium-pocket-outbox") {
        save(KEYS.outbox, r.data);
        renderOutboxViews();
        if (interactive) toast("PCの最新の情報にしました");
      } else if (r.reason === "missing") {
        if (interactive) toast("PCからまだ届いていません。ランチャーを起動してください");
      } else if (r.reason === "need-sign-in") {
        if (interactive) await A.signIn("refresh");
      } else if (interactive) {
        toast("更新できませんでした。前回の情報を表示しています");
      }
    } catch (_) {
      if (interactive) toast("更新できませんでした。前回の情報を表示しています");
    } finally {
      outboxBusy = false;
      $("refreshOutbox").textContent = "更新";
    }
  }
  $("refreshOutbox").addEventListener("click", () => refreshOutbox(true));

  function refreshOutboxIfOld() {
    const last = Number(load(KEYS.outboxCheckedAt, 0)) || 0;
    if (Date.now() - last > OUTBOX_REFRESH_MS && A.status().state === "signed-in" && navigator.onLine) {
      refreshOutbox(false);
    }
  }

  // =====================================================================
  // 日記
  // =====================================================================
  let entryMood = null;
  const entryTags = new Set();
  const moodButtons = C.MOODS.map((m) => {
    const b = el("button", { class: "mood", type: "button", "aria-pressed": "false", "aria-label": m.name },
      [el("span", { text: m.emoji }), el("span", { text: m.name })]);
    b.addEventListener("click", () => { entryMood = m.key; syncMoods(); saveDraft(); });
    $("moods").append(b);
    return b;
  });
  const tagButtons = C.THEME_TAGS.map((tag) => {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": "false", text: tag });
    b.addEventListener("click", () => {
      if (entryTags.has(tag)) entryTags.delete(tag); else entryTags.add(tag);
      syncTags();
      saveDraft();
    });
    $("entryTags").append(b);
    return b;
  });
  function syncMoods() {
    moodButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(C.MOODS[i].key === entryMood)));
  }
  function syncTags() {
    tagButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(entryTags.has(C.THEME_TAGS[i]))));
  }
  function saveDraft() {
    save(KEYS.draft, { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value, tags: [...entryTags] });
  }
  function updateCounter() {
    const n = $("entryText").value.trim().length;
    $("entryCounter").textContent = `${n} / ${C.MAX_TEXT_LENGTH}`;
    $("entryCounter").style.color = n > C.MAX_TEXT_LENGTH ? "var(--danger)" : "";
  }
  const syncEntryDate = setupDateChips("entry", saveDraft);
  $("entryText").addEventListener("input", () => { updateCounter(); saveDraft(); });
  (function restoreDraft() {
    const d = load(KEYS.draft, null);
    if (!d) return;
    if (d.date && C.isValidDateStr(d.date) && d.date <= today()) dateInputs.entry.value = d.date;
    entryMood = d.mood || null;
    $("entryText").value = d.text || "";
    (d.tags || []).forEach((t) => { if (C.THEME_TAGS.includes(t)) entryTags.add(t); });
    syncEntryDate();
    syncMoods();
    syncTags();
    updateCounter();
  })();

  let entrySaving = false;
  $("entrySave").addEventListener("click", () => {
    if (entrySaving) return;
    entrySaving = true;
    try { saveEntry(); } finally { entrySaving = false; }
  });

  function saveEntry() {
    const data = { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value, tags: [...entryTags] };
    if (!enqueue("entry", data, $("entryError"), { quiet: true })) return;
    toast("日記を保存しました");
    entryMood = null;
    entryTags.clear();
    $("entryText").value = "";
    drop(KEYS.draft);
    dateInputs.entry.value = today();
    syncEntryDate();
    syncMoods();
    syncTags();
    updateCounter();
  }

  // =====================================================================
  // 写真(2026-10-12 から日記とは別に送る。1日1枚。選んだらすぐ縮小して、下書きとして端末にしまう)
  // PC の日記アプリは写真を日記とは別の表に持つので、その日の日記が無くても取り込める。
  // =====================================================================
  let draftPhoto = null;
  let previewUrl = null;
  function showPhoto(blob) {
    draftPhoto = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    $("photoPreview").hidden = !blob;
    $("photoRemove").hidden = !blob;
    if (blob) $("photoPreview").src = previewUrl; else $("photoPreview").removeAttribute("src");
    $("photoPick").textContent = blob ? "📷 写真を変える" : "📷 写真を選ぶ";
  }

  async function shrinkPhoto(file) {
    const MAX = 1600;
    let source;
    let w;
    let h;
    try {
      source = await createImageBitmap(file);
      w = source.width;
      h = source.height;
    } catch (_) {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("この画像は読み込めませんでした。"));
        img.src = URL.createObjectURL(file);
      });
      w = source.naturalWidth;
      h = source.naturalHeight;
    }
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("写真を変換できませんでした。");
    return blob;
  }

  const syncPhotoDate = setupDateChips("photo");
  $("photoPick").addEventListener("click", () => $("photoInput").click());
  // 写真の縮小が終わる前に「送る」を押されても写真が抜け落ちないよう、処理中の約束を覚えておく
  let photoPending = null;
  $("photoInput").addEventListener("change", () => {
    const file = $("photoInput").files && $("photoInput").files[0];
    $("photoInput").value = "";
    if (!file) return;
    $("photoError").textContent = "";
    $("photoPick").textContent = "📷 小さくしています…";
    const job = (async () => {
      try {
        const blob = await shrinkPhoto(file);
        showPhoto(blob);
        try { await Photos.put(DRAFT_PHOTO_KEY, blob); } catch (_) { /* 下書きに残せなくても、このまま送れる */ }
      } catch (e) {
        showPhoto(draftPhoto);
        $("photoError").textContent = e.message || "写真を読み込めませんでした。";
      }
    })();
    photoPending = job;
    job.finally(() => { if (photoPending === job) photoPending = null; });
  });
  $("photoRemove").addEventListener("click", () => { showPhoto(null); Photos.del(DRAFT_PHOTO_KEY); });

  let photoSaving = false;
  $("photoSave").addEventListener("click", async () => {
    if (photoSaving) return;
    photoSaving = true;
    const label = $("photoSave").textContent;
    try {
      if (photoPending) {
        $("photoSave").textContent = "写真を準備しています…";
        $("photoSave").disabled = true;
        await photoPending;
      }
      await savePhoto();
    } finally {
      photoSaving = false;
      $("photoSave").textContent = label;
      $("photoSave").disabled = false;
    }
  });

  async function savePhoto() {
    const photo = draftPhoto;
    const data = { date: dateInputs.photo.value, mime: "image/jpeg", size: photo ? photo.size : 0 };
    const problem = C.validate("photo", data, today());
    $("photoError").textContent = problem || "";
    if (problem) return;
    // 写真を先に端末へしまう。しまえなければ送らず、選んだ写真は残したまま知らせる
    const rec = C.buildRecord("photo", data, new Date());
    try {
      await Photos.put(rec.id, photo);
    } catch (e) {
      $("photoError").textContent = `${e.message} もう一度お試しください。`;
      return;
    }
    if (!enqueueRecord(rec, $("photoError"), { quiet: true })) {
      Photos.del(rec.id);
      return;
    }
    toast(`${shortDate(data.date)} の写真を保存しました`);
    Photos.del(DRAFT_PHOTO_KEY);
    showPhoto(null);
    dateInputs.photo.value = today();
    syncPhotoDate();
  }

  // =====================================================================
  // メモ(既存のメモを選んで追記する)
  // =====================================================================
  function memoNotes() {
    const ob = outbox();
    return (ob && ob.memos && ob.memos.available && Array.isArray(ob.memos.notes)) ? ob.memos.notes : [];
  }
  function renderMemoTargets() {
    const notes = memoNotes();
    const sel = $("memoTarget");
    sel.replaceChildren();
    if (!notes.length) {
      sel.append(el("option", { value: "", text: "(メモの一覧がまだ届いていません)" }));
      sel.disabled = true;
      $("memoTargetNote").textContent = "PCでランチャーを起動すると、メモアプリのメモから選べるようになります。";
      $("memoTargetNote").hidden = false;
      $("memoListAt").textContent = "";
      $("memoSave").disabled = true;
      return;
    }
    $("memoTargetNote").hidden = true;
    sel.disabled = false;
    $("memoSave").disabled = false;
    if (!notes.some((n) => n.id === prefs.memoNoteId)) prefs.memoNoteId = notes[0].id;
    notes.forEach((n) => {
      const tags = (n.tags || []).length ? `  ${n.tags.map((t) => "#" + t).join(" ")}` : "";
      const opt = el("option", { value: n.id, text: (n.title || "(タイトルなし)") + tags });
      if (n.id === prefs.memoNoteId) opt.selected = true;
      sel.append(opt);
    });
    const ob = outbox();
    const gen = ob ? new Date(ob.generated_at) : null;
    $("memoListAt").textContent = gen && !isNaN(gen)
      ? ` メモの一覧は PCで ${gen.getMonth() + 1}/${gen.getDate()} ${pad(gen.getHours())}:${pad(gen.getMinutes())} に書き出したものです(「やること」の「更新」で最新に)。`
      : "";
  }
  $("memoTarget").addEventListener("change", () => { prefs.memoNoteId = $("memoTarget").value || null; savePrefs(); });
  function updateMemoCounter() {
    const n = $("memoText").value.trim().length;
    $("memoCounter").textContent = `${n} / ${C.MAX_MEMO_TEXT}`;
    $("memoCounter").style.color = n > C.MAX_MEMO_TEXT ? "var(--danger)" : "";
  }
  $("memoText").addEventListener("input", () => {
    updateMemoCounter();
    save(KEYS.memoDraft, $("memoText").value);
  });
  $("memoText").value = load(KEYS.memoDraft, "") || "";
  updateMemoCounter();
  $("memoSave").addEventListener("click", () => {
    const note = memoNotes().find((n) => n.id === $("memoTarget").value);
    const data = { note_id: note ? note.id : "", note_title: note ? note.title : "", text: $("memoText").value };
    if (!enqueue("memo", data, $("memoError"))) return;
    $("memoText").value = "";
    drop(KEYS.memoDraft);
    updateMemoCounter();
  });

  // =====================================================================
  // 睡眠
  // =====================================================================
  let quality = null;
  const qualityButtons = C.SLEEP_QUALITY.map((q) => {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": "false", text: `${q.emoji} ${q.name}` });
    b.addEventListener("click", () => { quality = quality === q.value ? null : q.value; syncQuality(); });
    $("quality").append(b);
    return b;
  });
  function syncQuality() {
    qualityButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(C.SLEEP_QUALITY[i].value === quality)));
  }
  function updateDuration() {
    const m = C.sleepMinutes(dateInputs.sleep.value, $("bedTime").value, $("wakeTime").value);
    $("sleepDuration").textContent = m === null ? "—" : C.formatMinutes(m);
  }
  const syncSleepDate = setupDateChips("sleep", updateDuration);
  $("bedTime").value = prefs.bedTime || "";
  ["bedTime", "wakeTime"].forEach((id) => ["input", "change"].forEach((ev) => $(id).addEventListener(ev, updateDuration)));
  $("wakeNow").addEventListener("click", () => {
    const now = new Date();
    $("wakeTime").value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    dateInputs.sleep.value = today();
    syncSleepDate();
    updateDuration();
  });
  $("sleepSave").addEventListener("click", () => {
    const data = {
      date: dateInputs.sleep.value, bed_time: $("bedTime").value, wake_time: $("wakeTime").value, quality,
    };
    if (!enqueue("sleep", data, $("sleepError"))) return;
    prefs.bedTime = data.bed_time;
    savePrefs();
    $("wakeTime").value = "";
    quality = null;
    syncQuality();
    updateDuration();
  });

  function renderSleepHistory() {
    const box = $("sleepHistory");
    box.replaceChildren();
    const ob = outbox();
    const sl = ob && ob.sleep;
    if (!sl) {
      box.append(el("p", { class: "muted", text: "PCでランチャーを起動すると、最近の睡眠と今夜の目安がここに届きます。" }));
      return;
    }
    if (!sl.available) {
      box.append(el("p", { class: "muted", text: `日記を読めませんでした(${sl.reason || "不明"})。` }));
      return;
    }
    const byDate = {};
    (sl.nights || []).forEach((n) => { byDate[n.date] = n; });
    const t = today();
    const dates = Array.from({ length: 7 }, (_, i) => C.addDays(t, i - 6));
    const top = Math.max(600, ...Object.values(byDate).map((n) => n.minutes || 0));
    const target = sl.target_minutes || 450;
    const bars = el("div", { class: "bars", role: "img", "aria-label": "直近7日の睡眠時間" });
    dates.forEach((d) => {
      const n = byDate[d];
      const [y, m, dd] = d.split("-").map(Number);
      const h = n ? Math.max(3, Math.round((n.minutes / top) * 100)) : 3;
      const bar = el("i", { class: n ? (n.minutes < target ? "short" : "") : "none", style: `height:${h}%` });
      bars.append(el("div", { class: "bar", title: n ? `${n.bed_time} → ${n.wake_time}` : "記録なし" }, [
        el("small", { text: n ? `${Math.floor(n.minutes / 60)}:${pad(n.minutes % 60)}` : "" }),
        bar,
        el("span", { text: `${WEEK[new Date(y, m - 1, dd).getDay()]}${dd}` }),
      ]));
    });
    box.append(bars);
    const parts = [];
    if (sl.avg_minutes) parts.push(`平均 ${C.formatMinutes(sl.avg_minutes)}`);
    if (sl.target_hit_rate !== null && sl.target_hit_rate !== undefined) parts.push(`目標達成 ${sl.target_hit_rate}%`);
    if (sl.regularity) parts.push(`起床のばらつき: ${sl.regularity}`);
    box.append(el("p", { class: "muted", style: "margin:6px 0 0", text: parts.join("・") || "まだ記録がありません。" }));
    if (sl.suggested_bedtime) {
      box.append(el("p", { style: "margin:8px 0 0" }, [
        document.createTextNode("今夜の目安: "),
        el("b", { text: `${sl.suggested_bedtime} ごろに布団へ` }),
        el("span", { class: "muted", text: `(${sl.target_wake} 起床・${C.formatMinutes(target)} の目標から)` }),
      ]));
    }
    if (ob.today !== t) box.append(el("p", { class: "muted", style: "margin:6px 0 0", text: "※ 今日より前にPCで書き出した情報です。" }));
  }

  // =====================================================================
  // 家計簿
  // =====================================================================
  let moneyKind = "expense";
  let category = null;
  function renderMoney() {
    document.querySelectorAll("#moneyKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === moneyKind)));
    const cats = moneyKind === "expense" ? C.EXPENSE_CATEGORIES : C.INCOME_CATEGORIES;
    const quick = moneyKind === "expense" ? C.EXPENSE_QUICK_AMOUNTS : C.INCOME_QUICK_AMOUNTS;
    if (!cats.some(([n]) => n === category)) category = prefs.category[moneyKind] || null;
    $("cats").replaceChildren(...cats.map(([name, emoji]) => {
      const b = el("button", { class: "chip", type: "button", "aria-pressed": String(name === category), text: `${emoji} ${name}` });
      b.addEventListener("click", () => { category = name; renderMoney(); });
      return b;
    }));
    $("quick").replaceChildren(...quick.map((v) => {
      const b = el("button", { class: "chip", type: "button", text: `+${v.toLocaleString("ja-JP")}` });
      b.addEventListener("click", () => {
        const cur = Number(C.normalizeNumber($("amount").value) || 0);
        $("amount").value = String(cur + v);
      });
      return b;
    }));
  }
  document.querySelectorAll("#moneyKind button").forEach((b) =>
    b.addEventListener("click", () => { moneyKind = b.dataset.kind; category = null; renderMoney(); }));
  const syncMoneyDate = setupDateChips("money");
  renderMoney();
  $("moneySave").addEventListener("click", () => {
    const digits = C.normalizeNumber($("amount").value);
    const data = {
      date: dateInputs.money.value, amount: digits ? Number(digits) : 0, category, memo: $("memo").value,
    };
    if (!enqueue(moneyKind, data, $("moneyError"))) return;
    prefs.category[moneyKind] = category;
    savePrefs();
    $("amount").value = "";
    $("memo").value = "";
    dateInputs.money.value = today();
    syncMoneyDate();
  });

  // =====================================================================
  // 未送信キュー
  // =====================================================================
  function queue() { return load(KEYS.queue, []); }
  const recDate = (r) => r.data.date || String(r.created_at).slice(0, 10);
  const folderFor = (r) => C.folderFor(r.kind);

  function enqueueRecords(records, errorEl) {
    const q = queue();
    q.push(...records);
    if (!save(KEYS.queue, q)) {
      errorEl.textContent = "この端末に保存できませんでした。ストレージの空きを確認してください。";
      return false;
    }
    updateBadge();
    trySendQuietly();
    return true;
  }

  function enqueueRecord(record, errorEl, opts) {
    if (!enqueueRecords([record], errorEl)) return false;
    if (!(opts && opts.quiet)) toast(`${C.KIND_LABELS[record.kind]}を保存しました`);
    return true;
  }

  function enqueue(kind, data, errorEl, opts) {
    const problem = C.validate(kind, data, today());
    errorEl.textContent = problem || "";
    if (problem) return false;
    return enqueueRecord(C.buildRecord(kind, data, new Date()), errorEl, opts);
  }

  function removeFromQueue(ids) {
    const set = new Set(ids);
    const q = queue();
    q.filter((r) => set.has(r.id) && r.kind === "photo").forEach((r) => Photos.del(r.id));
    save(KEYS.queue, q.filter((r) => !set.has(r.id)));
  }

  function markSent(records, via) {
    if (!records.length) return;
    const log = load(KEYS.sent, []);
    const at = C.isoWithOffset(new Date());
    records.forEach((r) => log.unshift({ kind: r.kind, date: recDate(r), sent_at: at, via }));
    save(KEYS.sent, log.slice(0, MAX_SENT_LOG));
    removeFromQueue(records.map((r) => r.id));
    updateBadge();
  }

  function updateBadge() {
    const n = queue().length;
    $("badge").textContent = String(n);
    $("badge").classList.toggle("on", n > 0);
    updatePill();
  }

  function updatePill() {
    // 未送信の件数は「送る」ボタンのバッジに出すので、ここには困ったときだけ出す
    const pill = $("netPill");
    const n = queue().length;
    pill.hidden = false;
    pill.className = "pill warn";
    if (!storageOk) { pill.textContent = "端末に保存できません"; return; }
    if (!navigator.onLine) { pill.textContent = "オフライン"; return; }
    if (n && lastProblems.length) { pill.textContent = "送れない記録あり"; return; }
    pill.hidden = true;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** 送るファイルの中身。写真は端末にしまってある画像をここで base64 にして入れる。 */
  async function fileTextFor(r) {
    if (r.kind !== "photo") return C.serialize(r);
    let blob = null;
    try { blob = await Photos.get(r.id); } catch (_) { blob = null; }
    if (!blob) throw new Error("写真のデータがこの端末に見つかりません(削除してください)");
    const b64 = await blobToBase64(blob);
    return C.serialize(Object.assign({}, r, { data: { date: r.data.date, mime: r.data.mime, b64 } }));
  }

  // ---------- 送信 ----------
  let sending = false;
  let sendAgain = false; // 送信中に新しい記録が入ったら、終わってからもう一度送る
  let lastProblems = [];
  async function sendAll(interactive) {
    if (sending) { sendAgain = true; return; }
    sendAgain = false;
    const items = queue();
    if (!items.length) { if (interactive) toast("送る記録はありません"); return; }
    if (!A.isConfigured()) { if (interactive) toast("OneDriveの設定がまだです。共有シートで保存してください"); return; }
    if (!navigator.onLine) { if (interactive) toast("オフラインです。電波が戻ったら送ります"); return; }
    sending = true;
    $("sendError").textContent = "";
    $("sendAll").disabled = true;
    const done = [];
    const problems = [];
    try {
      for (const r of items) {
        let text;
        try {
          text = await fileTextFor(r);
        } catch (e) {
          problems.push(`${C.KIND_LABELS[r.kind]}(${recDate(r)}): ${e.message}`);
          continue; // この1件だけ飛ばして、ほかは送る
        }
        let result;
        try {
          result = await A.upload(C.fileName(r), text, folderFor(r));
        } catch (e) {
          problems.push(e.message || "送れませんでした。");
          break; // 通信の問題はほかの記録でも起きるので、いったん止める
        }
        if (result === "need-sign-in") {
          if (interactive) {
            markSent(done, "onedrive");
            await A.signIn("send");
            return;
          }
          break;
        }
        done.push(r);
      }
    } finally {
      sending = false;
      $("sendAll").disabled = false;
    }
    if (done.length) {
      markSent(done, "onedrive");
      toast(`${done.length}件をOneDriveへ送りました`);
    }
    lastProblems = problems;
    $("sendError").textContent = problems.join("\n");
    updatePill();
    if (problems.length && !interactive) setTimeout(() => toast("送れなかった記録があります(上の「送る」で確認できます)"), 2900);
    if (sendAgain) {
      sendAgain = false;
      setTimeout(() => sendAll(false), 0);
    }
    if (!$("tab-send").hidden) renderSend();
    if (currentTab() === "todo") renderTodo();
  }

  function trySendQuietly() {
    const st = A.status();
    if (st.state === "signed-in" && navigator.onLine) sendAll(false);
  }

  async function shareAll() {
    const items = queue();
    if (!items.length) { toast("送る記録はありません"); return; }
    const files = [];
    const ok = [];
    for (const r of items) {
      try {
        files.push(new File([await fileTextFor(r)], C.fileName(r), { type: "application/json" }));
        ok.push(r);
      } catch (e) {
        $("sendError").textContent = e.message;
      }
    }
    if (!files.length) return;
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
      } catch (e) {
        if (e && e.name === "AbortError") return;
        $("sendError").textContent = "共有できませんでした。";
        return;
      }
    } else {
      // 共有シートの無い環境(PCのブラウザ等)ではダウンロードにする
      files.forEach((f) => {
        const a = el("a", { href: URL.createObjectURL(f), download: f.name });
        document.body.append(a);
        a.click();
        a.remove();
      });
    }
    if (confirm(`OneDrive の for_me_read/inbox フォルダに ${ok.length}件 保存できましたか?\n「OK」で送信済みにします(端末から本文を消します)。`)) {
      markSent(ok, "share");
      renderSend();
    }
  }

  $("sendAll").addEventListener("click", () => sendAll(true));
  $("shareAll").addEventListener("click", shareAll);

  function renderSend() {
    const st = A.status();
    const acc = $("account");
    acc.replaceChildren();
    if (st.state === "unconfigured") {
      acc.append(el("p", { class: "muted", text: "OneDriveへ直接送る設定(クライアントID)がまだです。それまでは下の「共有シート」から OneDrive の inbox フォルダに保存できます。" }));
    } else if (st.state === "signed-in") {
      const until = new Date(st.until);
      acc.append(
        el("p", { class: "muted", text: `サインイン中(${until.getMonth() + 1}/${until.getDate()} ${pad(until.getHours())}:${pad(until.getMinutes())} まで)。保存するとすぐ送ります。` }),
        el("button", { class: "ghost", type: "button", text: "サインアウト", on: { click: () => { A.signOut(); renderSend(); } } }),
      );
    } else {
      acc.append(
        el("p", { class: "muted", text: st.state === "expired" ? "サインインの期限が切れました(24時間ごと)。送るときにもう一度サインインします。" : "OneDriveへ送るには、Microsoftアカウントでサインインします。" }),
        el("button", { class: "ghost", type: "button", text: "Microsoftでサインイン", on: { click: () => A.signIn(null) } }),
      );
    }
    const q = queue();
    const list = $("queue");
    list.replaceChildren();
    if (!q.length) list.append(el("p", { class: "muted", text: "ありません。" }));
    q.forEach((r) => {
      list.append(el("div", { class: "queue-item" }, [
        el("div", { text: C.KIND_EMOJI[r.kind] || "・" }),
        el("div", { class: "body" }, [
          el("div", { text: (r.kind === "task" || r.kind === "memo") ? `${C.KIND_LABELS[r.kind]}(${recDate(r)}に書いたもの)` : `${C.KIND_LABELS[r.kind]}・${recDate(r)}` }),
          el("div", { text: C.summarize(r) }),
        ]),
        el("button", {
          class: "x", type: "button", text: "削除", "aria-label": "この記録を削除",
          on: { click: () => { if (confirm("この記録を削除しますか?(元に戻せません)")) { removeFromQueue([r.id]); updateBadge(); renderSend(); } } },
        }),
      ]));
    });
    $("sendError").textContent = lastProblems.join("\n");
    $("sendAll").disabled = !q.length || st.state === "unconfigured";
    $("shareAll").disabled = !q.length;
    const sent = load(KEYS.sent, []);
    $("sent").replaceChildren(...(sent.length ? sent.slice(0, 10).map((s) => {
      const at = s.sent_at.slice(5, 16).replace("-", "/").replace("T", " ");
      const what = (s.kind === "task" || s.kind === "memo") ? C.KIND_LABELS[s.kind] : `${C.KIND_LABELS[s.kind] || s.kind}(${s.date}の分)`;
      return el("div", { text: `${at} ${C.KIND_EMOJI[s.kind] || ""} ${what}${s.via === "share" ? "・共有シート" : ""}` });
    }) : [el("span", { text: "まだありません。" })]));
    $("redirectUri").textContent = A.redirectUri();
    $("version").textContent = `版: ${APP_VERSION}`;
    updatePill();
  }

  // =====================================================================
  // 起動
  // =====================================================================
  window.addEventListener("online", () => { updatePill(); trySendQuietly(); refreshOutboxIfOld(); });
  window.addEventListener("offline", updatePill);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    [syncEntryDate, syncSleepDate, syncMoneyDate, syncStudyDate, syncPhotoDate].forEach((f) => f());
    const tab = currentTab();
    if (tab && tab !== "send") renderTab(tab);
    trySendQuietly();
    refreshOutboxIfOld();
    checkForUpdate();
  });

  // ---------- 新しい版の受け取り ----------
  // 新しい版のサービスワーカーが入ったら、一度だけ読み直して新しい版に切り替える
  // (最初に入れたとき=前の版が無いときは読み直さない)。
  let swRegistration = null;
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => { swRegistration = reg; }).catch(() => {});
  }
  function checkForUpdate() {
    if (swRegistration && navigator.onLine) swRegistration.update().catch(() => {});
  }

  (async function boot() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    registerServiceWorker();
    updateBadge();
    // 写真が使えない端末(IndexedDB 無し)では、写真のボタンだけ使えなくする
    Photos.get(DRAFT_PHOTO_KEY).then((blob) => { if (blob) showPhoto(blob); }).catch(() => { /* 読めなくても続ける */ });
    const r = await A.handleRedirect();
    if (r.handled) {
      if (r.error) { showTab("send"); $("sendError").textContent = r.error; return; }
      toast("サインインしました");
      if (r.afterAction === "send") { showTab("send"); await sendAll(true); refreshOutbox(false); return; }
      if (r.afterAction === "refresh") { showTab("todo"); await refreshOutbox(true); trySendQuietly(); return; }
      showTab("send");
      refreshOutbox(false);
      return;
    }
    showTab(prefs.lastTab);
    trySendQuietly();
    refreshOutboxIfOld();
  })();

  // 検証用(画面には影響しない)
  window.__pocket = {
    queue, version: APP_VERSION, photos: Photos, fileTextFor, renderTodo, renderOutboxViews, renderSleepHistory, refreshOutbox,
    showTab, renderRoutines,
    enqueue: (k, d) => enqueue(k, d, { textContent: "" }),
    studyLocal, saveStudy: (d, m, s) => saveStudy(d, m, s, { textContent: "" }), renderStudy, renderTimer,
    renderFront, timerState, stopTimer, routineLocal, saveRoutine,
  };
})();
