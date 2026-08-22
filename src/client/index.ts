/**
 * QQ bot bridge — client half. Registers the Settings page that writes the
 * `qqbot` namespace; the host half reconnects when that document changes.
 * Export discipline: packages/client/AGENTS.md.
 */

import { useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { QqBotSettings } from '../types.ts'
import { QqBotSection } from './QqBotSection.tsx'
import type { QqBotSectionInjected } from './QqBotSection.tsx'
import { en, zh, type QqBotKey } from './locales.ts'

function bindSnapshotSelector<T>(source: {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}): SnapshotSelectorHook<T> {
  return function useSelector<S>(sel: (s: T) => S): S {
    return useSyncExternalStore(
      source.subscribe,
      () => sel(source.getSnapshot()),
      () => sel(source.getSnapshot()),
    )
  }
}

export type { QqBotSectionInjected, QqBotSectionProps } from './QqBotSection.tsx'
export type { QqBotKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The QQ Bot settings page copy. */
    'settings.qqbot': QqBotKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.qqbot'

/**
 * Required services. The target slot is declared by ui-settings; registration
 * waits on that declaration through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the QQ Bot settings section once `settings.section` is declared.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qqbot-clawbot: copy dictionaries')

  const host = ctx.settingsScope.bind<QqBotSettings>({ namespace: 'qqbot' })
  const useSnapshot = bindSnapshotSelector(host)
  const t = ctx.locale.bind(NS)
  const injected = (): QqBotSectionInjected => ({ host, useSnapshot, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qqbot',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, QqBotSection))
}
