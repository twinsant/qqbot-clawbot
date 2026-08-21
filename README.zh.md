# @deepseek-ai/dsh-qqbot-clawbot

[English](README.md) | 中文

QQ 开放平台协议驱动。它从 `qqbot` 设置命名空间绑定一台机器人，并把入站 C2C 消息转发到所选工作区的按日会话。

本包是传输适配器，不是能力缝。绑定、工作区选择和发送者允许名单写在设置文档里；该命名空间变化时，host 插件会重连。它不注册面向模型的工具。

## 绑定

Web UI 的「设置 → QQ 机器人」把 AppID、AppSecret、工作区 id 和发送者允许名单写入 `qqbot` 命名空间。`appSecret` 是 `role('secret')` 字段：线路上的 describe 从不返回明文，表单留空则保留已存储的密钥。

解析后的分节带有非空 AppID 和 AppSecret 时，host 插件启动 WebSocket 网关；任一字段被清空则停止网关。

## 入站约定

- **默认仅 C2C** — 除非 `allowNonC2c: true`，否则丢弃群、频道和 DM。TOFU 信任第一位发送者，在群里那是第一个 @ 机器人的成员。
- **发送者允许名单（TOFU）** — 绑定后的第一位真实发送者会被记录；之后的陌生人被丢弃。`unknown` 永远不会成为首次信任对象。
- **入站成帧** — 每次跟进都是 `createUserMessage`，`source: { kind: 'plugin', plugin: 'qqbot-clawbot' }`。模型可见文本以 `[QQ · <sender>]` 开头；入站文本里的该前缀会被改写，无法冒充。
- **回包** — 驱动在该次跟进之后监听 `session/event` 上已提交的 `assistant/message` 文本，等待 `whenIdle()`，再把最后一段已提交文本发回 QQ。未提交的 chunk 不是回包。
- **图片** — 仅接受腾讯 CDN 主机上的 HTTPS URL，受 `maxImageBytes` 限制，并且只有默认模型声明图像输入时才会内联。
- **HITL** — 当日 QQ agent 在进行中的 C2C 会话里收到的 `approval/request` 在 QQ 中回答（`允许` / `拒绝`）；其他会话交给下一个回答者。

按日会话 id 是主机本地时区的 `qqbot-YYYY-MM-DD`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowNonC2c` | `false` | 接受群、频道和 DM 消息。 |
| `maxImageBytes` | `20971520` | 单张入站图片正文的硬上限。 |
| `apiTimeoutMs` | `15000` | 入站图片下载超过该毫秒数后中止。 |
| `approvalTimeoutMs` | `300000` | QQ 侧审批提示超过该毫秒数后撤回。 |

## 安装

web profile 通过 `dsh-web-app` 挂载本包。自定义 profile 插入：

```yaml
- insert:
    - id: qqbot-clawbot
      name: '@deepseek-ai/dsh-qqbot-clawbot'
```

在 [q.qq.com](https://q.qq.com/) 创建机器人，重启 `dsh web`，在「设置 → QQ 机器人」填写 AppID / AppSecret。

## Model Experience

### 入站跟进

#### What the model sees

每条获准的 QQ 消息成为一条 `user/message`，文本以 `[QQ · <sender>]` 或 `[QQ群 · <sender>]` / `[QQ频道 · <sender>]` 开头，随后是入站正文。入站文本里的 `[QQ` 会被改写成 `［QQ`。语音附件贡献 `[语音转文字] …`。默认模型接受的图片作为并列图像块出现；其他媒体变成 `[图片]` 这类占位。协议元数据不会进入请求。

#### Token effect

提示词 token 随数据变化，并保留在当日会话历史中直到压缩。

#### KV Cache effect

只追加。每次入站跟进都是可复用请求前缀之后的一条新用户消息。

## Known Limitations and Deferred Work

- **一台机器人，一个按日会话** — 每个进程只有一条网关和一份 `qqbot-YYYY-MM-DD` 会话；并发 C2C 聊天共用该会话。
- **线路上的密钥槽是只写的** — 设置页把已存储的 AppID 视为已绑定，从不回显 AppSecret。
- **默认关闭群准入** — 当第一位说话人不是所有者时，TOFU 不安全。
