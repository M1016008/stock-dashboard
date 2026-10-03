# Trigger Gmail Delivery Setup

Phase 9B-1 sends one explicitly selected Notification Outbox item through the Gmail API. It does not drain pending mail automatically and is not connected to the daily pipeline.

## Google Cloud setup

1. Enable the Gmail API in a Google Cloud project.
2. Configure the OAuth consent screen and add the account as a test user when applicable.
3. Create an OAuth client with application type **Desktop app**.
4. Add these values to the ignored `.env.local` file:

```text
TRIGGER_GMAIL_OAUTH_CLIENT_ID=...
TRIGGER_GMAIL_OAUTH_CLIENT_SECRET=...
```

The implementation requests only `https://www.googleapis.com/auth/gmail.send`. It uses the system browser, a temporary `127.0.0.1` loopback callback, state, PKCE S256, and offline access. OOB/manual copy-and-paste authorization is not supported.

When an External OAuth consent screen remains in **Testing**, an offline refresh token for Gmail scopes can expire after seven days. Confirm the Google Cloud publishing status before relying on long-running daily delivery. The application does not modify Google Cloud settings.

## Authorization

```bash
npm run trigger:gmail-auth
npm run trigger:gmail-status
```

The refresh token is stored in macOS Keychain under service `com.stockboard.trigger-gmail`. It is not written to the repository, `.env.local`, the application database, Outbox rows, logs, or test fixtures. Access tokens remain in memory only.

Revocation, `invalid_grant`, and an absent refresh token are reported as `AUTH_REQUIRED`. Run the authorization command again after revoking the old credential when reauthorization is required.

## Delivery profile

Create a disabled profile first:

```bash
npm run trigger:gmail-profile -- \
  --recipient=you@example.com \
  --base-url=https://your-stock-dashboard.example
```

After checking the recipient and URL, enable it explicitly:

```bash
npm run trigger:gmail-profile -- \
  --recipient=you@example.com \
  --base-url=https://your-stock-dashboard.example \
  --enable
```

The authenticated Gmail account is the sender. The MIME message does not spoof a separate From address. The profile stores only provider, recipient, enabled state, and Base URL; it never stores OAuth credentials.

## Manual delivery

Preview one exact Outbox item without sending:

```bash
npm run trigger:gmail-send -- --outbox-id=<uuid>
```

Send that item only after checking the preview:

```bash
npm run trigger:gmail-send -- --outbox-id=<uuid> --confirm-send
```

A retryable explicit provider failure additionally requires `--retry-failed`. A `DELIVERY_UNKNOWN` item is never retried implicitly; a deliberate resend requires `--confirm-send --confirm-unknown-resend` after checking Gmail for a possible prior delivery.

There is intentionally no "send all pending" command, worker, scheduler, or production-smoke delivery. Automatic delivery belongs to Phase 9B-2.

## State and security

- `PENDING -> SENDING -> SENT` for confirmed delivery.
- Explicit provider failures become `FAILED` with a normalized error category and retryable flag.
- A network failure after starting `users.messages.send` becomes `DELIVERY_UNKNOWN` to avoid blind duplicate retries.
- An atomic SQLite claim prevents two processes from sending the same PENDING item.
- Re-running delivery for a SENT item performs no Gmail API call.
- Delivery sends the immutable Phase 9A subject, text, and HTML. It only converts known relative site links to the profile Base URL while building MIME.

References: [Gmail message sending](https://developers.google.com/workspace/gmail/api/guides/sending), [installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), and [OAuth testing mode](https://support.google.com/cloud/answer/15549945).
