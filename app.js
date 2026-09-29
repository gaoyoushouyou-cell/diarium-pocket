/*
 * Diarium Pocket — 画面。
 *
 * 書いた記録はまずこの端末の「未送信」に入り(オフラインでも保存できる)、
 * 送れるときに OneDrive の inbox/ へ1件1ファイルで送る。送れたら端末から
 * 本文を消し、「送った記録」には日付と種類だけを残す。
 */
(function () {
  "use strict";

  const C = window.PocketCore;
  const A = window.PocketAuth;
  const APP_VERSION = "2026-09-29.1";

  const KEYS = {
    queue: "pocket.queue",
    sent: "pocket.sent",
    draft: "pocket.draft.entry",
    prefs: "pocket.prefs",
  };
  const MAX_SENT_LOG = 30;

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

  const $ = (id) => document.getElementById(id);
  const today = () => C.localDateStr(new Date());
  const prefs = Object.assign({ bedTime: "", category: {}, lastTab: "entry" }, load(KEYS.prefs, {}));
  const savePrefs = () => save(KEYS.prefs, prefs);

  let toastTimer = null;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 2600);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "text") node.textContent = v;
      else if (k === "on") Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.append(c));
    return node;
  }

  // ---------- タブ ----------
  function showTab(name) {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    ["entry", "sleep", "money", "send"].forEach((t) => ($(`tab-${t}`).hidden = t !== name));
    prefs.lastTab = name;
    savePrefs();
    if (name === "send") renderSend();
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

  // ---------- 日記 ----------
  let entryMood = null;
  const moodButtons = C.MOODS.map((m) => {
    const b = el("button", { class: "mood", type: "button", "aria-pressed": "false", "aria-label": m.name },
      [el("span", { text: m.emoji }), el("span", { text: m.name })]);
    b.addEventListener("click", () => { entryMood = m.key; syncMoods(); saveDraft(); });
    $("moods").append(b);
    return b;
  });
  function syncMoods() {
    moodButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(C.MOODS[i].key === entryMood)));
  }
  function saveDraft() {
    save(KEYS.draft, { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value });
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
    syncEntryDate();
    syncMoods();
    updateCounter();
  })();
  $("entrySave").addEventListener("click", () => {
    const data = { date: dateInputs.entry.value, mood: entryMood, text: $("entryText").value };
    if (!enqueue("entry", data, $("entryError"))) return;
    entryMood = null;
    $("entryText").value = "";
    try { localStorage.removeItem(KEYS.draft); } catch (_) { /* noop */ }
    dateInputs.entry.value = today();
    syncEntryDate();
    syncMoods();
    updateCounter();
  });

  // ---------- 睡眠 ----------
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
    $("wakeTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
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

  // ---------- 家計簿 ----------
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

  // ---------- 未送信キュー ----------
  function queue() { return load(KEYS.queue, []); }

  function enqueue(kind, data, errorEl) {
    const problem = C.validate(kind, data, today());
    errorEl.textContent = problem || "";
    if (problem) return false;
    const record = C.buildRecord(kind, data, new Date());
    const q = queue();
    q.push(record);
    if (!save(KEYS.queue, q)) {
      errorEl.textContent = "この端末に保存できませんでした。ストレージの空きを確認してください。";
      return false;
    }
    updateBadge();
    toast(`${C.KIND_LABELS[kind]}を保存しました`);
    trySendQuietly();
    return true;
  }

  function removeFromQueue(ids) {
    const set = new Set(ids);
    save(KEYS.queue, queue().filter((r) => !set.has(r.id)));
  }

  function markSent(records, via) {
    const log = load(KEYS.sent, []);
    const at = C.isoWithOffset(new Date());
    records.forEach((r) => log.unshift({ kind: r.kind, date: r.data.date, sent_at: at, via }));
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
    try {
      for (const r of items) {
        const result = await A.upload(C.fileName(r), C.serialize(r));
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
    } catch (e) {
      $("sendError").textContent = e.message || "送れませんでした。";
    } finally {
      sending = false;
      $("sendAll").disabled = false;
    }
    if (done.length) {
      markSent(done, "onedrive");
      toast(`${done.length}件をOneDriveへ送りました`);
    }
    if (!$("tab-send").hidden) renderSend();
  }

  function trySendQuietly() {
    const st = A.status();
    if (st.state === "signed-in" && navigator.onLine) sendAll(false);
  }

  async function shareAll() {
    const items = queue();
    if (!items.length) { toast("送る記録はありません"); return; }
    const files = items.map((r) => new File([C.serialize(r)], C.fileName(r), { type: "application/json" }));
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
    if (confirm(`OneDrive の inbox フォルダに ${items.length}件 保存できましたか?\n「OK」で送信済みにします(端末から本文を消します)。`)) {
      markSent(items, "share");
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
        el("p", { class: "muted", text: `サインイン中(${until.getMonth() + 1}/${until.getDate()} ${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")} まで)。保存するとすぐ送ります。` }),
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
        el("div", { text: C.KIND_EMOJI[r.kind] }),
        el("div", { class: "body" }, [
          el("div", { text: `${C.KIND_LABELS[r.kind]}・${r.data.date}` }),
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
      return el("div", { text: `${at} ${C.KIND_EMOJI[s.kind] || ""} ${C.KIND_LABELS[s.kind] || s.kind}(${s.date}の分)${s.via === "share" ? "・共有シート" : ""}` });
    }) : [el("span", { text: "まだありません。" })]));
    $("redirectUri").textContent = A.redirectUri();
    $("version").textContent = `版: ${APP_VERSION}`;
    updatePill();
  }

  // ---------- 起動 ----------
  window.addEventListener("online", () => { updatePill(); trySendQuietly(); });
  window.addEventListener("offline", updatePill);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    [syncEntryDate, syncSleepDate, syncMoneyDate].forEach((f) => f());
    trySendQuietly();
  });

  (async function boot() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    updateBadge();
    const r = await A.handleRedirect();
    if (r.handled) {
      if (r.error) { showTab("send"); $("sendError").textContent = r.error; return; }
      toast("サインインしました");
      if (r.afterAction === "send") { showTab("send"); await sendAll(true); return; }
      showTab("send");
      return;
    }
    showTab(["entry", "sleep", "money", "send"].includes(prefs.lastTab) ? prefs.lastTab : "entry");
    trySendQuietly();
  })();

  // 検証用(画面には影響しない)
  window.__pocket = { queue, enqueue: (k, d) => enqueue(k, d, { textContent: "" }), version: APP_VERSION };
})();
