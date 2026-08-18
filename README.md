# QQ Bot Bridge

A persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that connects a QQ Open Platform robot (AppID + AppSecret) and bridges its messages into a per-day session of a chosen workspace.

## Features

- **Binding** — `qqbot_bind(appId, appSecret, workspaceId)` starts the WebSocket gateway.
- **Bidirectional bridge** — forwards inbound text / voice transcription / images into a `qqbot-YYYY-MM-DD` session and sends the agent's reply back to QQ.
- **Persistence** — AppID / Secret / workspace / sender allowlist in `$DSH_HOME/qqbot-clawbot/state.json` (mode 600); reconnects on restart.
- **Sender allowlist (TOFU)** — the first sender after binding is trusted; others are dropped.
- **C2C only by default** — TOFU assumes the first sender is the owner, which is unsafe in groups. Group / guild / dm messages are dropped unless `QQBOT_ALLOW_GROUP=true` (still TOFU-gated).
- **Media hardening** — image download restricted to Tencent CDN hosts, capped at 20 MB. Images attach inline only when the target model supports vision.
- **Human-in-the-loop (HITL) approval** — escalating a sandboxed action prompts `⚠️ 需要审批 … 回复「允许」或「拒绝」` in QQ with the tool's arguments; the tool blocks until you reply. C2C chats only — group-triggered approvals fall through to the web UI.

## Tools

| Tool | Purpose |
| --- | --- |
| `qqbot_list_workspaces` | list candidate workspaces |
| `qqbot_status()` | query binding/connection status |
| `qqbot_unbind()` | unbind and disconnect |

Binding is done from the web UI: Settings → QQ Bot (AppID / AppSecret / workspace), stored in the `qqbot` settings namespace; the host half auto-connects on change.

## Install

This package builds inside a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspace checkout.

1. Place (or symlink) this directory at `packages/qqbot/qqbot-clawbot` in the harness repo, then run `pnpm install` at the repo root.
2. Build the two halves:

   ```sh
   node_modules/.bin/tsc -b packages/qqbot/qqbot-clawbot/tsconfig.client.json
   cd packages/qqbot/qqbot-clawbot && ../../../node_modules/.bin/tsdown --env.DSH_BUILD_FACE client
   ```

3. Create a robot at [q.qq.com](https://q.qq.com/) and copy its AppID + AppSecret.
4. Register the plugin by package name in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: qqbot-clawbot
         name: '@deepseek-ai/dsh-qqbot-clawbot'
   ```

5. Restart `dsh web`, open Settings → QQ Bot, and enter the AppID + AppSecret (eye toggle reveals the secret).
