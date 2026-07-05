# StockBoard 共有プレビュー手順

知人に一時共有する場合は、ローカルのStockBoardを起動し、Cloudflare Tunnelで外部URLを発行します。
DB移行を伴わないため、現在のローカル表示に近い状態を安全に共有できます。

## 1. 共有用の環境変数

`.env.local` に以下を追加します。実値はリポジトリへコミットしません。

```bash
STOCKBOARD_SHARE_MODE=1
STOCKBOARD_SHARE_BASIC_USER=friend
STOCKBOARD_SHARE_BASIC_PASSWORD=長くて推測されにくいパスワード
STOCKBOARD_SHARE_READ_ONLY=1
STOCKBOARD_SHARE_ALLOW_ADMIN=0
```

共有モードでは、全ページ/APIにBasic認証がかかります。
`/admin` と `/api/admin` は共有時にブロックされます。
`STOCKBOARD_SHARE_READ_ONLY=1` では、POST/PUT/PATCH/DELETEもブロックされます。

## 2. 本番ビルドで起動

```bash
npm run build
npm run share:start
```

開発中の見た目をそのまま共有するだけなら、代わりに以下でも起動できます。

```bash
npm run share:dev
```

## 3. Cloudflare Tunnelで外部URLを出す

`cloudflared` が未インストールの場合:

```bash
brew install cloudflare/cloudflare/cloudflared
```

短時間の確認だけならQuick Tunnel:

```bash
npm run share:tunnel:quick
```

表示された `https://...trycloudflare.com` のURLを知人に共有します。
Basic認証のユーザー名・パスワードは別経路で伝えてください。

継続利用する場合は、Cloudflareアカウントで正式TunnelとCloudflare Accessを設定する方が安全です。

## 4. 共有前チェック

```bash
npm run build
curl -I http://localhost:3000/
curl -I http://localhost:3000/admin/db
```

共有モードで未認証なら `/` は `401`、認証後の `/admin/db` は `403` になります。

## 注意

- APIキーや `.env.local` は絶対に共有しない。
- 知人共有では、原則 `STOCKBOARD_SHARE_READ_ONLY=1` のままにする。
- AIチャットや保存系POSTを許可したい場合は `STOCKBOARD_SHARE_READ_ONLY=0` にできるが、OpenAI API利用コストや書き込みを許可する意味を確認してから行う。
- データ更新バッチは共有URLから実行せず、ローカル運用側だけで実行する。
