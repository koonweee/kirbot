---
name: dispatcharr-iptv
description: Interact with the user's Dispatcharr IPTV server API for channel and group organization. Use when Codex needs to inspect IPTV channels, list or rename channel groups, move channels between groups, reorder channel numbers, bulk assign channel order, or safely perform authenticated Dispatcharr API calls against https://iptv.sf.kw0.dev.
---

# Dispatcharr IPTV

## Quick Start

Use `scripts/iptv_api.py` for API calls. It loads credentials from `IPTV_API_KEY` or a dotenv file, with `/home/kirbot/coding/.env` as the normal Kirbot location.

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py groups
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py channels --page-size 50 --ordering channel_number
```

For detailed endpoint notes, read `references/api.md`.

## Safety Rules

- Treat channel/group changes as persistent server mutations.
- Before rearranging channels, list the affected channels/groups and confirm IDs by name.
- Prefer `--dry-run` first for `patch-channel`, `reorder-channel`, `assign-channels`, and `patch-group`.
- Use `X-API-Key` authentication. Do not send the stored API key as `Authorization: Bearer`; the server treats that as JWT auth and rejects it.
- Do not print secrets in chat or logs. Mention only the env file path when needed.

## Common Tasks

List groups:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py groups
```

Find channels:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py channels --search ESPN --page-size 25
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py channels --group-id 12 --ordering channel_number
```

Move or edit one channel:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py patch-channel 123 --group-id 9 --dry-run
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py patch-channel 123 --group-id 9
```

Reorder one channel:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py reorder-channel 123 --after 122 --dry-run
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py reorder-channel 123 --start
```

Bulk assign a channel order:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py assign-channels --starting-number 1 101 102 103 --dry-run
```

Use `raw` only when the helper does not expose an operation:

```bash
python3 /home/kirbot/kirbot/skills/dispatcharr-iptv/scripts/iptv_api.py raw GET /api/channels/channels/ --query page_size=5
```
