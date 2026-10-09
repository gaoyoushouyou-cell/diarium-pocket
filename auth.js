/*
 * Diarium Pocket — Microsoft アカウントでのサインインと OneDrive への書き込み。
 *
 * ライブラリを使わず、OAuth 2.0 の「認可コード + PKCE」フローをそのまま書いている
 * (オフラインでも確実に読み込めるよう、外部スクリプトに頼らないため)。
 *
 * 権限は Files.ReadWrite.AppFolder だけ。触れるのは OneDrive の
 * 「アプリ/Diarium Pocket」フォルダの中だけで、ほかのファイルは見えない。
 * 書き込みは inbox/ に新しいファイルを作ることだけ(上書き・削除はしない)。
 *
 * 注意: ブラウザ向け(SPA)の更新トークンは Microsoft の仕様で 24 時間しか
 * 使えない。切れたら「送る」ときにもう一度サインイン画面を通る(Microsoft に
 * ログイン済みなら、アカウントを選ぶだけで戻ってくる)。
 */
(function (root) {
  "use strict";

  const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
  const SCOPES = "Files.ReadWrite.AppFolder offline_access";
  const GRAPH_APPROOT = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/";
  // 書き込めるのは inbox/(日記宛て)・tasks/(カンバン宛て)・memos/(メモ宛て)・study/(勉強時間。予定表・ランチャーが
  // 確認なしで取り込む)・routine/(ルーティン。カンバン・ランチャー・プロジェクトアプリが確認なしで取り込む)だけ。
  // 読むのは outbox/ だけ。
  const UPLOAD_FOLDERS = ["inbox", "tasks", "memos", "study", "routine"];
  const TOKENS_KEY = "pocket.auth";
  const PKCE_KEY = "pocket.pkce";

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (_) { /* 保存できない端末では何もしない */ }
    },
  };

  function config() {
    return root.POCKET_CONFIG || {};
  }

  function isConfigured() {
    return /^[0-9a-f-]{36}$/i.test(config().clientId || "");
  }

  /** Entra に登録するリダイレクト URI(このページのフォルダの URL)。 */
  function redirectUri() {
    return new URL("./", location.href).href;
  }

  function b64url(bytes) {
    let s = "";
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(n) {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return b64url(bytes);
  }

  async function challengeOf(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  /** サインイン画面の URL を作り、戻ってきたとき用の合言葉(PKCE)を端末に控える。 */
  async function authorizeUrl(afterAction) {
    if (!isConfigured()) throw new Error("クライアントIDが設定されていません。");
    const verifier = randomString(48);
    const state = randomString(16);
    store.set(PKCE_KEY, { verifier, state, afterAction: afterAction || null, at: Date.now() });
    const params = new URLSearchParams({
      client_id: config().clientId,
      response_type: "code",
      redirect_uri: redirectUri(),
      response_mode: "query",
      scope: SCOPES,
      state,
      code_challenge: await challengeOf(verifier),
      code_challenge_method: "S256",
    });
    return `${AUTHORITY}/authorize?${params}`;
  }

  /** サインイン画面へ移動する。afterAction は戻ってきたあとにしたいこと("send" など)。 */
  async function signIn(afterAction) {
    location.assign(await authorizeUrl(afterAction));
  }

  async function tokenRequest(body) {
    const res = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.assign({ client_id: config().clientId, scope: SCOPES }, body)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const err = new Error(json.error_description || json.error || `HTTP ${res.status}`);
      err.code = json.error || "";
      throw err;
    }
    const tokens = {
      access: json.access_token,
      accessExp: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      refresh: json.refresh_token || null,
      // SPA の更新トークンは最初のサインインから 24 時間で切れる(回しても延びない)
      refreshExp: body.grant_type === "authorization_code"
        ? Date.now() + 24 * 3600 * 1000
        : ((store.get(TOKENS_KEY) || {}).refreshExp || Date.now()),
    };
    store.set(TOKENS_KEY, tokens);
    return tokens;
  }

  /**
   * サインイン画面から戻ってきたときの処理。URL に ?code= があればトークンに換える。
   * 戻り値: { handled, afterAction, error }
   */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return { handled: false };
    const saved = store.get(PKCE_KEY);
    store.del(PKCE_KEY);
    history.replaceState(null, "", redirectUri());
    if (params.has("error")) {
      return { handled: true, error: params.get("error_description") || params.get("error") };
    }
    if (!saved || saved.state !== params.get("state")) {
      return { handled: true, error: "サインインの確認に失敗しました。もう一度お試しください。" };
    }
    try {
      await tokenRequest({
        grant_type: "authorization_code",
        code: params.get("code"),
        redirect_uri: redirectUri(),
        code_verifier: saved.verifier,
      });
      return { handled: true, afterAction: saved.afterAction };
    } catch (e) {
      return { handled: true, error: `サインインできませんでした: ${e.message}` };
    }
  }

  /** 使えるアクセストークン。無ければ null(=サインインが必要)。 */
  async function accessToken() {
    const t = store.get(TOKENS_KEY);
    if (!t) return null;
    if (t.access && t.accessExp - Date.now() > 120 * 1000) return t.access;
    if (!t.refresh || t.refreshExp <= Date.now()) return null;
    try {
      return (await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })).access;
    } catch (e) {
      if (e.code === "invalid_grant") store.del(TOKENS_KEY);
      return null;
    }
  }

  function status() {
    const t = store.get(TOKENS_KEY);
    if (!isConfigured()) return { state: "unconfigured" };
    if (!t) return { state: "signed-out" };
    const until = Math.max(t.accessExp || 0, t.refresh ? t.refreshExp || 0 : 0);
    return until > Date.now() ? { state: "signed-in", until } : { state: "expired" };
  }

  function signOut() {
    store.del(TOKENS_KEY);
  }

  function forgetAccessToken() {
    const t = store.get(TOKENS_KEY);
    if (t) { t.accessExp = 0; store.set(TOKENS_KEY, t); }
  }

  /** inbox/ か tasks/ に1ファイル作る。成功で true。サインインが要るときは "need-sign-in"。 */
  async function upload(name, text, folder) {
    folder = folder || "inbox";
    if (!UPLOAD_FOLDERS.includes(folder)) throw new Error("送り先のフォルダが正しくありません。");
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken();
      if (!token) return "need-sign-in";
      const res = await fetch(
        `${GRAPH_APPROOT}${folder}/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: text },
      );
      if (res.ok) return true;
      if (res.status === 409) return true; // 同じ名前のファイルがもうある = 前回送れていた
      if (res.status === 401 && attempt === 0) {
        forgetAccessToken();
        continue;
      }
      throw new Error(`OneDrive への保存に失敗しました (HTTP ${res.status})`);
    }
    return "need-sign-in";
  }

  /**
   * PC が書いた outbox/pocket_today.json を読む。サインイン画面には移動しない
   * (読めなければ手元の前回分を使えばよいので)。
   * 戻り値: { ok: true, data } / { ok: false, reason: "need-sign-in" | "missing" | "error", message }
   */
  async function downloadOutbox() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken();
      if (!token) return { ok: false, reason: "need-sign-in" };
      // ファイル本体は別ドメインの一時URLから取る(Graph の推奨どおり)
      const meta = await fetch(
        `${GRAPH_APPROOT}outbox/pocket_today.json?select=id,lastModifiedDateTime,@microsoft.graph.downloadUrl`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (meta.status === 404) return { ok: false, reason: "missing" };
      if (meta.status === 401 && attempt === 0) { forgetAccessToken(); continue; }
      if (!meta.ok) return { ok: false, reason: "error", message: `HTTP ${meta.status}` };
      const info = await meta.json();
      const url = info["@microsoft.graph.downloadUrl"];
      if (!url) return { ok: false, reason: "error", message: "ダウンロード先がありません" };
      const res = await fetch(url);
      if (!res.ok) return { ok: false, reason: "error", message: `HTTP ${res.status}` };
      return { ok: true, data: await res.json() };
    }
    return { ok: false, reason: "need-sign-in" };
  }

  root.PocketAuth = { isConfigured, redirectUri, authorizeUrl, challengeOf, signIn, handleRedirect, accessToken, status, signOut, upload, downloadOutbox };
})(self);
