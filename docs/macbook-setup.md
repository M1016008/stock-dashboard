# MacBook 開発環境セットアップ

このプロジェクトは、コードは GitHub、秘密情報は `.env.local`、大容量データは `data/stockboard.db` で管理します。`.env.local` と `data/stockboard.db` は Git に入れません。

## 1. 事前準備

MacBook に以下を入れます。

```bash
xcode-select --install
```

Node.js は 20 系または 22 系を使ってください。Homebrew を使う場合は以下です。

```bash
brew install node
node -v
npm -v
```

## 2. GitHub からコードを取得

```bash
cd ~/dev
git clone https://github.com/M1016008/stock-dashboard.git
cd stock-dashboard
git checkout claude/phase-4-ui-redesign
npm install
```

将来 `main` に統合した後は、`git checkout main` で構いません。

## 3. `.env.local` を作成

```bash
cp .env.example .env.local
```

`.env.local` に以下を設定します。

```bash
USE_LOCAL_DB=1
JQUANTS_API_KEY=...
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
OPENAI_API_KEY=...
OPENAI_ANALYSIS_MODEL=gpt-4o-mini
```

`OPENAI_API_KEY` は未設定でもサイトは動きます。その場合、検証詳細のAIコメントは定型コメントになります。

## 4. ローカルDBを移す

現在のDBは約30GBあります。MacBookでも同じデータで開発するには、`data/stockboard.db` をコピーします。

まずMacBook側でフォルダを作ります。

```bash
mkdir -p data
```

同じネットワーク上でMac miniへSSHできる場合は、MacBook側で以下のようにコピーします。

```bash
rsync -avh --progress yoshio@<Mac-miniのホスト名>:/Users/yoshio/dev/stock-dashboard/.claude/worktrees/gracious-grothendieck-804715/data/stockboard.db data/
```

SSHを使わない場合は、外付けSSDやAirDropで `stockboard.db` を `data/stockboard.db` に配置してください。

## 5. 開発環境を確認

```bash
npm run dev:check
```

問題なければ起動します。

```bash
npm run dev
```

ブラウザで開きます。

```text
http://localhost:3001
```

Mac miniでは `http://localhost:3000` をlaunchd管理の公開用サイト、
`http://localhost:3001` を開発用サイトとして分離します。開発中の変更や
ビルドが公開用サイトを停止させることはありません。公開反映時は
`npm run web:deploy` を使用してください。

## 6. 最新コードを取り込む

```bash
git pull
npm install
```

DB構造が更新された場合は、必要に応じて以下を実行します。

```bash
npm run batch:update-latest
npm run batch:dashboard-cache
```

## 7. 注意点

- `.env.local` は絶対にコミットしません。
- `data/stockboard.db` は絶対にコミットしません。
- J-Quants以外の株価データソースには勝手に切り替えません。
- 重いバッチはMacBookの空き容量と電源接続を確認してから実行してください。
