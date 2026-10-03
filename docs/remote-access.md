# StockBoard remote access

StockBoardはWebサーバーを`127.0.0.1`だけで待ち受け、Tailscale ServeがTailnet内へHTTPSで中継します。インターネット一般へ公開するFunnelや認証キーは使用しません。

## 初回設定

1. Mac miniと閲覧端末にTailscaleをインストールします。
2. Mac miniで`npm run remote:login`を実行し、同じTailnetへログインします。
3. `npm run remote:enable`を実行します。表示されたHTTPS URLが閲覧先です。
4. `npm run remote:status`でWeb応答、Tailscale接続、HTTPS中継を確認します。

設定はTailscale側に保存されるため、通常は毎回の再設定は不要です。StockBoardのHTTPSルートだけを止める場合は`npm run remote:disable`を実行します。他のTailscale Serve設定はリセットしません。

## 外出先からの開発

コード編集にはTailscale接続後のSSHまたは画面共有を使用できます。ただし、macOSの「リモートログイン」とTailnet ACLは管理者が明示的に有効化する必要があるため、このリポジトリのコマンドからは自動変更しません。閲覧用HTTPSと開発用SSHの権限は分離してください。
