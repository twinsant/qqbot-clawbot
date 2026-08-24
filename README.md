# @deepseek-ai/dsh-qqbot-clawbot

English | [中文](README.zh.md)

QQ Open Platform protocol driver. It binds one robot from the `qqbot` settings namespace and forwards inbound C2C messages into a per-day harness session of a chosen workspace.

This package is a transport adapter, not a capability seam. Binding, workspace choice, and the sender allowlist live in the settings document; the host plugin reconnects when that namespace changes. It does not register model-facing tools.

## Binding

Settings → QQ Bot in the web UI stores AppID, AppSecret, workspace id, and the sender allowlist in the `qqbot` namespace. `appSecret` is a `role('secret')` field: wire describes never return the literal, and a form that leaves the field blank keeps the stored secret.

The host plugin starts the WebSocket gateway when the resolved section carries a non-empty AppID and AppSecret, and stops it when either is cleared.

## Inbound contract

- **C2C only by default** — group, guild, and DM messages are dropped unless `allowNonC2c: true`. TOFU trusts the first sender, which in a group is the first member to mention the bot.
- **Sender allowlist (TOFU)** — the first real sender after binding is recorded; later strangers are dropped. `unknown` never becomes the first trust.
- **Inbound framing** — each follow-up is a `createUserMessage` with `source: { kind: 'plugin', plugin: 'qqbot-clawbot' }`. The model-visible text starts with `[QQ · <sender>]`; inbound copies of that prefix are rewritten so they cannot spoof it.
- **Reply** — the driver listens to `session/event` for committed `assistant/message` text after that follow-up, then waits for `whenIdle()` and sends the last committed text back to QQ. Uncommitted chunks are not replies.
- **Images** — HTTPS URLs on Tencent CDN hosts, capped by `maxImageBytes`, attach inline only when the default model declares image input.
- **HITL** — `approval/request` for a daily QQ agent in an active C2C chat is answered in QQ (`允许` / `拒绝`); other chats fall through to the next answerer. The prompt names the tool and its arguments so the approver can judge the call, but the argument rendering travels over QQ: values held by a credential-named key are withheld, credential-shaped substrings are withheld wherever they appear, the host home directory collapses to `~`, and the rendering is length-capped.

The daily session id is `qqbot-YYYY-MM-DD` in the host local timezone.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `allowNonC2c` | `false` | Accept group, guild, and DM messages. |
| `maxImageBytes` | `20971520` | Hard cap on one inbound image body. |
| `apiTimeoutMs` | `15000` | Abort an inbound image download after this many milliseconds. |
| `approvalTimeoutMs` | `300000` | Withdraw a QQ-side approval prompt after this many milliseconds. |

## Install

The web profile mounts this package from `dsh-web-app`. A custom profile inserts:

```yaml
- insert:
    - id: qqbot-clawbot
      name: '@deepseek-ai/dsh-qqbot-clawbot'
```

Create a robot at [q.qq.com](https://q.qq.com/), restart `dsh web`, and enter AppID / AppSecret under Settings → QQ Bot.

## Model Experience

### Inbound follow-up

#### What the model sees

Each admitted QQ message becomes one `user/message` whose text starts with `[QQ · <sender>]` or `[QQ群 · <sender>]` / `[QQ频道 · <sender>]`, then the inbound body. Inbound copies of `[QQ` are rewritten to `［QQ`. Voice attachments contribute `[语音转文字] …`. An image that the default model accepts appears as a sibling image block; other media become placeholders such as `[图片]`. Protocol metadata never enters the request.

#### Token effect

Prompt tokens are data-dependent and remain in that day's session history until compaction.

#### KV Cache effect

Append-only. Each inbound follow-up is a new user message after the reusable request prefix.

## Known Limitations and Deferred Work

- **One robot, one daily session** — a single gateway and one `qqbot-YYYY-MM-DD` session per process; concurrent C2C chats share that session.
- **Secret slots are write-only on the wire** — the settings page treats a stored AppID as bound and never echoes AppSecret.
- **Group admission is off by default** — TOFU is unsafe when the first speaker is not the owner.
