import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { QqGateway, QqInboundMessage } from '../src/types.ts'
import { apply, inject, name, Config } from '../src/index.ts'
import { QQ_NS } from '../src/schema.ts'
import { dailySessionId } from '../src/policy.ts'
import { collectAssistantReply } from '../src/reply.ts'

interface FakeGateway extends QqGateway {
  handlers: Map<string, (...args: readonly unknown[]) => void>
  started: boolean
  stopped: boolean
  sent: Array<{ target: unknown; text: string }>
}

function createFakeGateway(): FakeGateway {
  const handlers = new Map<string, (...args: readonly unknown[]) => void>()
  return {
    handlers,
    started: false,
    stopped: false,
    sent: [],
    on(event, handler) { handlers.set(event, handler) },
    async start() { this.started = true },
    stop() { this.stopped = true },
    async sendText(target, text) { this.sent.push({ target, text }) },
  }
}

function fakeAgent(id = dailySessionId()): Agent {
  const scope = new Context()
  const session = Session.create(SessionId(id))
  return {
    id: SessionId(id),
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    inbox: {
      nextTurn: [], nextStep: [],
      clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [],
    },
    status: 'idle',
    ctx: scope,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const config = {
  allowNonC2c: false,
  maxImageBytes: 1024,
  apiTimeoutMs: 50,
  approvalTimeoutMs: 20,
}

describe('qqbot-clawbot plugin', () => {
  let ctx: Context | undefined
  let gateway: FakeGateway | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    gateway = undefined
  })

  async function boot(doc: Record<string, unknown> = {}): Promise<Context> {
    const root = new Context()
    ctx = root
    await root.plugin(AgentRegistry)
    await root.plugin(Loader)
    root.provide('settings', {
      configure: () => () => {},
      update: async (_ns: string, patch: object) => {
        const entry = root.loader.resolve(QQ_NS)
        await entry.update({ config: { ...entry.options.config as object, ...patch } })
        await entry.fiber!.await()
      },
    } as never)
    gateway = createFakeGateway()
    root.loader.builtins.qqbot = {
      name, inject, Config,
      apply: (pluginCtx: Context, pluginConfig: Config) => apply(pluginCtx, pluginConfig, () => {
        gateway = createFakeGateway()
        return gateway
      }),
    }
    const entryOptions = { id: QQ_NS, name: 'cordis:qqbot', config: { ...config, ...doc.qqbot as object } }
    await root.loader.create(entryOptions)
    await root.loader.resolve(QQ_NS).fiber!.await()
    return root
  }

  it('exports a namespace plugin without a default export', async () => {
    expect(name).toBe('qqbot-clawbot')
    expect(inject).toEqual(['agents', 'settings'])
    expect((await import('../src/index.ts') as { default?: unknown }).default).toBeUndefined()
  })

  it('starts the gateway when settings carry AppID and AppSecret', async () => {
    await boot({ qqbot: { appId: 'app', appSecret: 'secret', workspaceId: 'ws', allowedSenders: [] } })
    expect(gateway?.started).toBe(true)
  })

  it('does not start without credentials and stops after they are cleared', async () => {
    const root = await boot({ qqbot: { appId: '', appSecret: '', workspaceId: 'ws', allowedSenders: [] } })
    expect(gateway?.started).toBe(false)
    await root.settings.update(QQ_NS, { appId: 'app', appSecret: 'secret', workspaceId: 'ws' })
    expect(gateway?.started).toBe(true)
    const live = gateway!
    await root.settings.update(QQ_NS, { appId: '', appSecret: '', workspaceId: 'ws' })
    expect(live.stopped).toBe(true)
  })

  it('forwards a trusted C2C message through createUserMessage and replies from session/event', async () => {
    const root = await boot({
      qqbot: { appId: 'app', appSecret: 'secret', workspaceId: 'ws-1', allowedSenders: ['alice'] },
    })
    const agent = fakeAgent()
    const followups: unknown[] = []
    agent.followup = (message) => { followups.push(message) }
    vi.spyOn(root.agents, 'get').mockReturnValue(agent)
    root.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' } as never)

    const inbound: QqInboundMessage = {
      kind: 'c2c',
      senderId: 'alice',
      content: 'ping',
      attachments: [],
      replyTarget: { scope: 'c2c', targetId: 'alice' },
    }
    const messageHandler = gateway!.handlers.get('message')
    expect(messageHandler).toBeDefined()
    messageHandler!(undefined, inbound)
    await vi.waitFor(() => { expect(followups).toHaveLength(1) })
    const message = followups[0] as {
      id: string
      role: string
      source: { kind: string }
      content: Array<{ type: string; text?: string }>
    }
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content[0]?.text).toContain('ping')
    expect(message.id).toBeDefined()
  })

  it('drops a group message when allowNonC2c is false', async () => {
    const root = await boot({
      qqbot: { appId: 'app', appSecret: 'secret', workspaceId: 'ws-1', allowedSenders: ['alice'] },
    })
    const create = vi.spyOn(root.agents, 'create')
    const inbound: QqInboundMessage = {
      kind: 'group',
      senderId: 'alice',
      content: 'ping',
      attachments: [],
      replyTarget: { scope: 'group', targetId: 'g' },
    }
    gateway!.handlers.get('message')!(undefined, inbound)
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
  })

  it('answers a C2C approval request for a daily agent', async () => {
    const root = await boot({
      qqbot: { appId: 'app', appSecret: 'secret', workspaceId: 'ws-1', allowedSenders: ['alice'] },
    })
    const agent = fakeAgent()
    let releaseIdle: (() => void) | undefined
    agent.whenIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve })
    vi.spyOn(root.agents, 'get').mockReturnValue(agent)
    root.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' } as never)

    gateway!.handlers.get('message')!(undefined, {
      kind: 'c2c',
      senderId: 'alice',
      content: 'ping',
      attachments: [],
      replyTarget: { scope: 'c2c', targetId: 'alice' },
    } satisfies QqInboundMessage)
    await vi.waitFor(() => { expect(releaseIdle).toBeDefined() })

    const request: ApprovalRequest = {
      agent,
      toolName: 'bash',
      reason: 'needs write',
    }
    const decision = root.waterfall('approval/request', request, async () => 'unavailable' as const)
    await vi.waitFor(() => { expect(gateway!.sent.some(item => item.text.includes('需要审批'))).toBe(true) })
    gateway!.handlers.get('message')!(undefined, {
      kind: 'c2c',
      senderId: 'alice',
      content: '允许',
      attachments: [],
      replyTarget: { scope: 'c2c', targetId: 'alice' },
    } satisfies QqInboundMessage)
    await expect(decision).resolves.toBe('allowed-once')
    releaseIdle!()
  })

  it('collects the last committed assistant text after the inbound user message', async () => {
    const agent = fakeAgent()
    const inbound = createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
    const collector = collectAssistantReply(agent, inbound.id)
    agent.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      seq: 0,
      time: 0,
      data: inbound,
    } as never)
    agent.ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'pong' }] } },
    } as never)
    await expect(collector.done()).resolves.toBe('pong')
  })

  it('unregisters the gateway when the plugin fiber disposes', async () => {
    const root = await boot({ qqbot: { appId: 'app', appSecret: 'secret', workspaceId: 'ws', allowedSenders: [] } })
    const live = gateway!
    await root.fiber.dispose()
    ctx = undefined
    expect(live.stopped).toBe(true)
  })
})
