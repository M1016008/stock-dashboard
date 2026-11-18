# StockBoard の友人向けの閲覧 (Friend Access)

ごく限られた友人に、StockBoard を読み取り専用で見せるための構成。2026-11-11 時点。
秘密情報 (トークン・許可したメールアドレス) はここに書かない。

## 構成

```
利用者 → stock.marketframe.jp (Cloudflare Access: ワンタイムコード、許可したメールだけ)
       → Cloudflare Tunnel (cloudflared)
       → 読み取り専用の Gateway (127.0.0.1:3136)
       → Web (127.0.0.1:3000)
```

| 部品 | 場所 | 管理 |
|---|---|---|
| Cloudflare Access | Cloudflare Zero Trust の管理画面 (アプリと許可するメールの方針) | オーナー |
| Cloudflare Tunnel | システムの LaunchDaemon `com.cloudflare.cloudflared`。トークンは `/Library/Application Support/com.cloudflare.cloudflared/token` (値は表に出さない)。行き先は Cloudflare 側の設定 | オーナー |
| Gateway | LaunchAgent `com.stockboard.friend-readonly-gateway`。`npm run friend-access:install-gateway` で登録する (コードは `lib/friend-readonly-gateway.ts`・`lib/friend-readonly-policy.ts`) | 登録・再起動はオーナー |

## Gateway が通すもの
- 管理の画面と API (下) を除き、`GET`・`HEAD` は通す。
- `POST` は、読み取りだけの API (`FRIEND_READ_ONLY_JSON_POST_PATHS`、検索・Screener など) だけを通す。それ以外の書き込みは止める。
- 管理の画面と API (`/admin`、`/api/admin`、大量保有の管理) は止める。
- `cf-access-*` などの認証の情報は Web に渡さない。Web には `x-stockboard-access-mode: friend-read-only` を付けて渡す。

## 利用者の追加・削除
Cloudflare Access の方針で、許可するメールアドレスを足す・消す (オーナーが管理画面で行う)。StockBoard の側の作業は無い。

## 変更したとき・確かめるとき
- Gateway のコードを変えたら、`npm run test:friend-access-gateway` と `npm run test:friend-access-ui` を通してから、オーナーが登録し直す。
- 確かめること: 認証の後に主な画面 (日本株・米国株) が開くこと。Mac mini の上で Gateway (`http://127.0.0.1:3136`) に、管理の API (`/api/admin/...`) と書き込みの `POST` を送り、止まる (403 など) こと。Gateway のログ (`~/Library/Logs/StockBoard/friend-readonly-gateway.log`) は起動の記録だけで、要求ごとの記録は無い。

## 守ること
- 認証の無い直接の Tunnel は使わない (`npm run share:tunnel:quick` は止めてある)。
- DB や SSD をクラウドに複製しない。
- 友人に見せるデータは、取得元ごとの表示の許可の範囲に限る (AGENTS.md)。
