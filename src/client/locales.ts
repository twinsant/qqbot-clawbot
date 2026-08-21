/** Copy dictionaries for the QQ Bot settings section. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  nav: 'QQ 机器人',
  title: 'QQ 机器人',
  intro: '填写开放平台 AppID 与 AppSecret，选择要把消息桥接到的工作区。',
  appId: 'AppID',
  appIdHint: '在 q.qq.com 机器人页面获取。',
  appSecret: 'AppSecret',
  appSecretHint: '密钥不会随设置描述返回；已配置时输入框保持空白。',
  appSecretShow: '显示 AppSecret',
  appSecretHide: '隐藏 AppSecret',
  workspaceId: '目标工作区 id',
  workspaceIdHint: '绑定后，当日会话使用该工作区的路径作为 cwd。',
  save: '保存并连接',
  saving: '保存中…',
  bound: '已绑定 AppID: {appId}',
  unbound: '未绑定',
  readOnly: '当前部署的设置文档为只读。',
} satisfies Record<string, string>

/** Dictionary key union owned by this plugin. */
export type QqBotKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  nav: 'QQ Bot',
  title: 'QQ Bot',
  intro: 'Enter the Open Platform AppID and AppSecret, then choose the workspace that receives inbound messages.',
  appId: 'AppID',
  appIdHint: 'Copy this from the robot page at q.qq.com.',
  appSecret: 'AppSecret',
  appSecretHint: 'The secret is never returned on a settings describe; the field stays blank once configured.',
  appSecretShow: 'Show AppSecret',
  appSecretHide: 'Hide AppSecret',
  workspaceId: 'Target workspace id',
  workspaceIdHint: 'After binding, the daily session uses that workspace path as cwd.',
  save: 'Save and connect',
  saving: 'Saving…',
  bound: 'Bound AppID: {appId}',
  unbound: 'Not bound',
  readOnly: 'The settings document is read-only in this deployment.',
} satisfies Record<QqBotKey, string>
