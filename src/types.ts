/**
 * Type vocabulary for the QQ protocol driver. Types only.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/types
 */

/** One inbound QQ attachment the official SDK surfaces. */
export interface QqAttachment {
  /** MIME type when the platform supplied one. */
  readonly content_type?: string
  /** Public download URL. */
  readonly url?: string
  /** Original filename, when present. */
  readonly filename?: string
  /** Platform speech-to-text, when the attachment is voice. */
  readonly asr_refer_text?: string
}

/** Reply destination the SDK accepts for `sendText`. */
export interface QqReplyTarget {
  /** Conversation kind reported by the platform (`c2c`, `group`, …). */
  readonly scope: string
  /** Sender or conversation identity used to route the reply. */
  readonly targetId?: string
}

/** One inbound QQ message after SDK normalization. */
export interface QqInboundMessage {
  /** Conversation kind (`c2c`, `group`, `guild`, `dm`). */
  readonly kind: string
  /** Platform sender id, absent when the SDK could not recover one. */
  readonly senderId?: string
  /** Plain text body. */
  readonly content?: string
  /** Media and voice attachments. */
  readonly attachments?: readonly QqAttachment[]
  /** Destination used to send the agent's reply. */
  readonly replyTarget: QqReplyTarget
}

/** Narrow gateway the host plugin drives; the official SDK is adapted to this. */
export interface QqGateway {
  /**
   * Subscribe to one SDK event.
   * @param event - gateway event name.
   * @param handler - listener; `message` receives the inbound payload as its second argument.
   */
  on(event: 'ready' | 'resumed' | 'error' | 'message', handler: (...args: readonly unknown[]) => void): void
  /**
   * Start the WebSocket gateway.
   * @param signal - abort stops the gateway.
   */
  start(signal: AbortSignal): Promise<void>
  /** Stop the gateway and release its sockets. */
  stop(): void
  /**
   * Send a plain-text reply.
   * @param target - inbound reply destination.
   * @param text - already-rendered assistant text.
   */
  sendText(target: QqReplyTarget, text: string): Promise<void>
}

/** User-document slice of the `qqbot` settings namespace. */
export interface QqBotSettings {
  /** QQ Open Platform AppID. */
  appId: string
  /** QQ Open Platform AppSecret; schema-declared secret, never returned on the wire. */
  appSecret: string
  /** Target workspace id; empty inherits the sandbox workspace root. */
  workspaceId: string
  /** TOFU allowlist of trusted sender ids. */
  allowedSenders: string[]
}

/** Factory that turns AppID and AppSecret into a live gateway. */
export type QqGatewayFactory = (appId: string, appSecret: string) => QqGateway

/** How one inbound image was handled for the model-visible body. */
export interface InboundImageNote {
  /** True when the image was persisted as an attachment content block. */
  readonly inlined: boolean
  /** Local-Ollama description; empty when unavailable or inlined. */
  readonly text: string
  /** On-disk mirror path; present when the image was mirrored. */
  readonly path?: string
}
