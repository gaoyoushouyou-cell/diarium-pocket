# Diarium Pocket(スマホ用・日記の入口)

iPhone で書いた **日記(気分+本文)・睡眠・出費/収入** を、OneDrive 経由で PC の日記アプリ(Diarium)へ届ける小さな Web アプリ(PWA)です。

```
iPhone(Diarium Pocket) ──書くだけ──▶ OneDrive「アプリ/Diarium Pocket/inbox」 ──▶ PC の日記アプリが起動時に確認して取り込む
```

- 書いた記録は、送るまで iPhone の中だけに保存されます(電波がなくても書けます)。
- 送り先は、あなたの OneDrive の「アプリ/Diarium Pocket」フォルダだけです(ほかのファイルは見えない権限)。
- 送り終えると、iPhone からは本文を消します(「送った記録」には日付と種類だけ残ります)。
- PC では日記アプリを開いたときに一覧が出て、**取り込むか選んでから** 日記に入ります。取り込んだファイルは PC 内(`diary/data/phone_inbox_archive/`)へ移り、OneDrive からは消えます。
- 同じ日の日記が PC にもあれば、「追記/置き換え/見送る」を選べます(初期値は追記)。

## セットアップ(はじめの一回だけ)

### 1. GitHub Pages に置く(アプリの置き場所)

1. GitHub のアカウントを作る(持っていれば不要)。
2. 新しいリポジトリを **Public** で作る。名前は例えば `diarium-pocket`。
3. 「Add file → Upload files」で、このフォルダの次のファイルをそのままアップロードする:
   `index.html` `app.js` `core.js` `auth.js` `config.js` `sw.js` `manifest.webmanifest` `icons/`(フォルダごと)
4. リポジトリの「Settings → Pages」で、Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして保存。
5. 数分で `https://<ユーザー名>.github.io/diarium-pocket/` が開けるようになる。**この URL を控えておく**(最後の `/` まで)。

> 置くのはプログラムだけで、日記のデータは一切置きません。

### 2. Microsoft Entra にアプリを登録する(OneDrive に書く許可をもらう)

1. 個人の Microsoft アカウントで <https://entra.microsoft.com> を開く(Azure の無料アカウント作成を求められたら、案内に従う)。
2. 「アプリの登録 → 新規登録」:
   - 名前: **`Diarium Pocket`**(この名前が OneDrive のフォルダ名になり、PC 側はこの名前のフォルダを探します。変えないでください)
   - サポートされているアカウントの種類: **「個人用 Microsoft アカウントのみ」**
   - リダイレクト URI: プラットフォームは **「シングルページ アプリケーション (SPA)」**、URI は手順 1 で控えた URL
3. 登録後の画面の **「アプリケーション (クライアント) ID」** をコピーする。
4. `config.js` の `clientId: ""` の `""` の中に貼り付けて保存し、GitHub にもう一度アップロードする(上書き)。

> クライアント ID は秘密の値ではありません(公開して大丈夫です)。パスワードやシークレットは作りません。
> 学校のアカウント(keio.jp)では、管理者の設定で登録や許可ができないことが多いので、個人用アカウントで行ってください。

### 3. iPhone に入れる

1. Safari で手順 1 の URL を開く。
2. 共有ボタン → **「ホーム画面に追加」**。以後はホーム画面のアイコンから開く(こうしないと、しばらく使わないと端末内の保存が消えることがあります)。
3. 「送る」タブ → 「Microsoft でサインイン」→ 許可する。
4. 何か1件書いて送ると、PC の OneDrive に `アプリ/Diarium Pocket/inbox` ができます。日記アプリの「設定 → スマホから」で ✓ が付けば準備完了です。

## ふだんの使い方

- 書いて「保存して送る」。サインイン中で電波があれば、その場で OneDrive に送ります。電波がなければ「未送信」にたまり、次に開いたときに送ります。
- サインインは Microsoft の仕様で **24 時間ごと** に切れます。切れていたら、「送る」を押したときにサインイン画面を一度通ります(ログイン済みならアカウントを選ぶだけ)。
- PC で日記アプリを開くと、届いた記録の確認画面が出ます。「あとで」を押せば何もせずに閉じます(設定画面の「届いた記録を確認」からいつでも開けます)。

## クライアント ID を設定する前でも使える方法

「送る」タブの **「共有シートで『ファイルに保存』する」** → 「"ファイル"に保存」→ OneDrive → `for_me_read` → `inbox` フォルダ(無ければ作る)に保存。
PC の日記アプリは `for_me_read/inbox` も見に行きます。保存できたら「OK」を押すと、端末から本文を消します。

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | 画面と見た目 |
| `app.js` | 画面の動き(未送信の管理・送信) |
| `core.js` | 記録ファイルの形・入力チェック・睡眠時間の計算(PC 側と同じルール) |
| `auth.js` | Microsoft サインイン(PKCE)と OneDrive への書き込み |
| `config.js` | クライアント ID |
| `sw.js` | オフラインでも開けるようにする |

PC 側は `diary/phone_inbox.py`(取り込みのロジック)と、`diary/diary_extensions.py` の確認画面。
検証: `python diary/verify_phone_inbox_20260929.py`(Node があれば core.js が作るファイルを PC 側が読めることも確かめます)。
手元で画面を試すとき: `python -m http.server 8765 --directory diarium_pocket` → <http://localhost:8765/>。

アプリを更新したら、`sw.js` の `CACHE` と `app.js` の `APP_VERSION` の日付を変えてからアップロードしてください(iPhone 側は、開き直すと新しい版に切り替わります)。
