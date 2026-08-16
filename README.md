# QQ Bot Bridge

A persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that connects a QQ Open Platform robot (AppID + AppSecret) and bridges its messages into a per-day session of a chosen workspace.

## Features

- **Binding** — `qqbot_bind(appId, appSecret, workspaceId)` starts the WebSocket gateway.
- **Bidirectional bridge** — forwards inbound text / voice transcription / images into a `qqbot-YYYY-MM-DD` session and sends the agent's reply back to QQ.
- **Persistence** — AppID / Secret / workspace / sender allowlist in `$DSH_HOME/qqbot-clawbot/state.json` (mode 600); reconnects on restart.
- **Sender allowlist (TOFU)** — the first sender after binding is trusted; others are dropped.
- **C2C only by default** — TOFU assumes the first sender is the owner, which is unsafe in groups. Group / guild / dm messages are dropped unless `QQBOT_ALLOW_GROUP=true` (still TOFU-gated).
- **Media hardening** — image download restricted to Tencent CDN hosts, capped at 20 MB. Images attach inline only when the target model supports vision.
- **Human-in-the-loop (HITL) approval** — escalating a sandboxed action prompts `⚠️ 需要审批 … 回复「允许」或「拒绝」` in QQ; the tool blocks until you reply.

## Tools

| Tool | Purpose |
| --- | --- |
| `qqbot_list_workspaces` | list candidate workspaces |
| `qqbot_bind(appId, appSecret, workspaceId)` | bind and connect |
| `qqbot_status()` | query binding/connection status |
| `qqbot_unbind()` | unbind and disconnect |

## Install

1. `npm install` — installs the `@tencent-connect/qqbot-nodejs` SDK dependency.
2. Create a robot at [q.qq.com](https://q.qq.com/) and copy its AppID + AppSecret.
3. Register the plugin in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: qqbot-clawbot
         name: '/Users/<you>/github/qqbot-clawbot/qqbot-clawbot.mjs'
   ```

4. Restart `dsh web`, then say "绑定 QQ" and provide the AppID + AppSecret.
