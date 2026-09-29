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
  const APP_VERSION = "2026-09-29.2";

  const KEYS = {
    queue: "pocket.queue",
    sent: "pocket.sent",
    draft: "pocket.draft.entry",
    prefs: "pocket.prefs",
    outbox: "pocket.outbox",
    outboxCheckedAt: "pocket.outbox.checkedAt",
  };
  const TABS = ["today", "entry", "sleep", "money", "send"];
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

  // ---------- 写真の置き場(IndexedDB) ----------
  const Photos = (function () {
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
    return {
      put: (key, blob) => run("readwrite", (s) => s.put(blob, key)),
      get: (key) => run("readonly", (s) => s.get(key)),
      del: (key) => run("readwrite", (s) => s.delete(key)).catch(() => {}),
      available: () => open().then(() => true, () => false),
    };
  })();

  const $ = (id) => document.getElementById(id);
  const today = () => C.localDateStr(new Date());
  const prefs = Object.assign({ bedTime: "", category: {}, lastTab: "today" }, load(KEYS.prefs, {}));
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
    if (name === "today") renderToday();
    if (name === "sleep") renderSleepHistory();
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

  function saveTask() {
    const data = { text: $("taskText").value, due_date: taskDue };
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
  $("photoInput").addEventListener("change", async () => {
    const file = $("photoInput").files && $("photoInput").files[0];
    $("photoInput").value = "";
    if (!file) return;
    $("entryError").textContent = "";
    $("photoPick").textContent = "📷 小さくしています…";
    try {
      const blob = await shrinkPhoto(file);
      showPhoto(blob);
      try { await Photos.put(DRAFT_PHOTO_KEY, blob); } catch (_) { /* 下書きに残せなくても、このまま保存はできる */ }
    } catch (e) {
      showPhoto(draftPhoto);
      $("entryError").textContent = e.message || "写真を読み込めませんでした。";
    }
  });
  $("photoRemove").addEventListener("click", () => { showPhoto(null); Photos.del(DRAFT_PHOTO_KEY); });

  $("entrySave").addEventListener("click", async () => {
    const data = { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value, tags: [...entryTags] };
    const photo = draftPhoto;
    if (photo) {
      const problem = C.validate("photo", { date: data.date, mime: "image/jpeg", size: photo.size }, today());
      if (problem) { $("entryError").textContent = problem; return; }
    }
    if (!enqueue("entry", data, $("entryError"), { quiet: !!photo })) return;
    if (photo) {
      const rec = C.buildRecord("photo", { date: data.date, mime: "image/jpeg", size: photo.size }, new Date());
      try {
        await Photos.put(rec.id, photo);
        enqueueRecord(rec, $("entryError"), { quiet: true });
        toast("日記と写真を保存しました");
      } catch (_) {
        toast("日記は保存しました。写真はこの端末に保存できませんでした");
      }
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
  const folderFor = (r) => (r.kind === "task" ? "tasks" : "inbox");

  function enqueueRecord(record, errorEl, opts) {
    const q = queue();
    q.push(record);
    if (!save(KEYS.queue, q)) {
      errorEl.textContent = "この端末に保存できませんでした。ストレージの空きを確認してください。";
      return false;
    }
    updateBadge();
    if (!(opts && opts.quiet)) toast(`${C.KIND_LABELS[record.kind]}を保存しました`);
    trySendQuietly();
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
    pill.textContent = n ? `未送信 ${n}` : "すべて送信済み";
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
  async function sendAll(interactive) {
    if (sending) return;
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
    if (problems.length) $("sendError").textContent = problems.join("\n");
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
          el("div", { text: r.kind === "task" ? `${C.KIND_LABELS[r.kind]}(${recDate(r)}に追加)` : `${C.KIND_LABELS[r.kind]}・${recDate(r)}` }),
          el("div", { text: C.summarize(r) }),
        ]),
        el("button", {
          class: "x", type: "button", text: "削除", "aria-label": "この記録を削除",
          on: { click: () => { if (confirm("この記録を削除しますか?(元に戻せません)")) { removeFromQueue([r.id]); updateBadge(); renderSend(); } } },
        }),
      ]));
    });
    $("sendAll").disabled = !q.length || st.state === "unconfigured";
    $("shareAll").disabled = !q.length;
    const sent = load(KEYS.sent, []);
    $("sent").replaceChildren(...(sent.length ? sent.slice(0, 10).map((s) => {
      const at = s.sent_at.slice(5, 16).replace("-", "/").replace("T", " ");
      const what = s.kind === "task" ? "タスク" : `${C.KIND_LABELS[s.kind] || s.kind}(${s.date}の分)`;
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
  });

  (async function boot() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    updateBadge();
    // 写真が使えない端末(IndexedDB 無し)では、写真のボタンだけ使えなくする
    Photos.available().then(async (ok) => {
      if (!ok) {
        $("photoPick").disabled = true;
        $("photoNote").textContent = "この端末では写真を保存できないため、写真は添えられません。";
        return;
      }
      try {
        const blob = await Photos.get(DRAFT_PHOTO_KEY);
        if (blob) showPhoto(blob);
      } catch (_) { /* 下書きの写真が読めなくても続ける */ }
    });
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
