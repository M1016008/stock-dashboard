import { createHash } from 'node:crypto'

export interface NotificationMimeInput {
  outboxId: string
  dedupeKey: string
  recipientEmail: string
  baseUrl: string
  subject: string
  textBody: string
  htmlBody: string
  createdAt: string
}

export interface BuiltNotificationMime {
  messageId: string
  textBody: string
  htmlBody: string
  mime: string
  rawBase64Url: string
}

export class NotificationMimeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationMimeValidationError'
  }
}

function safeHeader(value: string, field: string): string {
  if (!value.trim() || /[\r\n]/.test(value)) {
    throw new NotificationMimeValidationError(`${field} is invalid`)
  }
  return value.trim()
}

export function normalizeNotificationBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new NotificationMimeValidationError('baseUrl must be a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotificationMimeValidationError('baseUrl must use http or https')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NotificationMimeValidationError('baseUrl must not include credentials, query, or hash')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function normalizeNotificationRecipient(value: string): string {
  const email = safeHeader(value, 'recipientEmail').toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new NotificationMimeValidationError('recipientEmail must be a valid email address')
  }
  return email
}

function absoluteUrl(baseUrl: string, pathValue: string): string {
  const base = `${normalizeNotificationBaseUrl(baseUrl)}/`
  return new URL(pathValue.replace(/^\//, ''), base).toString()
}

export function absolutizeNotificationLinks(input: {
  textBody: string
  htmlBody: string
  baseUrl: string
}): { textBody: string; htmlBody: string } {
  const baseUrl = normalizeNotificationBaseUrl(input.baseUrl)
  const textBody = input.textBody.replace(
    /(^|[\s|])\/(stock\/[A-Za-z0-9%._~-]+|trigger-discovery(?:\?[^\s|<]*)?)/gm,
    (_match, prefix: string, pathValue: string) => `${prefix}${absoluteUrl(baseUrl, pathValue)}`,
  )
  const htmlBody = input.htmlBody.replace(
    /href=(['"])(\/[^'"]*)\1/gi,
    (_match, quote: string, pathValue: string) => `href=${quote}${absoluteUrl(baseUrl, pathValue)}${quote}`,
  )
  return { textBody, htmlBody }
}

function base64Lines(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function normalizedCrlf(value: string): string {
  return value.replace(/\r?\n/g, '\r\n')
}

export function buildNotificationMime(input: NotificationMimeInput): BuiltNotificationMime {
  const outboxId = safeHeader(input.outboxId, 'outboxId')
  const dedupeKey = safeHeader(input.dedupeKey, 'dedupeKey')
  const recipientEmail = normalizeNotificationRecipient(input.recipientEmail)
  const subject = safeHeader(input.subject, 'subject')
  const createdAt = new Date(input.createdAt)
  if (!Number.isFinite(createdAt.getTime())) {
    throw new NotificationMimeValidationError('createdAt must be a valid timestamp')
  }
  const bodies = absolutizeNotificationLinks({
    textBody: input.textBody,
    htmlBody: input.htmlBody,
    baseUrl: input.baseUrl,
  })
  const stableId = outboxId.replace(/[^A-Za-z0-9._-]/g, '-')
  const messageId = `<trigger-outbox-${stableId}@stock-dashboard.local>`
  const boundary = `stockboard_${createHash('sha256').update(outboxId).digest('hex').slice(0, 24)}`
  const mime = normalizedCrlf([
    `To: ${recipientEmail}`,
    `Subject: ${encodedWord(subject)}`,
    `Date: ${createdAt.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `X-Trigger-Outbox-Id: ${outboxId}`,
    `X-Trigger-Dedupe-Key: ${dedupeKey}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(bodies.textBody),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(bodies.htmlBody),
    `--${boundary}--`,
    '',
  ].join('\n'))
  const rawBase64Url = Buffer.from(mime, 'utf8').toString('base64url')
  return { messageId, textBody: bodies.textBody, htmlBody: bodies.htmlBody, mime, rawBase64Url }
}
