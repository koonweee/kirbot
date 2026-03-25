#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib import error, parse, request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a message to the Kirbot workspace Telegram chat."
    )
    parser.add_argument(
        "--env-file",
        default=str(Path.home() / ".config" / "telegram-bots.env"),
        help="Path to the shared Telegram env file.",
    )
    parser.add_argument(
        "--parse-mode",
        choices=("Markdown", "MarkdownV2", "HTML"),
        help="Optional Telegram parse mode.",
    )
    parser.add_argument(
        "--allow-preview",
        action="store_true",
        help="Allow web page previews instead of disabling them.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the payload without sending it.",
    )
    parser.add_argument(
        "message",
        nargs="*",
        help="Message text. Omit this and pipe text on stdin for multiline content.",
    )
    return parser.parse_args()


def load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        raise SystemExit(f"Missing env file: {path}")

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value

    return values


def read_message(parts: list[str]) -> str:
    if parts:
        return " ".join(parts).strip()

    if not sys.stdin.isatty():
        return sys.stdin.read().strip()

    return ""


def require_env(values: dict[str, str], key: str) -> str:
    value = values.get(key, "").strip()
    if not value:
        raise SystemExit(f"{key} is required in ~/.config/telegram-bots.env")
    return value


def build_payload(chat_id: int, message: str, args: argparse.Namespace) -> dict[str, str]:
    payload: dict[str, str] = {
        "chat_id": str(chat_id),
        "text": message,
        "disable_web_page_preview": "false" if args.allow_preview else "true",
    }
    if args.parse_mode:
        payload["parse_mode"] = args.parse_mode
    return payload


def send_message(bot_token: str, payload: dict[str, str]) -> dict[str, object]:
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    encoded = parse.urlencode(payload).encode("utf-8")
    req = request.Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=30) as response:
            body = response.read()
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Telegram send failed ({exc.code}): {body}") from exc
    except error.URLError as exc:
        raise SystemExit(f"Telegram send failed: {exc}") from exc

    result = json.loads(body.decode("utf-8"))
    if result.get("ok") is not True:
        raise SystemExit(f"Telegram send failed: {json.dumps(result, ensure_ascii=False)}")

    return result


def main() -> int:
    args = parse_args()
    env_path = Path(args.env_file).expanduser()
    env = load_env_file(env_path)

    bot_token = require_env(env, "TELEGRAM_BOT_TOKEN")
    workspace_chat_id_raw = require_env(env, "TELEGRAM_WORKSPACE_CHAT_ID")

    try:
        workspace_chat_id = int(workspace_chat_id_raw)
    except ValueError as exc:
        raise SystemExit("TELEGRAM_WORKSPACE_CHAT_ID must be an integer") from exc
    if workspace_chat_id >= 0:
        raise SystemExit("TELEGRAM_WORKSPACE_CHAT_ID must be negative")

    message = read_message(args.message)
    if not message:
        raise SystemExit("Message text is required")

    payload = build_payload(workspace_chat_id, message, args)
    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    result = send_message(bot_token, payload)
    message_id = result["result"]["message_id"]
    print(f"sent message_id={message_id} chat_id={workspace_chat_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
