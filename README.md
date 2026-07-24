This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

The launchd-managed production site runs at
[http://localhost:3000](http://localhost:3000). Its verified build is kept in
`.next-live`, separate from source edits and development builds.

Run the development server on port 3001:

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) to inspect work in progress.
Editing or rebuilding this development site does not interrupt the production
dashboard on port 3000.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

Promote a successfully built version to the production service with:

```bash
npm run web:deploy
```

The command builds in an isolated staging directory, keeps the previous live
build as a rollback target, restarts the managed service, and verifies
`/api/health`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
