/**
 * QQ Open Platform protocol driver. Binds one robot from the `qqbot` settings
 * namespace and forwards inbound C2C messages into a per-day harness session.
 * Binding, workspace choice, and allowlist edits belong to the settings
 * document; this package does not register model-facing tools.
 * @module @deepseek-ai/dsh-qqbot-clawbot
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Config } from './schema.ts'
import type { QqBotSettings, QqGateway, QqInboundMessage, QqReplyTarget } from './types.ts'
import {
  dailySessionId,
  firstImageAttachment,
  formatInboundBody,
  isAllowedMediaUrl,
  parseApprovalDecision,
  sniffImageType,
  trustSender,
} from './policy.ts'
import { collectAssistantReply } from './reply.ts'
import { QQ_NS, QQ_SCHEMA } from './schema.ts'

export const name = 'qqbot-clawbot'
export const inject = ['agents', 'settings']
export { Config } from './schema.ts'
export type { QqBotSettings } from './types.ts'
export {
  dailySessionId,
  dateKey,
  isAllowedMediaUrl,
  parseApprovalDecision,
  sanitizeInbound,
  sniffImageType,
  trustSender,
} from './policy.ts'
export { QQ_NS, QQ_SCHEMA } from './schema.ts'

const SOURCE_PLUGIN = 'qqbot-clawbot'
const MARKDOWN_SUPPORT = false
const API_BASE_URL = 'https://api.sgroup.qq.com'
const TOKEN_BASE_URL = 'https://bots.qq.com'
// Local Ollama vision fallback for text-only models (same as the WeChat bridge).
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? 'qwen3.8:27b-mlx'
const OLLAMA_VISION_TIMEOUT_MS = 60_000

/**
 * Adapt the official SDK instance to the narrow gateway this plugin drives.
 * @param appId - QQ Open Platform AppID.
 * @param appSecret - QQ Open Platform AppSecret.
 * @returns a gateway wrapping one SDK client.
 */
export function createOfficialGateway(appId: string, appSecret: string): QqGateway {
  return new QQBot({
    appId,
    appSecret,
    accountId: 'default',
    markdownSupport: MARKDOWN_SUPPORT,
    baseUrl: API_BASE_URL,
    tokenBaseUrl: TOKEN_BASE_URL,
  }) as unknown as QqGateway
}

/**
 * Mount the QQ protocol driver.
 * @param ctx - context carrying `agents` and `settings`.
 * @param config - deployment knobs for group admission, image caps, and approval timeout.
 * @param createGateway - gateway factory; production uses the official SDK, tests pass a fake.
 */
export function apply(ctx: Context, config: Config, createGateway = createOfficialGateway): void {
  ctx.settings.register(QQ_NS, QQ_SCHEMA)

  let bound: { appId: string; appSecret: string } | undefined
  let targetWorkspaceId = ''
  let allowedSenders: string[] = []
  let bot: QqGateway | undefined
  let botAbort: AbortController | undefined
  let messageQueue: Promise<void> = Promise.resolve()
  let currentTarget: QqReplyTarget | undefined
  let pendingApproval: { senderId: string; resolve: (outcome: ApprovalOutcome) => void } | undefined
  const dailyAgentIds = new Set<string>()
  const imageSupport = createImageSupportProbe(ctx)

  const stopBot = (): void => {
    botAbort?.abort()
    botAbort = undefined
    if (bot === undefined) return
    try {
      bot.stop()
    } catch (error) {
      console.error('[qqbot] stop failed:', error)
    }
    bot = undefined
  }

  const startBot = (appId: string, appSecret: string): void => {
    stopBot()
    const instance = createGateway(appId, appSecret)
    instance.on('ready', () => { console.log('[qqbot] gateway ready') })
    instance.on('resumed', () => { console.log('[qqbot] gateway resumed') })
    instance.on('error', (err) => {
      console.error('[qqbot] gateway error:', err instanceof Error ? err.message : err)
    })
    instance.on('message', (_sdkCtx, raw) => {
      const message = raw as QqInboundMessage
      const sender = message.senderId ?? 'unknown'
      if (pendingApproval !== undefined && pendingApproval.senderId === sender) {
        const decision = parseApprovalDecision(message.content ?? '')
        if (decision === null) {
          void instance.sendText(message.replyTarget, '请回复「允许」或「拒绝」').catch(() => {})
          return
        }
        const resolve = pendingApproval.resolve
        pendingApproval = undefined
        resolve(decision)
        return
      }
      messageQueue = messageQueue
        .then(() => forwardMessage(message))
        .catch((error: unknown) => { console.error('[qqbot] forward failed:', error) })
    })
    bot = instance
    botAbort = new AbortController()
    void instance.start(botAbort.signal).catch((error: unknown) => {
      console.error('[qqbot] gateway start failed:', error instanceof Error ? error.message : error)
    })
  }

  const persistAllowedSenders = (): void => {
    void ctx.settings.update(QQ_NS, { allowedSenders: [...allowedSenders] }).catch(() => {})
  }

  const applySettings = (): void => {
    const value = (ctx.settings.get(QQ_NS) as QqBotSettings | undefined) ?? emptySettings()
    const appId = value.appId.trim()
    const appSecret = value.appSecret.trim()
    targetWorkspaceId = value.workspaceId
    if (Array.isArray(value.allowedSenders)) {
      allowedSenders = value.allowedSenders.filter((item: string) => item.length > 0 && item !== 'unknown')
    }
    const current = bound
    if (appId && appSecret) {
      if (current?.appId !== appId || current.appSecret !== appSecret) {
        bound = { appId, appSecret }
        startBot(appId, appSecret)
        console.log('[qqbot] bound', appId)
      }
      return
    }
    if (bound !== undefined) {
      stopBot()
      bound = undefined
    }
  }

  const answerQqApproval = (req: ApprovalRequest): Promise<ApprovalOutcome | null> => {
    const target = currentTarget
    const live = bot
    if (target === undefined || live === undefined) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => { finish('cancelled') }, config.approvalTimeoutMs)
      const finish = (outcome: ApprovalOutcome | null): void => {
        if (settled) return
        settled = true
        if (pendingApproval?.resolve === finish) pendingApproval = undefined
        req.signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        resolve(outcome)
      }
      const onAbort = (): void => { finish('cancelled') }
      if (req.signal?.aborted === true) {
        finish('cancelled')
        return
      }
      req.signal?.addEventListener('abort', onAbort, { once: true })
      pendingApproval = { senderId: target.targetId ?? '', resolve: finish }
      const text = `⚠️ 需要审批\n${describeToolCall(req)}\n请回复「允许」或「拒绝」`
      void live.sendText(target, text).catch((error: unknown) => {
        console.error('[qqbot] approval send failed:', error)
        finish(null)
      })
    })
  }

  ctx.on('approval/request', async (req, next) => {
    if (!dailyAgentIds.has(String(req.agent.id))) return next()
    if (currentTarget?.scope !== 'c2c' || bot === undefined) return next()
    try {
      const outcome = await answerQqApproval(req)
      return outcome ?? await next()
    } catch (error) {
      console.error('[qqbot] approval answer failed:', error)
      return next()
    }
  }, { prepend: true })

  async function forwardMessage(message: QqInboundMessage): Promise<void> {
    if (!targetWorkspaceId) {
      console.error('[qqbot] no target workspace; dropping message')
      return
    }
    const live = bot
    if (live === undefined) return
    if (message.kind !== 'c2c' && !config.allowNonC2c) {
      console.error('[qqbot] dropping non-c2c message (set allowNonC2c: true to allow)')
      return
    }
    const sender = message.senderId ?? 'unknown'
    const trust = trustSender(sender, allowedSenders)
    if (!trust.trusted) {
      console.error('[qqbot] dropping message from untrusted sender', sender.replace(/[[\]\r\n]/g, ''))
      return
    }
    if (trust.firstTrust !== undefined) {
      allowedSenders = [trust.firstTrust]
      persistAllowedSenders()
      console.log('[qqbot] trusted first sender', trust.firstTrust)
    }

    const imageAtt = firstImageAttachment(message.attachments ?? [])
    let imageInlined = false
    let imageDescription: string | undefined
    let imagePath: string | undefined
    const content: ContentBlock[] = []
    if (imageAtt?.url !== undefined) {
      if (await imageSupport()) {
        const image = await downloadImage(imageAtt.url, config.maxImageBytes, config.apiTimeoutMs)
        const attachments = ctx.get('attachments')
        if (image !== null && attachments !== undefined) {
          try {
            content.push({ type: 'image', attachment: await attachments.saveImage(image) })
            imageInlined = true
          } catch (error) {
            console.error('[qqbot] saveImage failed:', error)
          }
        }
      } else {
        // Text-only model: describe the image through local Ollama and mirror it
        // under the workspace so the agent reads this image, not a stale WeChat one.
        const image = await downloadImage(imageAtt.url, config.maxImageBytes, config.apiTimeoutMs)
        if (image !== null) {
          const description = await describeImageBytes(image.data)
          if (description !== null) imageDescription = description
          const mirrorPath = mirrorImage(resolveWorkspacePath(ctx, targetWorkspaceId), image.data, image.mediaType, 'qqbot-inbox')
          if (mirrorPath !== null) imagePath = mirrorPath
        }
      }
    }
    content.unshift({ type: 'text', text: formatInboundBody(message, imageInlined, imageDescription, imagePath) })

    currentTarget = message.replyTarget
    const followup = createUserMessage({
      content,
      source: { kind: 'plugin', plugin: SOURCE_PLUGIN },
    })
    try {
      const agent = await ensureDailyAgent(ctx, targetWorkspaceId, dailyAgentIds)
      const collector = collectAssistantReply(agent, followup.id)
      agent.followup(followup)
      const replyText = await collector.done()
      if (replyText) {
        try {
          await live.sendText(message.replyTarget, replyText)
        } catch (error) {
          console.error('[qqbot] send reply failed:', error)
        }
      }
    } finally {
      currentTarget = undefined
    }
  }

  ctx.on('settings/updated', (ns) => {
    if (ns === QQ_NS) applySettings()
  })
  applySettings()
  ctx.effect(() => stopBot, 'qqbot-clawbot.lifecycle')
}

function emptySettings(): QqBotSettings {
  return { appId: '', appSecret: '', workspaceId: '', allowedSenders: [] }
}

function describeToolCall(req: ApprovalRequest): string {
  const lines = [`工具: ${req.toolName}`]
  const events = req.agent.session.events
  if (req.callId !== undefined) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'tool/call' && event.data.callId === req.callId) {
        const args = event.data.arguments
        if (args && args !== '{}') lines.push(`参数: ${args.length > 600 ? `${args.slice(0, 600)}…` : args}`)
        break
      }
    }
  }
  if (req.reason) lines.push(`原因: ${req.reason}`)
  return lines.join('\n')
}

function createImageSupportProbe(ctx: Context): () => Promise<boolean> {
  let resolved = false
  let supports = false
  return async () => {
    if (resolved) return supports
    resolved = true
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      const llm = ctx.get('llm')
      if (selection?.provider && selection.model && llm !== undefined) {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        supports = info.inputModalities?.includes('image') === true
      }
    } catch (error) {
      console.error('[qqbot] model image support check failed:', error)
    }
    return supports
  }
}

/**
 * Download one inbound image through the host HTTPS client.
 * @param url - already host-checked URL.
 * @param maxBytes - complete-body byte cap.
 * @param timeoutMs - abort deadline.
 * @returns image bytes and sniffed MIME type, or `null` when admission fails.
 */
export async function downloadImage(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ data: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' } | null> {
  if (!isAllowedMediaUrl(url)) return null
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!response.ok || response.body === null) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return null
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      total += bytes.length
      if (total > maxBytes) return null
      chunks.push(bytes)
    }
    const data = concatBytes(chunks, total)
    const mediaType = sniffImageType(data)
    if (mediaType === null) return null
    return { data, mediaType }
  } catch (error) {
    console.error('[qqbot] image download failed:', error)
    return null
  }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Describe one encoded image through the local Ollama vision endpoint so a
 * text-only model still receives its content as readable text.
 * @param data - encoded image bytes.
 * @returns a short Chinese description, or `null` when the endpoint is unavailable.
 */
export async function describeImageBytes(data: Uint8Array): Promise<string | null> {
  if (data.length === 0) return null
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL,
        prompt: '用一句中文描述这张图片的内容，不要猜测不存在的内容。',
        images: [Buffer.from(data).toString('base64')],
        stream: false,
        think: false,
        options: { num_predict: 80, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const payload = await response.json() as { response?: unknown }
    const text = String(payload.response ?? '').trim()
    return text || null
  } catch (error) {
    console.error('[qqbot] vision describe failed:', error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Resolve the bound workspace's filesystem path, falling back to the sandbox root.
 * @param ctx - host context.
 * @param workspaceId - settings-selected workspace id.
 * @returns a writable workspace directory, or `undefined` when neither source resolves.
 */
function resolveWorkspacePath(ctx: Context, workspaceId: string): string | undefined {
  const workspace = ctx.get('workspaceRegistry')?.get(WorkspaceId(workspaceId))
  return workspace?.path ?? ctx.get('sandboxPolicy')?.workspaceRoot
}

/** File extension for one accepted image media type. */
function imageExtension(mediaType: string): string {
  const extensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  }
  return extensions[mediaType] ?? '.img'
}

/**
 * Mirror one inbound image under `<workspace>/.dsh/attachments/<date>/` so the
 * agent and the user can find it on disk. Non-fatal: a mirror failure leaves
 * the description-only path intact.
 * @param workspacePath - resolved workspace directory.
 * @param bytes - encoded image bytes.
 * @param mediaType - sniffed media type.
 * @param prefix - filename prefix separating this bridge's images.
 * @returns the written path, or `null` on failure.
 */
function mirrorImage(workspacePath: string | undefined, bytes: Uint8Array, mediaType: string, prefix: string): string | null {
  if (workspacePath === undefined || bytes.length === 0) return null
  try {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const dateDir = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const dir = join(workspacePath, '.dsh', 'attachments', dateDir)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${stamp}-${prefix}-${Math.random().toString(36).slice(2, 8)}${imageExtension(mediaType)}`)
    writeFileSync(file, bytes)
    return file
  } catch (error) {
    console.error('[qqbot] mirror image failed:', error)
    return null
  }
}

/**
 * Resume or create the per-day agent for the bound workspace.
 * @param ctx - host context.
 * @param workspaceId - settings-selected workspace id.
 * @param dailyAgentIds - set that records every session this driver owns for approval routing.
 * @returns the live agent.
 */
export async function ensureDailyAgent(
  ctx: Context,
  workspaceId: string,
  dailyAgentIds: Set<string>,
): Promise<import('@deepseek-ai/dsh-agent').Agent> {
  const baseId = dailySessionId()
  let sessionId = SessionId(baseId)
  let existing = ctx.agents.get(sessionId)
  if (existing !== undefined && existing.options.model === undefined) {
    sessionId = SessionId(`${baseId}-r${Date.now().toString(36)}`)
    existing = undefined
  }
  dailyAgentIds.add(sessionId)
  if (existing !== undefined) return existing

  const workspace = ctx.get('workspaceRegistry')?.get(WorkspaceId(workspaceId))
  const cwd = workspace?.path ?? ctx.get('sandboxPolicy')?.workspaceRoot
  if (cwd === undefined) throw new Error(`cannot resolve workspace cwd for ${workspaceId}`)

  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const agentOptions = selection?.provider && selection.model
    ? { provider: selection.provider, model: selection.model }
    : undefined

  let presetId: string | undefined
  const presets = ctx.get('agentPresets')
  if (presets !== undefined) {
    try {
      presetId = (await presets.resolve(undefined)).id
    } catch (error) {
      console.error('[qqbot] preset resolve failed; creating without preset:', error)
    }
  }
  const setup = presets !== undefined && presetId !== undefined
    ? async (agentCtx: Context) => { await presets.mount(agentCtx, presetId) }
    : undefined

  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    try {
      const headers = await persistence.list()
      if (headers.some(header => header.id === sessionId)) {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...agentOptions === undefined ? {} : { agentOptions },
          ...setup === undefined ? {} : { setup },
        })
        return handle.agent
      }
    } catch (error) {
      console.error('[qqbot] resume check failed; will create fresh:', error)
    }
  }

  const handle = await ctx.agents.create({
    sessionId,
    ...agentOptions === undefined ? {} : { agentOptions },
    meta: { cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
    ...setup === undefined ? {} : { setup },
  })
  if (workspace !== undefined) {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      console.error('[qqbot] attach session failed:', error)
    }
  }
  try {
    ctx.get('sessionTitle')?.rename(handle.agent.session, `QQ · ${dailySessionId().slice('qqbot-'.length)}`)
  } catch (error) {
    console.error('[qqbot] session rename failed:', error)
  }
  return handle.agent
}
