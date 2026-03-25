---
name: telegram-workspace-send
description: Send messages to the Kirbot Telegram workspace forum supergroup using `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WORKSPACE_CHAT_ID` from `~/.config/telegram-bots.env`.
---

# Telegram Workspace Send

Use this skill when Kirbot needs to post into the workspace group channel.

## Rules

- Read `~/.config/telegram-bots.env` first.
- Send only to `TELEGRAM_WORKSPACE_CHAT_ID`.
- Fail fast if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WORKSPACE_CHAT_ID` is missing.
- Prefer plain text; use Telegram `parse_mode` only when formatting is required.

## Helper

Use [`scripts/send-workspace-message.py`](scripts/send-workspace-message.py) for routine sends.

Examples:

- `python3 skills/telegram-workspace-send/scripts/send-workspace-message.py "Build finished successfully"`
- `cat /tmp/status.txt | python3 skills/telegram-workspace-send/scripts/send-workspace-message.py --dry-run`
