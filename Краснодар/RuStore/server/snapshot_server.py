"""Read one configured Telegram price channel and expose its current message snapshot.

The client is read-only. Telegram credentials and session never leave /data;
the HTTP response requires the shared X-PriceFlow-Secret header.
"""
import asyncio
import hmac
import json
import logging
import os
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from telethon import TelegramClient

DATA = Path("/data")
SNAPSHOT = DATA / "krasnodar-snapshot.json"
STATUS = DATA / "krasnodar-snapshot-status.json"
# Verified from the authorized account's dialog list. This is its exact title.
TARGET_TITLE = "Прайс ru:Store новый"


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def atomic_json(path: Path, data: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def set_status(state: str, **extra: object) -> None:
    atomic_json(STATUS, {"state": state, "at": datetime.now(UTC).isoformat(), **extra})


class SnapshotHandler(BaseHTTPRequestHandler):
    secret = ""

    def log_message(self, *_: object) -> None:
        return

    def send_json(self, code: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, json.loads(STATUS.read_text("utf-8")) if STATUS.exists() else {"state": "starting"})
            return
        if path != "/krasnodar/snapshot":
            self.send_json(404, {"error": "not found"})
            return
        received = self.headers.get("X-PriceFlow-Secret", "")
        if not hmac.compare_digest(received, self.secret):
            self.send_json(401, {"error": "unauthorized"})
            return
        if not SNAPSHOT.exists():
            self.send_json(503, {"error": "snapshot is not ready"})
            return
        self.send_json(200, json.loads(SNAPSHOT.read_text("utf-8")))


async def collect(client: TelegramClient, limit: int) -> int:
    dialogs = await client.get_dialogs()
    matches = [dialog for dialog in dialogs if normalized(dialog.name or "") == normalized(TARGET_TITLE)]
    if len(matches) != 1:
        found = [dialog.name for dialog in dialogs if dialog.is_channel]
        raise RuntimeError(f"Expected exactly one channel '{TARGET_TITLE}', found: {found}")
    posts = []
    async for message in client.iter_messages(matches[0].entity, limit=limit):
        if not message.message or not message.message.strip():
            continue
        changed = message.edit_date or message.date
        posts.append({"id": str(message.id), "text": message.message, "updatedAt": changed.astimezone(UTC).isoformat()})
    posts.sort(key=lambda post: int(post["id"]))
    atomic_json(SNAPSHOT, {"posts": posts, "channel": TARGET_TITLE, "refreshedAt": datetime.now(UTC).isoformat()})
    set_status("ready", channel=TARGET_TITLE, posts=len(posts))
    return len(posts)


async def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    SnapshotHandler.secret = required("SNAPSHOT_SECRET")
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8090"))), SnapshotHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = TelegramClient(str(DATA / "telegram"), int(required("TG_API_ID")), required("TG_API_HASH"))
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram session is not authorized")
    interval = max(60, int(os.environ.get("REFRESH_SECONDS", "900")))
    try:
        while True:
            try:
                count = await collect(client, int(os.environ.get("TG_HISTORY_LIMIT", "1000")))
                logging.warning("snapshot refreshed: %s posts", count)
            except Exception as error:
                logging.exception("snapshot refresh failed")
                set_status("error", error=str(error))
            await asyncio.sleep(interval)
    finally:
        await client.disconnect()
        server.shutdown()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
