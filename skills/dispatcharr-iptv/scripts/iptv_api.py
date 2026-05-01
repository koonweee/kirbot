#!/usr/bin/env python3
"""Small Dispatcharr API helper for Kirbot IPTV channel/group work."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://iptv.sf.kw0.dev"
DEFAULT_ENV_FILES = [
    Path.cwd() / ".env",
    Path("/home/kirbot/coding/.env"),
    Path("/home/kirbot/.config/iptv.env"),
]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def load_env(explicit: str | None) -> None:
    if explicit:
        load_env_file(Path(explicit).expanduser())
        return
    for path in DEFAULT_ENV_FILES:
        load_env_file(path)


class DispatcharrClient:
    def __init__(self, base_url: str, api_key: str, key_header: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.key_header = key_header

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        data: Any | None = None,
    ) -> Any:
        url = self.base_url + (path if path.startswith("/") else f"/{path}")
        if query:
            clean_query = {k: v for k, v in query.items() if v is not None}
            if clean_query:
                url += "?" + urllib.parse.urlencode(clean_query, doseq=True)

        body = None
        headers = {
            self.key_header: self.api_key,
            "Accept": "application/json",
        }
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=body, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read()
                if not raw:
                    return {"status": response.status}
                content_type = response.headers.get("Content-Type", "")
                if "json" in content_type:
                    return json.loads(raw.decode("utf-8"))
                return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SystemExit(f"HTTP {exc.code} {method.upper()} {path}: {detail}") from exc


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def result_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict) and isinstance(value.get("results"), list):
        return value["results"]
    if isinstance(value, list):
        return value
    return []


def print_table(items: list[dict[str, Any]], columns: list[str]) -> None:
    if not items:
        print("No rows.")
        return
    widths = {col: len(col) for col in columns}
    rows: list[list[str]] = []
    for item in items:
        row = [str(item.get(col, "")) for col in columns]
        rows.append(row)
        for col, cell in zip(columns, row):
            widths[col] = min(max(widths[col], len(cell)), 80)
    print("  ".join(col.ljust(widths[col]) for col in columns))
    print("  ".join("-" * widths[col] for col in columns))
    for row in rows:
        cells = []
        for col, cell in zip(columns, row):
            if len(cell) > widths[col]:
                cell = cell[: widths[col] - 1] + "…"
            cells.append(cell.ljust(widths[col]))
        print("  ".join(cells))


def parse_key_value(values: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"Expected key=value, got: {value}")
        key, item = value.split("=", 1)
        parsed[key] = item
    return parsed


def maybe_print_dry_run(args: argparse.Namespace, method: str, path: str, data: Any) -> bool:
    if getattr(args, "dry_run", False):
        print_json({"dry_run": True, "method": method, "path": path, "json": data})
        return True
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Dispatcharr IPTV API helper")
    parser.add_argument("--env-file", help="dotenv file containing IPTV_API_KEY")
    parser.add_argument("--base-url", help="Dispatcharr base URL")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("groups", help="list channel groups")

    patch_group = sub.add_parser("patch-group", help="rename a channel group")
    patch_group.add_argument("id", type=int)
    patch_group.add_argument("--name", required=True)
    patch_group.add_argument("--dry-run", action="store_true")

    channels = sub.add_parser("channels", help="list channels")
    channels.add_argument("--search")
    channels.add_argument("--name")
    channels.add_argument("--group-id")
    channels.add_argument("--ordering", default="channel_number")
    channels.add_argument("--page", type=int)
    channels.add_argument("--page-size", type=int, default=100)

    get_channel = sub.add_parser("get-channel", help="get one channel")
    get_channel.add_argument("id", type=int)

    patch_channel = sub.add_parser("patch-channel", help="partial update for one channel")
    patch_channel.add_argument("id", type=int)
    patch_channel.add_argument("--name")
    patch_channel.add_argument("--group-id", type=int)
    patch_channel.add_argument("--number", type=float)
    adult = patch_channel.add_mutually_exclusive_group()
    adult.add_argument("--adult", action="store_true")
    adult.add_argument("--not-adult", action="store_true")
    patch_channel.add_argument("--dry-run", action="store_true")

    reorder = sub.add_parser("reorder-channel", help="move a channel after another channel")
    reorder.add_argument("id", type=int)
    target = reorder.add_mutually_exclusive_group(required=True)
    target.add_argument("--after", type=int, help="channel ID to insert after")
    target.add_argument("--start", action="store_true", help="move to the beginning")
    reorder.add_argument("--dry-run", action="store_true")

    assign = sub.add_parser("assign-channels", help="bulk assign channel numbers by ordered IDs")
    assign.add_argument("channel_ids", nargs="+", type=int)
    assign.add_argument("--starting-number", type=float)
    assign.add_argument("--dry-run", action="store_true")

    raw = sub.add_parser("raw", help="call an endpoint not covered by this helper")
    raw.add_argument("method")
    raw.add_argument("path")
    raw.add_argument("--query", action="append", default=[], help="query key=value")
    raw.add_argument("--data", help="JSON request body")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    load_env(args.env_file)
    api_key = os.environ.get("IPTV_API_KEY")
    if not api_key:
        raise SystemExit("Missing IPTV_API_KEY. Put it in /home/kirbot/coding/.env or pass --env-file.")
    base_url = args.base_url or os.environ.get("IPTV_BASE_URL") or DEFAULT_BASE_URL
    key_header = os.environ.get("IPTV_API_KEY_HEADER", "X-API-Key")
    client = DispatcharrClient(base_url, api_key, key_header)

    if args.command == "groups":
        data = client.request("GET", "/api/channels/groups/")
        print_json(data) if args.json else print_table(result_items(data), ["id", "name", "channel_count", "m3u_account_count"])
        return 0

    if args.command == "patch-group":
        body = {"name": args.name}
        path = f"/api/channels/groups/{args.id}/"
        if maybe_print_dry_run(args, "PATCH", path, body):
            return 0
        print_json(client.request("PATCH", path, data=body))
        return 0

    if args.command == "channels":
        data = client.request(
            "GET",
            "/api/channels/channels/",
            query={
                "search": args.search,
                "name": args.name,
                "channel_group": args.group_id,
                "ordering": args.ordering,
                "page": args.page,
                "page_size": args.page_size,
            },
        )
        if args.json:
            print_json(data)
        else:
            print_table(result_items(data), ["id", "channel_number", "name", "channel_group_id", "tvg_id"])
            if isinstance(data, dict) and "count" in data:
                print(f"count: {data['count']}")
        return 0

    if args.command == "get-channel":
        print_json(client.request("GET", f"/api/channels/channels/{args.id}/"))
        return 0

    if args.command == "patch-channel":
        body: dict[str, Any] = {}
        if args.name is not None:
            body["name"] = args.name
        if args.group_id is not None:
            body["channel_group_id"] = args.group_id
        if args.number is not None:
            body["channel_number"] = args.number
        if args.adult:
            body["is_adult"] = True
        if args.not_adult:
            body["is_adult"] = False
        if not body:
            raise SystemExit("Nothing to patch. Pass --name, --group-id, --number, --adult, or --not-adult.")
        path = f"/api/channels/channels/{args.id}/"
        if maybe_print_dry_run(args, "PATCH", path, body):
            return 0
        print_json(client.request("PATCH", path, data=body))
        return 0

    if args.command == "reorder-channel":
        body = {"insert_after_id": None if args.start else args.after}
        path = f"/api/channels/channels/{args.id}/reorder/"
        if maybe_print_dry_run(args, "POST", path, body):
            return 0
        print_json(client.request("POST", path, data=body))
        return 0

    if args.command == "assign-channels":
        body: dict[str, Any] = {"channel_ids": args.channel_ids}
        if args.starting_number is not None:
            body["starting_number"] = args.starting_number
        if maybe_print_dry_run(args, "POST", "/api/channels/channels/assign/", body):
            return 0
        print_json(client.request("POST", "/api/channels/channels/assign/", data=body))
        return 0

    if args.command == "raw":
        body = json.loads(args.data) if args.data else None
        print_json(client.request(args.method, args.path, query=parse_key_value(args.query), data=body))
        return 0

    parser.error("Unhandled command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
