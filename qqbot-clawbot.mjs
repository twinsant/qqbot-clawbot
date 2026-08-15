/**
 * QQ bot bridge — persistent host plugin.
 *
 * Connects a QQ Open Platform robot (AppID + AppSecret) via the
 * @tencent-connect/qqbot-nodejs SDK (WebSocket gateway). Inbound messages are
 * forwarded into the workspace's per-day session (`qqbot-YYYY-MM-DD`) and the
 * agent's reply is sent back to QQ. Credentials / target workspace / sender
 * allowlist are persisted in $DSH_HOME/qqbot-clawbot/state.json and restored on
 * restart, so the WebSocket reconnects without re-entering credentials.
 */

import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'qqbot-clawbot'
export const inject = ['tools']

const API_BASE_URL = 'https://api.sgroup.qq.com'
const TOKEN_BASE_URL = 'https://bots.qq.com'
const SOURCE_PLUGIN = 'qqbot-clawbot'
const MARKDOWN_SUPPORT = false
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const API_TIMEOUT_MS = 15_000
// Group messages are dropped by default: TOFU trusts the first sender, which in
// a group is the first member to mention the bot — not necessarily the owner.
// Set QQBOT_ALLOW_GROUP=true to accept group messages (still TOFU-gated).
const ALLOW_GROUP = String(process.env.QQBOT_ALLOW_GROUP || '').toLowerCase() === 'true'

export function apply(ctx) {
  // ---- runtime state (restored from disk on startup) ----
  let bound = null // { appId, appSecret }
  let targetWorkspaceId = null
  let allowedSenders = [] // TOFU: first inbound sender after binding is trusted; others are dropped
  let bot = null
  let botAbort = null
  let msgQueue = Promise.resolve()

  // ---- durable state location ----
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'qqbot-clawbot')
  const stateFile = join(stateDir, 'state.json')

  function dateKey() {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function getState() {
    return {
      bound: Boolean(bound),
      appId: bound ? bound.appId : null,
      targetWorkspaceId,
      allowedSenders: [...allowedSenders],
      connected: Boolean(bot),
    }
  }

  // ---- durable state ----
  function loadState() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf-8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveState() {
    try {
      mkdirSync(stateDir, { recursive: true })
      const payload = {
        appId: bound ? bound.appId : null,
        appSecret: bound ? bound.appSecret : null,
        workspaceId: targetWorkspaceId,
        allowedSenders,
      }
      writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      chmodSync(stateFile, 0o600)
    } catch (error) {
      console.error('[qqbot] saveState failed:', error)
    }
  }

  // ---- bot lifecycle ----
  function stopBot() {
    if (botAbort) {
      botAbort.abort()
      botAbort = null
    }
    if (bot) {
      try { bot.stop() } catch (error) { console.error('[qqbot] stop failed:', error) }
      bot = null
    }
  }

  function startBot(appId, appSecret) {
    stopBot()
    const instance = new QQBot({
      appId,
      appSecret,
      accountId: 'default',
      markdownSupport: MARKDOWN_SUPPORT,
      baseUrl: API_BASE_URL,
      tokenBaseUrl: TOKEN_BASE_URL,
    })
    instance.on('ready', () => console.log('[qqbot] gateway ready'))
    instance.on('resumed', () => console.log('[qqbot] gateway resumed'))
    instance.on('error', err => console.error('[qqbot] gateway error:', err && err.message ? err.message : err))
    instance.on('message', (_ctx, msg) => {
      msgQueue = msgQueue
        .then(() => forwardMessage(msg))
        .catch(error => console.error('[qqbot] forward failed:', error))
    })
    bot = instance
    botAbort = new AbortController()
    void instance.start(botAbort.signal).catch(error => {
      console.error('[qqbot] gateway start failed:', error && error.message ? error.message : error)
    })
  }

  // ---- message shape helpers ----
  // Media URLs are message-supplied (SSRF); only trust Tencent CDN hosts.
  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:') return false
      return ['qq.com', 'gtimg.com', 'myqcloud.com', 'qpic.cn'].some(
        d => u.hostname === d || u.hostname.endsWith(`.${d}`),
      )
    } catch {
      return false
    }
  }

  function sniffImageType(bytes) {
    if (!bytes || bytes.length < 12) return null
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
    return null
  }

  function buildText(msg) {
    const parts = []
    if (typeof msg.content === 'string' && msg.content.trim()) parts.push(msg.content)
    const atts = Array.isArray(msg.attachments) ? msg.attachments : []
    for (const a of atts) {
      if (a && typeof a.asr_refer_text === 'string' && a.asr_refer_text.trim()) {
        parts.push(`[语音转文字] ${a.asr_refer_text}`)
      }
    }
    return parts.join('\n')
  }

  function mediaSummary(a) {
    const ct = (a && a.content_type) || ''
    if (ct.startsWith('image/')) return '[图片]'
    if (ct.startsWith('audio/') || ct.includes('voice')) return '[语音]'
    if (ct.startsWith('video/')) return '[视频]'
    if (a && a.filename) return `[文件: ${a.filename}]`
    return '[附件]'
  }

  async function readBodyCapped(res, maxBytes) {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return null
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > maxBytes) return null
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async function downloadImage(attachment) {
    const url = attachment && attachment.url
    if (!url || !isAllowedMediaUrl(url)) return null
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
      if (!res.ok) return null
      const buf = await readBodyCapped(res, MAX_IMAGE_BYTES)
      if (!buf) return null
      const mediaType = sniffImageType(buf)
      if (!mediaType) return null
      return { data: new Uint8Array(buf), mediaType }
    } catch (error) {
      console.error('[qqbot] image download failed:', error)
      return null
    }
  }

  function collectAssistantText(events, startSeq) {
    let text = ''
    for (let i = startSeq; i < events.length; i++) {
      const ev = events[i]
      if (!ev || ev.type !== 'assistant/message') continue
      const msg = ev.data && ev.data.message
      if (!msg || !Array.isArray(msg.content)) continue
      const parts = []
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          parts.push(block.text)
        }
      }
      const joined = parts.join('')
      if (joined.trim()) text = joined
    }
    return text.trim()
  }

  // ---- daily session ----
  async function ensureDailyAgent(workspaceId) {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('agents service unavailable')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const presets = ctx.get('agentPresets')
    const sessionPersistence = ctx.get('sessionPersistence')

    const baseId = `qqbot-${dateKey()}`
    let sessionId = baseId
    let existing = agents.get(sessionId)
    if (existing !== undefined && !(existing.options && existing.options.model)) {
      sessionId = `${baseId}-r${Date.now().toString(36)}`
      existing = undefined
    }
    if (existing !== undefined) return existing

    const workspace = workspaceRegistry !== undefined ? workspaceRegistry.get(workspaceId) : undefined
    let cwd = workspace !== undefined ? workspace.path : undefined
    if (!cwd) {
      const sp = ctx.get('sandboxPolicy')
      cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
    }
    if (!cwd) throw new Error(`cannot resolve workspace cwd for ${workspaceId}`)

    let agentOptions
    const adm = ctx.get('agentDefaultModel')
    if (adm !== undefined) {
      try {
        const sel = adm.currentSelection()
        if (sel && sel.provider && sel.model) agentOptions = { provider: sel.provider, model: sel.model }
      } catch (error) {
        console.error('[qqbot] default model resolve failed:', error)
      }
    }

    let presetId
    let setup
    if (presets !== undefined) {
      try {
        const resolved = await presets.resolve(undefined)
        presetId = resolved && resolved.id
        if (presetId) setup = async agentCtx => { await presets.mount(agentCtx, presetId) }
      } catch (error) {
        console.error('[qqbot] preset resolve failed; creating without preset:', error)
        presetId = undefined
      }
    }

    let handle
    if (sessionPersistence !== undefined) {
      try {
        const stored = (await sessionPersistence.list()).find(h => h && h.id === sessionId)
        if (stored !== undefined) {
          handle = await agents.resume({
            resumeSessionId: sessionId,
            ...(agentOptions ? { agentOptions } : {}),
            ...(setup ? { setup } : {}),
          })
          return handle.agent
        }
      } catch (error) {
        console.error('[qqbot] resume check failed; will create fresh:', error)
      }
    }

    handle = await agents.create({
      sessionId,
      ...(agentOptions ? { agentOptions } : {}),
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(setup ? { setup } : {}),
    })
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        console.error('[qqbot] attach session failed:', error)
      }
    }
    const titleService = ctx.get('sessionTitle')
    if (titleService) {
      try {
        titleService.rename(handle.agent.session, `QQ · ${dateKey()}`)
      } catch (error) {
        console.error('[qqbot] session rename failed:', error)
      }
    }
    return handle.agent
  }

  // ---- inbound forwarding ----
  function sanitizeInbound(text) {
    return String(text).replace(/\[QQ/g, '［QQ')
  }

  // TOFU: the first sender after binding becomes the only trusted one.
  function isTrustedSender(sender) {
    if (allowedSenders.includes(sender)) return true
    if (sender === 'unknown') return false
    if (allowedSenders.length === 0) {
      allowedSenders = [sender]
      saveState()
      console.log('[qqbot] trusted first sender', sender)
      return true
    }
    return false
  }

  // Whether the target agent's model can accept image content. Images are only
  // attached when the model supports vision; otherwise the message degrades to
  // a "[图片]" label (some adapters reject image blocks outright).
  const modelSupportsImages = (() => {
    let resolved = false
    let supports = false
    return async function check() {
      if (resolved) return supports
      resolved = true
      try {
        const adm = ctx.get('agentDefaultModel')
        const llm = ctx.get('llm')
        const sel = adm ? adm.currentSelection() : null
        if (sel && sel.provider && sel.model && llm) {
          const info = await llm.resolveModelInfo(sel.provider, sel.model)
          if (info && Array.isArray(info.inputModalities)) supports = info.inputModalities.includes('image')
        }
      } catch (error) {
        console.error('[qqbot] model image support check failed:', error)
      }
      return supports
    }
  })()

  async function forwardMessage(msg) {
    if (!targetWorkspaceId) {
      console.error('[qqbot] no target workspace; dropping message')
      return
    }
    if (!bot) return
    const isGroup = msg.kind === 'group'
    if (isGroup && !ALLOW_GROUP) {
      console.error('[qqbot] dropping group message (set QQBOT_ALLOW_GROUP=true to allow)')
      return
    }
    const sender = String(msg.senderId || 'unknown')
    const senderLabel = sender.replace(/[\[\]\r\n]/g, '')
    if (!isTrustedSender(sender)) {
      console.error('[qqbot] dropping message from untrusted sender', senderLabel)
      return
    }
    const kind = isGroup ? 'QQ群' : 'QQ'
    const text = buildText(msg)
    const atts = Array.isArray(msg.attachments) ? msg.attachments : []

    // Download + attach the first image so the agent can actually see it.
    let attachment = null
    let imageAttached = false
    const imageAtt = atts.find(a => a && typeof a.content_type === 'string' && a.content_type.startsWith('image/') && a.url)
    if (imageAtt && await modelSupportsImages()) {
      const img = await downloadImage(imageAtt)
      if (img) {
        try {
          const attachments = ctx.get('attachments')
          if (attachments !== undefined) {
            attachment = await attachments.saveImage(img)
            imageAttached = true
          }
        } catch (error) {
          console.error('[qqbot] saveImage failed:', error)
          attachment = null
          imageAttached = false
        }
      }
    }

    const head = [`[${kind} · ${senderLabel}]`]
    if (text) {
      head.push(sanitizeInbound(text))
    } else {
      for (const a of atts) {
        if (!a || typeof a !== 'object') continue
        if (a === imageAtt && imageAttached) continue
        if (a.asr_refer_text) continue
        head.push(sanitizeInbound(mediaSummary(a)))
      }
      if (head.length === 1) head.push('(无文本内容)')
    }

    const content = [{ type: 'text', text: head.join('\n') }]
    if (attachment) content.push({ type: 'image', attachment })

    const agent = await ensureDailyAgent(targetWorkspaceId)
    const startSeq = agent.session.events.length
    agent.followup({
      id: makeId('qqmsg'),
      role: 'user',
      content,
      source: { kind: 'plugin', plugin: SOURCE_PLUGIN },
    })
    await agent.whenIdle()
    const replyText = collectAssistantText(agent.session.events, startSeq)
    if (replyText && bot) {
      try {
        await bot.sendText(msg.replyTarget, replyText)
      } catch (error) {
        console.error('[qqbot] send reply failed:', error)
      }
    }
  }

  // ---- model tools ----
  ctx.tools.register({
    name: 'qqbot_bind',
    description: '绑定 QQ 机器人：用 AppID 和 AppSecret 连接 QQ Open Platform，消息进入指定工作区当天新建的会话。AppID/AppSecret 在 QQ 开放平台（q.qq.com）机器人页面获取。',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'QQ 机器人 AppID。' },
        appSecret: { type: 'string', description: 'QQ 机器人 AppSecret（仅本次使用，写入本地 600 权限文件）。' },
        workspaceId: { type: 'string', description: '目标工作区 id（可用 qqbot_list_workspaces 查询）。' },
      },
      required: ['appId', 'appSecret'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { bound: { type: 'boolean' }, message: { type: 'string' } },
        required: ['bound', 'message'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message || '' }]
      },
    },
    async execute(args) {
      const appId = String(args.appId || '').trim()
      const appSecret = String(args.appSecret || '').trim()
      if (!appId || !appSecret) {
        return { bound: Boolean(bound), message: 'AppID 和 AppSecret 不能为空' }
      }
      if (args.workspaceId) targetWorkspaceId = String(args.workspaceId)
      bound = { appId, appSecret }
      allowedSenders = []
      saveState()
      startBot(appId, appSecret)
      return { bound: true, message: `QQ 机器人已绑定并启动连接（AppID: ${appId}）` }
    },
  })

  ctx.tools.register({
    name: 'qqbot_status',
    description: '查询 QQ 机器人绑定/连接状态。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          bound: { type: 'boolean' },
          appId: { type: 'string' },
          connected: { type: 'boolean' },
          workspaceId: { type: 'string' },
          allowedSenders: { type: 'array', items: { type: 'string' } },
        },
        required: ['bound', 'connected'],
      },
      render(_args, value) {
        const s = value.bound ? `已绑定 AppID: ${value.appId}` : '未绑定'
        return [{ type: 'text', text: `${s}${value.connected ? '，网关已连接' : ''}` }]
      },
    },
    async execute() {
      const s = getState()
      return {
        bound: s.bound,
        appId: s.appId || '',
        connected: s.connected,
        workspaceId: s.targetWorkspaceId || '',
        allowedSenders: s.allowedSenders,
      }
    },
  })

  ctx.tools.register({
    name: 'qqbot_unbind',
    description: '解绑 QQ 机器人并断开连接。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) {
        return [{ type: 'text', text: value.ok ? '已解绑' : '解绑失败' }]
      },
    },
    async execute() {
      stopBot()
      bound = null
      allowedSenders = []
      saveState()
      return { ok: true }
    },
  })

  ctx.tools.register({
    name: 'qqbot_list_workspaces',
    description: '列出可选的目标工作区（id / 标题 / 路径），用于 QQ 机器人绑定选择。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' } },
              required: ['id'],
            },
          },
        },
        required: ['workspaces'],
      },
      render(_args, value) {
        const list = Array.isArray(value.workspaces) ? value.workspaces : []
        return [{ type: 'text', text: list.map(w => `${w.id}\t${w.title}\t${w.path}`).join('\n') || '(无工作区)' }]
      },
    },
    async execute() {
      const wr = ctx.get('workspaceRegistry')
      if (wr === undefined) return { workspaces: [] }
      const list = wr.list()
      if (!Array.isArray(list)) return { workspaces: [] }
      return { workspaces: list.map(w => ({ id: w.id, title: w.title, path: w.path })) }
    },
  })

  // ---- startup: restore persisted binding, then reconnect ----
  function restoreState() {
    const s = loadState()
    if (s && typeof s.appId === 'string' && s.appId && typeof s.appSecret === 'string' && s.appSecret) {
      bound = { appId: s.appId, appSecret: s.appSecret }
      targetWorkspaceId = typeof s.workspaceId === 'string' ? s.workspaceId : null
      allowedSenders = Array.isArray(s.allowedSenders)
        ? s.allowedSenders.filter(v => typeof v === 'string' && v && v !== 'unknown')
        : []
      console.log('[qqbot] restored bound bot', s.appId)
      startBot(s.appId, s.appSecret)
    }
  }

  restoreState()
  ctx.effect(() => stopBot, 'qqbot-clawbot.lifecycle')
}
