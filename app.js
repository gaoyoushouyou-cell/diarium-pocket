/*
 * Diarium Pocket — 画面。
 *
 * 書いた記録はまずこの端末の「未送信」に入り(オフラインでも保存できる)、
 * 送れるときに OneDrive へ1件1ファイルで送る(日記宛ては inbox/、タスクは tasks/)。
 * 送れたら端末から本文・写真を消し、「送った記録」には日付と種類だけを残す。
 *
 * 逆向きに、PC(ランチャー)が書いた outbox/pocket_today.json(今日の予定・タスク・
 * 睡眠の数字)を読んで「今日」「睡眠」タブに出す。読めたものは端末にしまうので、
 * 電波が無いときやサインインが切れているときも、前回の内容を表示できる。
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
  const APP_VERSION = "2026-09-30.2";

  const KEYS = {
    queue: "pocket.queue",
    sent: "pocket.sent",
    draft: "pocket.draft.entry",
    prefs: "pocket.prefs",
    outbox: "pocket.outbox",
    outboxCheckedAt: "pocket.outbox.checkedAt",
    memoDraft: "pocket.draft.memo",
  };
  const TABS = ["today", "entry", "memo", "sleep", "money", "send"];
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
    { bedTime: "", category: {}, lastTab: "today", taskCategoryId: null, memoNoteId: null },
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
  function showTab(name) {
    if (!TABS.includes(name)) name = "today";
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    TABS.forEach((t) => ($(`tab-${t}`).hidden = t !== name));
    prefs.lastTab = name;
    savePrefs();
    if (name === "send") renderSend();
    if (name === "today") { renderToday(); renderTaskCats(); }
    if (name === "sleep") renderSleepHistory();
    if (name === "memo") renderMemoTargets();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- 日付チップ(今日/昨日) ----------
  const dateInputs = { entry: $("entryDate"), sleep: $("sleepDate"), money: $("moneyDate") };
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
  // 今日(タスクの追加・PCから届いた予定とやること)
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
    renderToday();
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

  function planRow(item) {
    const time = item.start ? `${item.start}〜${item.end || ""}` : "時間未定";
    return el("div", { class: "plan" }, [
      el("div", { class: "time", text: time }),
      el("div", { class: "what" }, [
        document.createTextNode(item.name || "(名前なし)"),
        item.category ? el("span", { class: "cat", text: item.category }) : null,
      ]),
    ]);
  }

  function renderToday() {
    const ob = outbox();
    const t = today();
    $("todayTitle").textContent = `今日の予定 ${shortDate(t)}`;
    const plans = $("todayPlans");
    const tasksBox = $("todayTasks");
    const upcoming = $("upcoming");
    plans.replaceChildren();
    tasksBox.replaceChildren();
    upcoming.replaceChildren();

    const pendingTasks = queue().filter((r) => r.kind === "task");
    if (pendingTasks.length) {
      tasksBox.append(el("p", { class: "muted", text: `スマホから送信待ちのタスク ${pendingTasks.length}件(「送る」タブ)` }));
    }

    const fresh = $("freshness").querySelector("span");
    if (!ob) {
      plans.append(el("p", { class: "muted", text: "PCでランチャーを起動すると、今日の予定とやることがここに届きます(「送る」タブでサインインしておいてください)。" }));
      fresh.textContent = "まだPCから受け取っていません";
      $("freshness").classList.remove("stale");
      $("upcomingCard").hidden = true;
      $("tasksCard").hidden = !pendingTasks.length;
      return;
    }
    $("tasksCard").hidden = false;
    const gen = new Date(ob.generated_at);
    const genLabel = isNaN(gen) ? ob.generated_at : `${gen.getMonth() + 1}/${gen.getDate()} ${pad(gen.getHours())}:${pad(gen.getMinutes())}`;
    const stale = ob.today !== t;
    fresh.textContent = stale ? `PCで ${genLabel} に更新(今日の分ではありません)` : `PCで ${genLabel} に更新`;
    $("freshness").classList.toggle("stale", stale);

    // 予定
    const sched = ob.schedule || {};
    if (!sched.available) {
      plans.append(el("p", { class: "muted", text: `予定表を読めませんでした(${sched.reason || "不明"})。` }));
      $("upcomingCard").hidden = true;
    } else {
      const days = sched.days || [];
      const day = days.find((d) => d.date === t);
      if (!day) {
        plans.append(el("p", { class: "muted", text: "今日の予定はまだ届いていません。PCでランチャーを起動してください。" }));
      } else if (!day.items.length) {
        plans.append(el("p", { class: "muted", text: "今日の予定はありません。" }));
      } else {
        day.items.forEach((i) => plans.append(planRow(i)));
      }
      const later = days.filter((d) => d.date > t);
      $("upcomingCard").hidden = !later.length;
      const busy = later.filter((d) => d.items.length);
      if (!busy.length) upcoming.append(el("p", { class: "muted", text: "これからの予定はありません。" }));
      busy.forEach((d) => {
        upcoming.append(el("div", { class: "day-h", text: shortDate(d.date) }));
        d.items.forEach((i) => upcoming.append(planRow(i)));
      });
      const free = later.filter((d) => !d.items.length).map((d) => shortDate(d.date));
      if (free.length && busy.length) upcoming.append(el("p", { class: "muted", style: "margin:10px 0 0", text: `予定のない日: ${free.join("・")}` }));
    }

    // やること
    const tk = ob.tasks || {};
    if (!tk.available) {
      tasksBox.append(el("p", { class: "muted", text: `カンバンを読めませんでした(${tk.reason || "不明"})。` }));
      return;
    }
    const overdue = (tk.items || []).filter((x) => x.due_date && x.due_date < t).length;
    const dueToday = (tk.items || []).filter((x) => x.due_date === t).length;
    tasksBox.append(el("div", { class: "stat" }, [
      el("span", {}, [document.createTextNode("未完了 "), el("b", { text: String(tk.open_count || 0) })]),
      el("span", {}, [document.createTextNode("期限切れ "), el("b", { text: String(overdue) })]),
      el("span", {}, [document.createTextNode("今日 "), el("b", { text: String(dueToday) })]),
    ]));
    if (!(tk.items || []).length) {
      tasksBox.append(el("p", { class: "muted", text: "期限の近いタスクはありません。" }));
    }
    (tk.items || []).forEach((x) => {
      tasksBox.append(el("div", { class: "task" }, [
        x.priority === 3 ? el("span", { class: "prio", text: "!" }) : null,
        el("div", { class: "what", text: x.title + ((x.tags || []).length ? `  ${x.tags.map((g) => "#" + g).join(" ")}` : "") }),
        dueBadge(x.due_date),
      ]));
    });
    if (tk.truncated) tasksBox.append(el("p", { class: "muted", text: "ほかにもあります(PCのカンバンで確認できます)。" }));
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
        renderToday();
        renderTaskCats();
        renderMemoTargets();
        renderSleepHistory();
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

  // ---------- 写真(1日1枚。選んだらすぐ縮小して、下書きとして端末にしまう) ----------
  let draftPhoto = null;
  let previewUrl = null;
  function showPhoto(blob) {
    draftPhoto = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    $("photoPreview").hidden = !blob;
    $("photoRemove").hidden = !blob;
    if (blob) $("photoPreview").src = previewUrl; else $("photoPreview").removeAttribute("src");
    $("photoPick").textContent = blob ? "📷 写真を変える" : "📷 写真をそえる";
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

  $("photoPick").addEventListener("click", () => $("photoInput").click());
  // 写真の縮小が終わる前に「保存」を押されても写真が抜け落ちないよう、処理中の約束を覚えておく
  let photoPending = null;
  $("photoInput").addEventListener("change", () => {
    const file = $("photoInput").files && $("photoInput").files[0];
    $("photoInput").value = "";
    if (!file) return;
    $("entryError").textContent = "";
    $("photoPick").textContent = "📷 小さくしています…";
    const job = (async () => {
      try {
        const blob = await shrinkPhoto(file);
        showPhoto(blob);
        try { await Photos.put(DRAFT_PHOTO_KEY, blob); } catch (_) { /* 下書きに残せなくても、このまま保存はできる */ }
      } catch (e) {
        showPhoto(draftPhoto);
        $("entryError").textContent = e.message || "写真を読み込めませんでした。";
      }
    })();
    photoPending = job;
    job.finally(() => { if (photoPending === job) photoPending = null; });
  });
  $("photoRemove").addEventListener("click", () => { showPhoto(null); Photos.del(DRAFT_PHOTO_KEY); });

  let entrySaving = false;
  $("entrySave").addEventListener("click", async () => {
    if (entrySaving) return;
    entrySaving = true;
    const label = $("entrySave").textContent;
    try {
      if (photoPending) {
        $("entrySave").textContent = "写真を準備しています…";
        $("entrySave").disabled = true;
        await photoPending;
      }
      await saveEntry();
    } finally {
      entrySaving = false;
      $("entrySave").textContent = label;
      $("entrySave").disabled = false;
    }
  });

  async function saveEntry() {
    const data = { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value, tags: [...entryTags] };
    const photo = draftPhoto;
    if (photo) {
      const problem = C.validate("photo", { date: data.date, mime: "image/jpeg", size: photo.size }, today());
      if (problem) { $("entryError").textContent = problem; return; }
    }
    const entryProblem = C.validate("entry", data, today());
    if (entryProblem) { $("entryError").textContent = entryProblem; return; }
    let photoRec = null;
    if (photo) {
      // 写真を先に端末へしまう。しまえなければ日記も保存せず、写真を残したまま知らせる
      photoRec = C.buildRecord("photo", { date: data.date, mime: "image/jpeg", size: photo.size }, new Date());
      try {
        await Photos.put(photoRec.id, photo);
      } catch (e) {
        $("entryError").textContent = `${e.message} 日記はまだ保存していません。写真を外すか、もう一度お試しください。`;
        return;
      }
    }
    // 日記と写真を同じ回で送れるよう、両方をキューに入れてから送信を始める
    const records = [C.buildRecord("entry", data, new Date())];
    if (photoRec) records.push(photoRec);
    if (!enqueueRecords(records, $("entryError"))) {
      if (photoRec) Photos.del(photoRec.id);
      return;
    }
    toast(photoRec ? "日記と写真を保存しました" : "日記を保存しました");
    if (photo) {
      Photos.del(DRAFT_PHOTO_KEY);
      showPhoto(null);
    }
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
      $("memoSave").disabled = true;
      return;
    }
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
    $("memoTargetNote").textContent = gen && !isNaN(gen)
      ? `メモの一覧: PCで ${gen.getMonth() + 1}/${gen.getDate()} ${pad(gen.getHours())}:${pad(gen.getMinutes())} に更新(「今日」タブの「更新」で最新に)`
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
    const pill = $("netPill");
    const n = queue().length;
    if (!storageOk) { pill.textContent = "端末に保存できません"; pill.className = "pill warn"; return; }
    if (!navigator.onLine) { pill.textContent = n ? `オフライン・未送信 ${n}` : "オフライン"; pill.className = "pill warn"; return; }
    pill.textContent = n ? (lastProblems.length ? `送れない記録あり・未送信 ${n}` : `未送信 ${n}`) : "すべて送信済み";
    pill.className = n ? "pill warn" : "pill";
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
    if (problems.length && !interactive) setTimeout(() => toast("送れなかった記録があります(「送る」タブで確認できます)"), 2900);
    if (sendAgain) {
      sendAgain = false;
      setTimeout(() => sendAll(false), 0);
    }
    if (!$("tab-send").hidden) renderSend();
    if (!$("tab-today").hidden) renderToday();
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
    [syncEntryDate, syncSleepDate, syncMoneyDate].forEach((f) => f());
    if (!$("tab-today").hidden) renderToday();
    if (!$("tab-sleep").hidden) renderSleepHistory();
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
      if (r.afterAction === "refresh") { showTab("today"); await refreshOutbox(true); trySendQuietly(); return; }
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
    queue, version: APP_VERSION, photos: Photos, fileTextFor, renderToday, renderSleepHistory, refreshOutbox,
    enqueue: (k, d) => enqueue(k, d, { textContent: "" }),
  };
})();
