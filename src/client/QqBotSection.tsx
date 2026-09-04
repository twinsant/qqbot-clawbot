/**
 * QQ Bot settings section: AppID, AppSecret, and the target workspace id.
 * The section writes through the bound `qqbot` settings scope; the host plugin
 * reconnects when that namespace changes.
 */

import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { QqBotSettings } from '../types.ts'
import css from './QqBotSection.module.css'

/** Draft fields the page holds until Save. */
export interface QqBotDraft {
  appId: string
  appSecret: string
  workspaceId: string
}

/** Injected dependencies of {@link QqBotSection}. */
export interface QqBotSectionInjected {
  /** Bound `qqbot` settings scope. */
  host: SettingsScope<QqBotSettings>
  /** uSES hook over the scope snapshot. */
  useSnapshot: SnapshotSelectorHook<SettingsScopeSnapshot<QqBotSettings>>
  /** Section copy, bound to `settings.qqbot`. */
  t: TranslateNS<'settings.qqbot'>
}

/** Props delivered by the slot outlet. */
export type QqBotSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.qqbot'>
  & QqBotSectionInjected

/**
 * Render the QQ Bot settings page.
 * @param props - composed slot props plus the inject face.
 * @returns the section tree, or null when the inject face is absent.
 */
export function QqBotSection(props: QqBotSectionProps) {
  const { host, useSnapshot, t } = props
  return <QqBotSectionBody host={host} useSnapshot={useSnapshot} t={t} />
}

function QqBotSectionBody({
  host,
  useSnapshot,
  t,
}: QqBotSectionInjected) {
  const snap = useSnapshot(snapshot => snapshot)
  const value = snap.value
  const [draft, setDraft] = useState<QqBotDraft>(() => ({
    appId: value?.appId ?? '',
    appSecret: '',
    workspaceId: value?.workspaceId ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const bound = Boolean(value?.appId)
  const writable = snap.writable
  const canSave = writable && !saving && draft.appId.trim().length > 0
    && (draft.appSecret.trim().length > 0 || bound)

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      await host.set('appId', draft.appId.trim())
      if (draft.appSecret.trim().length > 0) await host.set('appSecret', draft.appSecret.trim())
      await host.set('workspaceId', draft.workspaceId.trim())
      setDraft(current => ({ ...current, appSecret: '' }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {!writable ? <p className={css.notice}>{t('readOnly')}</p> : null}
      <label className={css.field}>
        <span className={css.label}>{t('appId')}</span>
        <Input
          value={draft.appId}
          onChange={(event) => { setDraft(current => ({ ...current, appId: event.target.value })) }}
          disabled={!writable}
          autoComplete="off"
        />
        <span className={css.hint}>{t('appIdHint')}</span>
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('appSecret')}</span>
        <span className={css.secretRow}>
          <Input
            type={showSecret ? 'text' : 'password'}
            value={draft.appSecret}
            onChange={(event) => { setDraft(current => ({ ...current, appSecret: event.target.value })) }}
            disabled={!writable}
            autoComplete="new-password"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { setShowSecret(current => !current) }}
            aria-label={showSecret ? t('appSecretHide') : t('appSecretShow')}
          >
            {showSecret ? t('appSecretHide') : t('appSecretShow')}
          </Button>
        </span>
        <span className={css.hint}>{t('appSecretHint')}</span>
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('workspaceId')}</span>
        <Input
          value={draft.workspaceId}
          onChange={(event) => { setDraft(current => ({ ...current, workspaceId: event.target.value })) }}
          disabled={!writable}
          autoComplete="off"
        />
        <span className={css.hint}>{t('workspaceIdHint')}</span>
      </label>
      <Button variant="primary" disabled={!canSave} onClick={() => { void save() }}>
        {saving ? t('saving') : t('save')}
      </Button>
      <p className={css.status}>
        {bound ? t('bound', { appId: value?.appId ?? '' }) : t('unbound')}
      </p>
    </div>
  )
}
