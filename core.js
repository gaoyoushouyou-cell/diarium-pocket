/*
 * Diarium Pocket — 画面に依存しない部分(記録ファイルの形・検証・睡眠時間の計算)。
 *
 * PC の日記アプリ(diary/phone_inbox.py)が読む形式と一致させること。
 * 定数(気分・カテゴリ・上限)は diary/dialy1.py と diary/diary_extensions.py の
 * 写しで、diary/verify_phone_inbox_20260929.py が Node 経由で一致を確かめる。
 * ブラウザでは window.PocketCore、Node では require() で使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PocketCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "diarium-pocket";
  const VERSION = 1;
  const MAX_TEXT_LENGTH = 4000;
  const MAX_MEMO = 100;
  const MAX_AMOUNT = 100000000;
  const MIN_SLEEP_MINUTES = 1;
  const MAX_SLEEP_MINUTES = 20 * 60;
  const BED_DATE_SAME_DAY_HOUR = 12;

  const MOODS = [
    { key: "very_good", emoji: "😄", name: "とてもよい" },
    { key: "good", emoji: "🙂", name: "よい" },
    { key: "neutral", emoji: "😐", name: "普通" },
    { key: "bad", emoji: "😔", name: "よくない" },
    { key: "very_bad", emoji: "😫", name: "つらい" },
  ];
  const EXPENSE_CATEGORIES = [
    ["食費", "🍚"], ["外食", "🍜"], ["日用品", "🧴"], ["交通", "🚃"],
    ["趣味・娯楽", "🎮"], ["交際", "🎁"], ["健康", "💊"], ["衣服", "👕"],
    ["学び", "📚"], ["その他", "🗂️"],
  ];
  const INCOME_CATEGORIES = [
    ["給与", "💼"], ["ボーナス", "🎉"], ["副業", "🧑‍💻"], ["お小遣い", "👛"],
    ["投資", "📈"], ["還付・払戻", "↩️"], ["プレゼント", "🎀"], ["その他", "🗂️"],
  ];
  const EXPENSE_QUICK_AMOUNTS = [100, 300, 500, 1000, 3000];
  const INCOME_QUICK_AMOUNTS = [1000, 5000, 10000, 30000, 100000];
  const SLEEP_QUALITY = [
    { value: 1, emoji: "😪", name: "不足" },
    { value: 2, emoji: "😐", name: "ふつう" },
    { value: 3, emoji: "😊", name: "ぐっすり" },
  ];
  const KIND_LABELS = { entry: "日記", sleep: "睡眠", expense: "出費", income: "収入" };
  const KIND_EMOJI = { entry: "📔", sleep: "🛏️", expense: "💸", income: "💰" };

  const pad = (n) => String(n).padStart(2, "0");

  function localDateStr(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return localDateStr(new Date(y, m - 1, d + days));
  }

  /** 端末のタイムゾーン付きの ISO 8601("2026-09-29T21:03:12+09:00")。 */
  function isoWithOffset(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    return (
      `${localDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  }

  function isValidDateStr(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { h, min };
  }

  /** PC 側 compute_sleep_minutes と同じ計算。正午より前の就寝は起床日と同じ日とみなす。 */
  function sleepMinutes(wakeDateStr, bed, wake) {
    const b = parseHHMM(bed), w = parseHHMM(wake);
    if (!b || !w || !isValidDateStr(wakeDateStr)) return null;
    const [y, mo, d] = wakeDateStr.split("-").map(Number);
    const bedDay = b.h < BED_DATE_SAME_DAY_HOUR ? d : d - 1;
    // 夏時間のない日本を前提にせず、壁時計どうしの差を分で数える
    const bedMs = Date.UTC(y, mo - 1, bedDay, b.h, b.min);
    const wakeMs = Date.UTC(y, mo - 1, d, w.h, w.min);
    const minutes = Math.floor((wakeMs - bedMs) / 60000);
    if (minutes < MIN_SLEEP_MINUTES || minutes > MAX_SLEEP_MINUTES) return null;
    return minutes;
  }

  function formatMinutes(total) {
    const h = Math.floor(total / 60), m = total % 60;
    if (h === 0) return `${m}分`;
    return m === 0 ? `${h}時間` : `${h}時間${m}分`;
  }

  /** 全角数字・カンマ・「円」が混ざっていても半角数字だけにする。 */
  function normalizeNumber(raw) {
    return String(raw || "")
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[^0-9]/g, "");
  }

  /** PC 側で弾かれる内容を、スマホで保存する前に知らせる。問題なければ null。 */
  function validate(kind, data, todayStr) {
    if (!data || !isValidDateStr(data.date)) return "日付を選んでください。";
    if (data.date > todayStr) return "未来の日付は保存できません。";
    if (kind === "entry") {
      if (!MOODS.some((m) => m.key === data.mood)) return "気分を選んでください。";
      if (typeof data.text !== "string") return "本文の形式が正しくありません。";
      if (data.text.trim().length > MAX_TEXT_LENGTH) return `本文は${MAX_TEXT_LENGTH}文字以内で入力してください。`;
      return null;
    }
    if (kind === "sleep") {
      if (!parseHHMM(data.bed_time) || !parseHHMM(data.wake_time)) return "就寝と起床、両方の時刻を選んでください。";
      if (data.quality !== null && !SLEEP_QUALITY.some((q) => q.value === data.quality))
        return "睡眠の質の値が正しくありません。";
      if (sleepMinutes(data.date, data.bed_time, data.wake_time) === null)
        return "睡眠時間を計算できませんでした。時刻を確認してください。";
      return null;
    }
    if (kind === "expense" || kind === "income") {
      const cats = kind === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
      if (!Number.isInteger(data.amount) || data.amount <= 0) return "金額を入力してください。";
      if (data.amount > MAX_AMOUNT) return "金額が大きすぎます。";
      if (!cats.some(([name]) => name === data.category)) return "カテゴリを選んでください。";
      if ((data.memo || "").trim().length > MAX_MEMO) return `メモは${MAX_MEMO}文字以内で入力してください。`;
      return null;
    }
    return "記録の種類が正しくありません。";
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** inbox に置く1ファイル分の中身。 */
  function buildRecord(kind, data, now, id) {
    const clean = Object.assign({}, data);
    if (kind === "entry") clean.text = clean.text.trim();
    if (kind === "expense" || kind === "income") clean.memo = (clean.memo || "").trim();
    return { format: FORMAT, v: VERSION, id: id || newId(), kind, created_at: isoWithOffset(now), data: clean };
  }

  function fileName(record) {
    const stamp = record.created_at.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    return `pocket-${stamp}-${record.kind}-${record.id.replace(/-/g, "").slice(0, 8)}.json`;
  }

  function serialize(record) {
    return JSON.stringify(record, null, 1);
  }

  function summarize(record) {
    const d = record.data;
    if (record.kind === "entry") {
      const mood = MOODS.find((m) => m.key === d.mood);
      const text = d.text.length > 40 ? d.text.slice(0, 40) + "…" : d.text;
      return `${mood ? mood.emoji : ""} ${text}`.trim();
    }
    if (record.kind === "sleep") {
      const min = sleepMinutes(d.date, d.bed_time, d.wake_time);
      return `${d.bed_time} → ${d.wake_time}${min !== null ? `(${formatMinutes(min)})` : ""}`;
    }
    return `¥${d.amount.toLocaleString("ja-JP")} ${d.category}${d.memo ? `(${d.memo})` : ""}`;
  }

  return {
    FORMAT, VERSION, MAX_TEXT_LENGTH, MAX_MEMO, MAX_AMOUNT, MOODS, EXPENSE_CATEGORIES, INCOME_CATEGORIES,
    EXPENSE_QUICK_AMOUNTS, INCOME_QUICK_AMOUNTS, SLEEP_QUALITY, KIND_LABELS, KIND_EMOJI,
    localDateStr, addDays, isoWithOffset, isValidDateStr, parseHHMM, sleepMinutes, formatMinutes,
    normalizeNumber, validate, newId, buildRecord, fileName, serialize, summarize,
  };
});
