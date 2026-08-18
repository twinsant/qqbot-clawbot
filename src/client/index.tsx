// @ts-nocheck
/**
 * QQ bot bridge — client half: the settings section where the user enters the
 * AppID / AppSecret and picks a target workspace. Writes ride the `qqbot`
 * settings namespace; the host half auto-connects on change.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Must match the host half's `settingsNamespace('qqbot')`. */
const QQ_NS = 'qqbot'

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext) {
  const host = ctx.settingsScope.bind({ namespace: QQ_NS })

  function QQBotSection() {
    const [snap, setSnap] = React.useState(host.getSnapshot())
    React.useEffect(() => {
      return host.subscribe(() => setSnap(host.getSnapshot()))
    }, [])

    const val = (snap && snap.value) || {}
    const [appId, setAppId] = React.useState(String(val.appId || ''))
    const [appSecret, setAppSecret] = React.useState(String(val.appSecret || ''))
    const [workspaceId, setWorkspaceId] = React.useState(String(val.workspaceId || ''))
    const [saving, setSaving] = React.useState(false)
    const [showSecret, setShowSecret] = React.useState(false)

    const bound = Boolean(val.appId && val.appSecret)
    const canSave = !saving && appId.trim() && appSecret.trim()

    const save = async () => {
      if (!canSave) return
      setSaving(true)
      try {
        await host.set('appId', appId.trim())
        await host.set('appSecret', appSecret.trim())
        await host.set('workspaceId', workspaceId.trim())
      } finally {
        setSaving(false)
      }
    }

    const field = { width: '100%', padding: 6, marginBottom: 12, boxSizing: 'border-box' }
    const label = { fontSize: 12, color: '#888', marginBottom: 4 }

    return React.createElement('div', { style: { padding: 4 } },
      React.createElement('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 12 } }, 'QQ Bot'),
      React.createElement('div', { style: label }, 'AppID（在 q.qq.com 机器人页面获取）'),
      React.createElement('input', { value: appId, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAppId(e.target.value), placeholder: 'AppID', style: field }),
      React.createElement('div', { style: label }, 'AppSecret'),
      React.createElement('div', { style: { position: 'relative' } },
        React.createElement('input', {
          type: showSecret ? 'text' : 'password',
          value: appSecret,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAppSecret(e.target.value),
          placeholder: 'AppSecret',
          style: { ...field, paddingRight: 32 },
        }),
        React.createElement('button', {
          type: 'button',
          onClick: () => setShowSecret(s => !s),
          title: showSecret ? '隐藏' : '显示',
          'aria-label': showSecret ? '隐藏 AppSecret' : '显示 AppSecret',
          style: {
            position: 'absolute', right: 6, top: 4, border: 'none', background: 'none',
            cursor: 'pointer', padding: 2, fontSize: 14, lineHeight: 1, opacity: 0.7,
          },
        }, showSecret ? '🙈' : '👁'),
      ),
      React.createElement('div', { style: label }, '目标工作区 id（留空用默认工作区）'),
      React.createElement('input', { value: workspaceId, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setWorkspaceId(e.target.value), placeholder: 'workspace id', style: field }),
      React.createElement('button', {
        onClick: save,
        disabled: !canSave,
        style: { padding: '6px 14px', cursor: canSave ? 'pointer' : 'default', opacity: canSave ? 1 : 0.5 },
      }, saving ? '保存中…' : '保存并连接'),
      React.createElement('div', { style: { marginTop: 8, color: bound ? '#333' : '#888' } },
        bound ? `已绑定 AppID: ${val.appId}` : '未绑定'),
    )
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'qqbot', order: 50, label: 'QQ Bot' },
    () => React.createElement(QQBotSection),
  ))
}
