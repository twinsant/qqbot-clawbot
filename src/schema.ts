/**
 * Settings and plugin-config schemas for the QQ protocol driver.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/schema
 */

import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { QqBotSettings } from './types.ts'

/** Deployment knobs for the QQ protocol driver. */
export interface Config {
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
export const QQ_NS = settingsNamespace('qqbot')

/** User-document schema for the `qqbot` namespace. */
export const QQ_SCHEMA: Schema<QqBotSettings> = Schema.object({
  appId: Schema.string().default(''),
  appSecret: Schema.string().role('secret').default(''),
  workspaceId: Schema.string().default(''),
  allowedSenders: Schema.array(Schema.string()).default([]),
})

/** Default image-download timeout. */
export const DEFAULT_API_TIMEOUT_MS = 15_000
/** Default inbound-image byte cap. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default QQ-side approval prompt lifetime. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** Deployment schema for the host plugin. */
export const Config: Schema<Config> = Schema.object({
  allowNonC2c: Schema.boolean().default(false),
  maxImageBytes: Schema.number().min(1).default(DEFAULT_MAX_IMAGE_BYTES),
  apiTimeoutMs: Schema.number().min(1).default(DEFAULT_API_TIMEOUT_MS),
  approvalTimeoutMs: Schema.number().min(1).default(DEFAULT_APPROVAL_TIMEOUT_MS),
})
