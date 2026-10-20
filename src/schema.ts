/**
 * Settings and plugin-config schemas for the QQ protocol driver.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/schema
 */

import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { QqBotSettings } from './types.ts'

/**
 * The binding fields as the runtime actually hands them over.
 *
 * A field under a `meta.volatile` schema node arrives as a stable reference,
 * not a plain value: read it with `.get()`, keep the reference, and re-read on
 * `loader/volatile-update`. Marking them volatile is also what makes the entry
 * appear in the settings mirror at all — `describe()` projects an entry through
 * `volatileForm`, which keeps nothing but volatile fields, so an entry without
 * any is skipped and its page renders empty.
 */
export interface Config extends Omit<QqBotSettings, 'appId' | 'appSecret' | 'workspaceId' | 'allowedSenders'> {
  /** QQ Open Platform AppID, read with `.get()`. */
  appId: Volatile<string>
  /** QQ Open Platform AppSecret, read with `.get()`. */
  appSecret: Volatile<string>
  /** Workspace whose path becomes the daily session's cwd. */
  workspaceId: Volatile<string>
  /** Senders allowed to drive the bot. */
  allowedSenders: Volatile<string[]>
  /** Accept group, guild, and DM messages. C2C-only is the default because TOFU trusts the first sender. */
  allowNonC2c: boolean
  /** Hard cap on a downloaded inbound image, in bytes. */
  maxImageBytes: number
  /** Abort an inbound image download after this many milliseconds. */
  apiTimeoutMs: number
  /** Withdraw a QQ-side approval prompt after this many milliseconds. */
  approvalTimeoutMs: number
}

/** Branded settings namespace registered by the host plugin. */
export const QQ_NS = 'qqbot-clawbot' as const

const QQ_FIELDS = {
  appId: Schema.string().default(''),
  appSecret: Schema.string().role('secret').default(''),
  workspaceId: Schema.string().default(''),
  allowedSenders: Schema.array(Schema.string()).default([]),
}

/** Binding fields projected into the `qqbot-clawbot` configuration form. */
export const QQ_SCHEMA: Schema<QqBotSettings> = Schema.object(QQ_FIELDS)

/** Default image-download timeout. */
export const DEFAULT_API_TIMEOUT_MS = 15_000
/** Default inbound-image byte cap. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default QQ-side approval prompt lifetime. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The binding fields, marked volatile.
 *
 * 0.2's settings mirror describes an entry only through `volatileForm`, which
 * keeps nothing but fields under a `meta.volatile` node — a schema with no
 * volatile field is skipped entirely, so the page renders empty and
 * `settings.update()` refuses the write outright ("has no volatile fields").
 * Ordinary `role('secret')` is a redaction hint and does not imply volatile.
 */
const VOLATILE_QQ_FIELDS = {
  appId: QQ_FIELDS.appId.volatile(),
  appSecret: QQ_FIELDS.appSecret.volatile(),
  workspaceId: QQ_FIELDS.workspaceId.volatile(),
  allowedSenders: QQ_FIELDS.allowedSenders.volatile(),
}

/** Deployment schema for the host plugin. */
export const Config = Schema.object({
  ...VOLATILE_QQ_FIELDS,
  allowNonC2c: Schema.boolean().default(false),
  maxImageBytes: Schema.number().min(1).default(DEFAULT_MAX_IMAGE_BYTES),
  apiTimeoutMs: Schema.number().min(1).default(DEFAULT_API_TIMEOUT_MS),
  approvalTimeoutMs: Schema.number().min(1).default(DEFAULT_APPROVAL_TIMEOUT_MS),
})
