"""Read two AppleTrade Telegram price sources and expose lowest safe prices.

This service is deliberately read-only.  It never joins the private channel,
sends a bot command, changes VK goods, or changes Yandex Business products.
External publishing starts only after destination-specific credentials and SKU
bindings are supplied.
"""
import asyncio
import csv
import hmac
import json
import logging
import os
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from urllib.parse import urlparse

from telethon import TelegramClient
from telethon.tl.functions.messages import CheckChatInviteRequest

from price_engine import lowest_offers, now_iso, parse_message

DATA = Path("/data")
SNAPSHOT = DATA / "belaya-kalitva-snapshot.json"
LOWEST = DATA / "belaya-kalitva-lowest-prices.json"
STATUS = DATA / "belaya-kalitva-status.json"
PUBLIC_USERNAME = os.environ.get("TG_PUBLIC_USERNAME", "ilublino").lstrip("@")


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def atomic_json(path: Path, data: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def set_status(state: str, **extra: object) -> None:
    atomic_json(STATUS, {"state": state, "at": now_iso(), **extra})


def csv_body(offers: list[dict[str, object]]) -> str:
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=["sku", "name", "price", "source", "message_id", "updated_at"])
    writer.writeheader()
    writer.writerows(offers)
    return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    secret = ""

    def log_message(self, *_: object) -> None:
        return

    def send_body(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, code: int, payload: object) -> None:
        self.send_body(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self.json(200, json.loads(STATUS.read_text("utf-8")) if STATUS.exists() else {"state": "starting"})
            return
        if path not in {"/belaya-kalitva/snapshot", "/belaya-kalitva/lowest-prices.json", "/belaya-kalitva/lowest-prices.csv"}:
            self.json(404, {"error": "not found"})
            return
        if not hmac.compare_digest(self.headers.get("X-PriceFlow-Secret", ""), self.secret):
            self.json(401, {"error": "unauthorized"})
            return
        target = SNAPSHOT if path.endswith("snapshot") else LOWEST
        if not target.exists():
            self.json(503, {"error": "snapshot is not ready"})
            return
        payload = json.loads(target.read_text("utf-8"))
        if path.endswith(".csv"):
            self.send_body(200, csv_body(payload["offers"]).encode("utf-8-sig"), "text/csv; charset=utf-8")
        else:
            self.json(200, payload)


async def private_entity(client: TelegramClient):
    """Return the private channel only when this account is already a member."""
    invite_hash = required("TG_PRIVATE_INVITE_HASH")
    result = await client(CheckChatInviteRequest(invite_hash))
    chat = getattr(result, "chat", None)
    if chat is None:
        raise RuntimeError("Telegram account is not a member of the private supplier channel; no join was attempted")
    return chat


async def messages(client: TelegramClient, source: str, entity, limit: int) -> list[dict[str, str]]:
    posts: list[dict[str, str]] = []
    async for message in client.iter_messages(entity, limit=limit):
        if not message.message or not message.message.strip():
            continue
        changed = message.edit_date or message.date
        posts.append({
            "source": source,
            "id": str(message.id),
            "text": message.message,
            "updatedAt": changed.astimezone(UTC).isoformat(),
        })
    return sorted(posts, key=lambda post: int(post["id"]))


async def collect(client: TelegramClient, limit: int) -> int:
    private = await private_entity(client)
    public = await client.get_entity(PUBLIC_USERNAME)
    source_posts = {
        "private_supplier": await messages(client, "private_supplier", private, limit),
        "ilublino": await messages(client, "ilublino", public, limit),
    }
    parsed = []
    for source, posts in source_posts.items():
        for post in posts:
            parsed.extend(parse_message(source, post["id"], post["text"], post["updatedAt"]))
    lowest = lowest_offers(parsed)
    atomic_json(SNAPSHOT, {"refreshedAt": now_iso(), "sources": source_posts})
    atomic_json(LOWEST, {"refreshedAt": now_iso(), "offers": [offer.json() for offer in lowest]})
    set_status("ready", sources={name: len(posts) for name, posts in source_posts.items()}, offers=len(lowest))
    return len(lowest)


async def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    Handler.secret = required("SNAPSHOT_SECRET")
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8091"))), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = TelegramClient(str(DATA / "telegram"), int(required("TG_API_ID")), required("TG_API_HASH"))
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram session is not authorized; authorize it before deploying this collector")
    interval = max(60, int(os.environ.get("REFRESH_SECONDS", "900")))
    try:
        while True:
            try:
                count = await collect(client, int(os.environ.get("TG_HISTORY_LIMIT", "1000")))
                logging.warning("AppleTrade snapshot refreshed: %s safe SKUs", count)
            except Exception as error:
                logging.exception("AppleTrade snapshot refresh failed")
                set_status("error", error=str(error))
            await asyncio.sleep(interval)
    finally:
        await client.disconnect()
        server.shutdown()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
