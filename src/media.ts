/**
 * Local-file resolution and platform limits for outbound QQ media.
 *
 * Kept apart from the tool wiring so the refusal rules are pure enough to test
 * without a gateway: one function decides whether a path may be uploaded.
 * @module @deepseek-ai/dsh-qqbot-clawbot/src/media
 */

import { realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'

/** Kinds of file this driver uploads. */
export type MediaKind = 'image' | 'file'

/**
 * Largest payload the platform accepts per kind, from the SDK's own table:
 * images are one-shot uploads, files may reach the chunked path.
 */
export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 30 * 1024 * 1024,
  file: 100 * 1024 * 1024,
}

/** Extensions QQ renders inline. `qq_send_image` refuses anything else. */
export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

/** A local file cleared for upload. */
export interface SendableMedia {
  /** Resolved real path handed to the SDK. */
  readonly path: string
  /** File name shown in the conversation. */
  readonly name: string
  /** Size in bytes. */
  readonly size: number
}

/** Refusal whose message is written for the model to act on. */
export class MediaRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaRefusal'
  }
}

/**
 * Render a byte count for a human-facing message.
 * @param size - bytes.
 * @returns compact form such as `12.3KB`.
 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Resolve one requested path to a file this driver may upload.
 *
 * The workspace boundary is deliberate: a chat-driven agent can already produce
 * files, but letting it upload anything the host can read would turn a QQ
 * message into an exfiltration channel. Relative paths resolve against the
 * workspace, and symlinks are followed before the check so a link cannot point
 * outside it.
 * @param workspaceRoot - workspace directory the QQ session runs in.
 * @param requested - path supplied by the model, absolute or workspace-relative.
 * @param kind - which platform limit and extension rule applies.
 * @returns the sendable file.
 */
export function resolveSendableMedia(
  workspaceRoot: string | undefined,
  requested: string,
  kind: MediaKind,
): SendableMedia {
  const trimmed = requested.trim()
  if (trimmed === '') throw new MediaRefusal('path 为空：给出要发送的文件路径。')
  if (workspaceRoot === undefined) throw new MediaRefusal('QQ 会话没有可用工作区，无法定位要发送的文件。')

  const candidate = isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed)
  let path: string
  try {
    path = realpathSync(candidate)
  } catch {
    throw new MediaRefusal(`找不到文件：${candidate}`)
  }

  let root: string
  try {
    root = realpathSync(workspaceRoot)
  } catch {
    throw new MediaRefusal(`工作区目录不存在：${workspaceRoot}`)
  }
  const inside = relative(root, path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new MediaRefusal(
      `只允许发送工作区内的文件（${root}）：${path} 在工作区外。先把文件放进工作区，例如 tmp/。`,
    )
  }

  const stats = statSync(path)
  if (!stats.isFile()) throw new MediaRefusal(`不是普通文件：${path}`)

  const extension = extname(path).toLowerCase()
  if (kind === 'image' && !IMAGE_EXTENSIONS.includes(extension)) {
    throw new MediaRefusal(
      `${basename(path)} 不是 QQ 能内联显示的图片（支持 ${IMAGE_EXTENSIONS.join(' ')}）。`
      + '要发别的格式就用 qq_send_file。',
    )
  }

  const limit = MEDIA_LIMITS[kind]
  if (stats.size === 0) throw new MediaRefusal(`${basename(path)} 是空文件，QQ 会拒收。`)
  if (stats.size > limit) {
    throw new MediaRefusal(
      `${basename(path)} 有 ${formatBytes(stats.size)}，超过 QQ 的 ${formatBytes(limit)} 上限。`,
    )
  }

  return { path, name: basename(path), size: stats.size }
}

/**
 * Turn a caught upload error into one line for the model.
 * @param error - whatever the SDK threw.
 * @returns a single-line reason.
 */
export function describeMediaError(error: unknown): string {
  if (error instanceof MediaRefusal) return error.message
  const message = error instanceof Error ? error.message : String(error)
  const body = (error as { body?: unknown } | null)?.body
  return body === undefined ? message : `${message} (${JSON.stringify(body)})`
}
