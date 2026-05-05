This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### 1. Turso (libSQL) のセットアップ

このプロジェクトは Drizzle ORM + [Turso](https://turso.tech)（libSQL）をデータストアに使います。

```bash
# 1. Turso CLI のインストール（未導入の場合）
curl -sSfL https://get.tur.so/install.sh | bash

# 2. ログイン
turso auth login

# 3. データベースを作成
turso db create stock-dashboard

# 4. 接続 URL と認証トークンを取得
turso db show stock-dashboard --url
turso db tokens create stock-dashboard
```

取得した値を `.env.local` に設定します。

```bash
cp .env.local.example .env.local
# エディタで TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を埋める
```

### 2. 依存関係のインストールとマイグレーション

```bash
npm install
npm run db:generate   # スキーマからマイグレーション SQL を生成
npm run db:migrate    # Turso にマイグレーションを適用
```

> ローカル開発でクラウドに繋ぎたくない場合は `TURSO_DATABASE_URL=file:./data/stockboard.db` を使えば埋め込みの SQLite ファイルとして動作します。

### 3. 開発サーバーを起動

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
