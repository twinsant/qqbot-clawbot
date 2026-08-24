/**
 * Pure inbound-policy helpers for the QQ protocol driver.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/policy
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { InboundImageNote, QqAttachment, QqInboundMessage } from './types.ts'

/** Default hosts the driver will fetch inbound images from. */
export const DEFAULT_IMAGE_HOSTS = ['qq.com', 'qq.com.cn', 'gtimg.com', 'myqcloud.com', 'qpic.cn'] as const

/** Result of evaluating one sender against the TOFU allowlist. */
export interface TrustDecision {
  /** Whether the message may be forwarded. */
  readonly trusted: boolean
  /** Sender recorded as the first trusted identity, when TOFU just fired. */
  readonly firstTrust?: string
}

/**
 * Calendar date of `now` in the host local timezone, as `YYYY-MM-DD`.
 * @param now - instant to format; defaults to the current time.
 * @returns the date key used as the daily session suffix.
 */
export function dateKey(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear())}-${month}-${day}`
}

/**
 * Daily session identity for one calendar day.
 * @param now - instant whose local date names the session.
 * @returns the unbranded session id string.
 */
export function dailySessionId(now?: Date): string {
  return `qqbot-${dateKey(now)}`
}

/**
 * Whether `url` is an https URL on one of the allowed image hosts or a subdomain.
 * @param url - candidate download URL.
 * @param hosts - registrable suffixes; defaults to Tencent CDN hosts.
 * @returns true only for https URLs whose hostname matches a listed host.
 */
export function isAllowedMediaUrl(url: string, hosts: readonly string[] = DEFAULT_IMAGE_HOSTS): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

/**
 * Detect a supported raster type from magic bytes.
 * @param bytes - leading file bytes.
 * @returns a MIME type, or `null` when the prefix is not a supported image.
 */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * Map a QQ reply onto a closed approval outcome.
 * @param text - inbound decision text.
 * @returns a grant or rejection, or `null` when the text is not a decision.
 */
export function parseApprovalDecision(text: string): Extract<ApprovalOutcome, 'allowed-once' | 'rejected'> | null {
  const normalized = text.trim().toLowerCase()
  if (['允许', '同意', '是', 'yes', 'y', 'ok', 'allow', 'approve'].includes(normalized)) return 'allowed-once'
  if (['拒绝', '否', '不', 'no', 'n', 'deny', 'reject'].includes(normalized)) return 'rejected'
  return null
}

/**
 * Neutralize inbound text so it cannot spoof the `[QQ` frame prefix.
 * @param text - untrusted inbound body or caption.
 * @returns the rewritten string.
 */
export function sanitizeInbound(text: string): string {
  return text.replace(/\[QQ/g, '［QQ')
}

/** Stand-in for any value withheld from an approval prompt. */
export const REDACTED = '[已隐去]'

/** Longest rendered argument text one approval prompt carries. */
export const MAX_ARGUMENT_CHARS = 600

/** Longest single string value kept intact inside that rendering. */
export const MAX_SCALAR_CHARS = 120

/** Argument keys whose values never reach the QQ transport. */
const SECRET_KEY_PATTERN
  = /secret|token|password|passwd|credential|cookie|signature|session|api[_-]?key|access[_-]?key|private[_-]?key|auth/i

/**
 * Value shapes that carry a credential whatever key holds them. Applied to the
 * rendered text so credentials pasted inside shell commands, URLs, or prose are
 * caught alongside the ones sitting in a named field.
 */
const SECRET_VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, REDACTED],
  [/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa)[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bbearer\s+[A-Z0-9._~+/-]{16,}={0,2}/gi, REDACTED],
  [/([A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)\S+/gi, `$1${REDACTED}`],
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED],
]

/**
 * Withhold every credential-shaped substring from already-rendered text.
 * @param text - rendered argument text.
 * @returns the text with credential shapes replaced.
 */
function scrubSecretShapes(text: string): string {
  return SECRET_VALUE_PATTERNS.reduce<string>(
    (carry, [pattern, replacement]) => carry.replace(pattern, replacement),
    text,
  )
}

/**
 * Rewrite one value tree, withholding secret-keyed fields and capping strings.
 * @param value - parsed argument value.
 * @param secretKey - whether the key holding this value names a credential.
 * @returns the rewritten value.
 */
function redactValue(value: unknown, secretKey: boolean): unknown {
  if (secretKey) return REDACTED
  if (typeof value === 'string') {
    return value.length > MAX_SCALAR_CHARS ? `${value.slice(0, MAX_SCALAR_CHARS)}…` : value
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, false))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactValue(item, SECRET_KEY_PATTERN.test(key))]))
  }
  return value
}

/**
 * Render one tool call's arguments for a QQ approval prompt without disclosing
 * credentials or the host's home directory. The prompt must say what is being
 * approved, so field names and non-secret values survive; anything that names
 * or looks like a credential is withheld, and the result is length-capped.
 * @param json - raw `tool/call` argument JSON; unparseable text is scrubbed as-is.
 * @param home - host home directory collapsed to `~`; empty disables collapsing.
 * @returns prompt-safe argument text.
 */
export function redactToolArguments(json: string, home = ''): string {
  let rendered: string
  try {
    rendered = JSON.stringify(redactValue(JSON.parse(json), false))
  } catch {
    rendered = json
  }
  const collapsed = home === '' ? rendered : rendered.split(home).join('~')
  const scrubbed = scrubSecretShapes(collapsed)
  return scrubbed.length > MAX_ARGUMENT_CHARS ? `${scrubbed.slice(0, MAX_ARGUMENT_CHARS)}…` : scrubbed
}

/**
 * Compose the model-visible text from an inbound QQ message.
 * @param message - inbound payload.
 * @returns joined text plus voice transcriptions, without media placeholders.
 */
export function buildInboundText(message: Pick<QqInboundMessage, 'content' | 'attachments'>): string {
  const parts: string[] = []
  if (typeof message.content === 'string' && message.content.trim()) parts.push(message.content)
  for (const attachment of message.attachments ?? []) {
    if (typeof attachment.asr_refer_text === 'string' && attachment.asr_refer_text.trim()) {
      parts.push(`[语音转文字] ${attachment.asr_refer_text}`)
    }
  }
  return parts.join('\n')
}

/**
 * One-line placeholder for an attachment that is not inlined as an image.
 * @param attachment - inbound attachment.
 * @returns a short Chinese caption.
 */
export function mediaSummary(attachment: QqAttachment): string {
  const contentType = attachment.content_type ?? ''
  if (contentType.startsWith('image/')) return '[图片]'
  if (contentType.startsWith('audio/') || contentType.includes('voice')) return '[语音]'
  if (contentType.startsWith('video/')) return '[视频]'
  if (attachment.filename) return `[文件: ${attachment.filename}]`
  return '[附件]'
}

/**
 * Conversation-kind label shown in the inbound frame.
 * @param kind - SDK conversation kind.
 * @returns a short Chinese label.
 */
export function kindLabel(kind: string): string {
  if (kind === 'group') return 'QQ群'
  if (kind === 'c2c') return 'QQ'
  return 'QQ频道'
}

/**
 * Evaluate TOFU trust for one sender.
 * @param sender - platform sender id, or `unknown` when missing.
 * @param allowedSenders - current allowlist.
 * @returns whether to accept the message, and an optional newly trusted sender.
 */
export function trustSender(sender: string, allowedSenders: readonly string[]): TrustDecision {
  if (allowedSenders.includes(sender)) return { trusted: true }
  if (sender === 'unknown') return { trusted: false }
  if (allowedSenders.length === 0) return { trusted: true, firstTrust: sender }
  return { trusted: false }
}

/**
 * Build the model-visible inbound body, including media placeholders when there is no text.
 * @param message - inbound payload.
 * @param imageNotes - per-image handling results, in image-attachment order.
 * @returns framed text the model sees.
 */
export function formatInboundBody(message: QqInboundMessage, imageNotes: readonly InboundImageNote[]): string {
  const sender = (message.senderId ?? 'unknown').replace(/[[\]\r\n]/g, '')
  const head = [`[${kindLabel(message.kind)} · ${sender}]`]
  for (const note of imageNotes) {
    if (note.inlined || note.text === '') continue
    const pathSuffix = note.path !== undefined ? `（图片路径：${note.path}）` : ''
    head.push(`[图片：${sanitizeInbound(note.text)}]${pathSuffix}`)
  }
  const text = buildInboundText(message)
  if (text) {
    head.push(sanitizeInbound(text))
    return head.join('\n')
  }
  const imageAtts = imageAttachments(message.attachments ?? [])
  for (const attachment of message.attachments ?? []) {
    if (attachment.asr_refer_text) continue
    const imageIndex = imageAtts.indexOf(attachment)
    if (imageIndex >= 0) {
      const note = imageNotes[imageIndex]
      if (note !== undefined && (note.inlined || note.text !== '')) continue
    }
    head.push(sanitizeInbound(mediaSummary(attachment)))
  }
  if (head.length === 1) head.push('(无文本内容)')
  return head.join('\n')
}

/**
 * Image-typed attachments that carry a URL, in attachment order.
 * @param attachments - inbound attachments.
 * @returns the image candidates.
 */
export function imageAttachments(attachments: readonly QqAttachment[]): QqAttachment[] {
  return attachments.filter(attachment =>
    typeof attachment.content_type === 'string'
    && attachment.content_type.startsWith('image/')
    && Boolean(attachment.url))
}

/** Settings namespace owned by this plugin. */
export const QQBOT_SETTINGS_NAMESPACE = 'qqbot'

/** Plugin provenance string written onto inbound user messages. */
export const SOURCE_PLUGIN = 'qqbot-clawbot'
