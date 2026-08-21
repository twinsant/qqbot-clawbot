/**
 * Collect committed assistant text for one QQ reply from the live session event stream.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/reply
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'

/** Live collection of one follow-up's committed assistant text. */
export interface ReplyCollector {
  /**
   * Resolve after the owning agent reaches idle, returning the last committed assistant text.
   * @returns trimmed text, or an empty string when the turn produced none.
   */
  done(): Promise<string>
  /** Stop listening without waiting for idle. */
  dispose(): void
}

/**
 * Subscribe to `session/event` for one agent's session and keep the last committed assistant text.
 * Chunks are not a substitute for the committed message: the reply must survive replay of the log.
 * @param agent - agent that received the follow-up.
 * @param messageId - inbound follow-up identity; collection starts after that user message is logged.
 * @returns a collector whose `done()` waits for `whenIdle()`.
 */
export function collectAssistantReply(agent: Agent, messageId: MessageId): ReplyCollector {
  let started = false
  let text = ''
  const off = agent.ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (event.type === 'user/message' && event.data.id === messageId) {
      started = true
      return
    }
    if (!started || event.type !== 'assistant/message') return
    const parts: string[] = []
    for (const block of event.data.message.content) {
      if (block.type === 'text' && block.text.trim()) parts.push(block.text)
    }
    const joined = parts.join('')
    if (joined.trim()) text = joined
  })
  return {
    async done(): Promise<string> {
      try {
        await agent.whenIdle()
        return text.trim()
      } finally {
        off()
      }
    },
    dispose(): void {
      off()
    },
  }
}
