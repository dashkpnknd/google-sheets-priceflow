"""Belaya Kalitva: read two supplier feeds and publish a raw lowest-price catalog.

This is not an Avito matcher.  It only emits supplier SKUs that were actually
published in a recent price post.  The Google Sheet consumer replaces its
catalog from this payload; margins and marketplace publication stay separate.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import threading
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from price_engine import sku_key


DATA = Path("/data")
CATALOG = DATA / "belaya-kalitva-catalog.json"
STATUS = DATA / "belaya-kalitva-status.json"
WATCHED = DATA / "belaya-kalitva-watched-posts.json"
MAX_CATALOG_AGE = timedelta(minutes=int(os.environ.get("CATALOG_MAX_AGE_MINUTES", "30")))
# AppleTrade's agreed supplier contract is only a confirmed "name — price"
# row.  Do not import the volume-price rule from Elektrostal.
PRICE = re.compile(r"^\s*(?P<title>.+?)\s*(?:—|–|-)\s*(?P<price>\d[\d\s.]{2,})\s*(?:₽|р\.?|rub)?\s*$", re.I)
# Dyson's live section uses ``name 40500`` rather than ``name — 40500``.
# This fallback is deliberately restricted to the Dyson sections below; using
# it globally would mistake capacities and model numbers for prices.
TRAILING_PRICE = re.compile(r"^\s*(?P<title>.+?\D)\s+(?P<price>\d[\d\s.]{2,})\s*(?:₽|р\.?|rub)?\s*$", re.I)
HEAD = re.compile(r"\b(iphone|ipad|macbook|imac|apple\s*watch|airpods|galaxy|samsung|xiaomi|redmi|asus|dyson|ps\s*[345]|playstation|xbox|dji|gopro|insta360|canon|fujifilm)\b", re.I)
MESSAGE_LINK = re.compile(r"(?:https?://)?t\.me/(?:c/\d+/|[A-Za-z0-9_]+/)(\d+)(?:[/?#].*)?$", re.I)
PRICE_HINT = re.compile(r"(?:—|–|-)\s*\d[\d\s.]{2,}\s*(?:₽|р\.?|rub)?", re.I)

# IDs taken once from the live Top re:sale price menu on 2026-08-26.  The
# supplier edits these stable messages every day, so their IDs are the correct
# subscription target.  Keep this list additive: newly discovered price posts
# are stored beside it in WATCHED.
TOP_RESALE_MENU_POSTS = frozenset({
    7, 8, 10, 12, 13, 15, 16, 17, 1495, 1496, 3126,
    4006, 4007, 4021, 4203,
})

# Some fixed price messages have no heading inside their own text.  Their
# category is nevertheless unambiguous from the supplier's menu.  Keep this
# mapping next to the IDs so a future edit cannot silently discard Androids.
TOP_RESALE_SECTION_CONTEXT = {
    8: "Samsung", 10: "Samsung", 12: "Accessories", 13: "Apple Watch",
    15: "iPad", 16: "MacBook", 17: "MacBook", 1495: "Dyson",
    1496: "Dyson", 3126: "PlayStation",
}


def now() -> datetime: return datetime.now(timezone.utc)
def norm(value: str) -> str:
    value = str(value or "").casefold().replace("ё", "е")
    value = re.sub(r"\bwi[ -]?fi\b", "wifi", value)
    value = re.sub(r"\be[ -]?sim\b", "esim", value)
    return " ".join(re.sub(r"[^a-zа-я0-9+/. ]+", " ", value).split())
def write(path: Path, value: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
def fresh_catalog() -> dict[str, object] | None:
    """Never serve a saved supplier snapshot after the polling loop has failed."""
    if not CATALOG.exists(): return None
    try:
        payload = json.loads(CATALOG.read_text("utf-8"))
        refreshed = datetime.fromisoformat(str(payload.get("refreshedAt", "")).replace("Z", "+00:00"))
        if refreshed.tzinfo is None: return None
        return payload if now() - refreshed.astimezone(timezone.utc) <= MAX_CATALOG_AGE else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
def category(title: str) -> str | None:
    t = norm(title)
    # Source-menu categories.  Accessories must be checked before phones:
    # a Samsung charger must never be catalogued as a Samsung phone.
    if re.search(r"\b(accessor(?:y|ies)|case|bumper|wallet|magsafe|folio|pencil|strap|band|charger|cable|adapter|powerbank|gamepad|controller)\b|чехол|стекло|кабель|заряд|адаптер|держател|ремеш|пауэрбанк", t): return "аксессуары"
    if re.search(r"dji|gopro|insta\s*360|fujifilm|canon|камера", t): return "камеры"
    if "imac" in t: return "аймак"
    if "macbook" in t or re.search(r"\bmac\s*mini\b", t): return "макбуки"
    if re.search(r"ipad|galaxy\s*tab|(?:xiaomi|redmi|huawei|honor)\s*pad|\btablet\b", t): return "айпады"
    if re.search(r"watch|galaxy\s*(?:fit|ring)|\bwhoop\b", t): return "часы"
    if "airpods" in t or "buds" in t or any(x in t for x in ("marshall", "jbl", "harman")): return "наушники"
    if "dyson" in t: return "дайсон"
    if re.search(r"\bps[345]\b|playstation|dualsense|\bxbox\b|nintendo|oculus|steam\s*deck", t): return "пс"
    if any(x in t for x in ("iphone", "galaxy", "samsung", "pixel", "xiaomi", "redmi", "honor", "huawei", "realme", "oneplus", "oppo", "vivo", "asus")): return "телефоны"
    return None
def sku(title: str) -> str:
    # Condition is material: an Asis+ device must never inherit a regular
    # device's lower price merely because model/configuration happen to match.
    condition = "asis" if re.search(r"\(\s*asis\b[^)]*\)", title, re.I) else "regular"
    return condition + "|" + sku_key(title)
def clean_title(value: str) -> str:
    # Keep a leading parenthesised supplier condition such as `(Asis запак)`.
    value = re.sub(r"^[^A-Za-zА-Яа-я0-9(]+", "", value).strip(" :")
    return re.sub(r"\s+", " ", value)


def normalize_condition(value: str) -> str:
    """Keep every supplier Asis variant in the requested leading format."""
    # This sheet has no Country column; flags are supplier display markers,
    # not a separate product attribute, so do not leave them in Model/Title.
    text = re.sub(r"[\U0001F1E6-\U0001F1FF]{2}", " ", clean_title(value)).strip()
    conditions = re.findall(r"\(\s*(asis\b[^)]*)\)", text, re.I)
    if not conditions:
        return text
    text = re.sub(r"\s*\(\s*asis\b[^)]*\)\s*", " ", text, flags=re.I)
    # A product can contain only one physical-condition marker.  Duplicates
    # are removed but its actual supplier wording is preserved.
    condition = re.sub(r"\s+", " ", conditions[0]).strip()
    return "(" + condition[:1].upper() + condition[1:] + ") " + clean_title(text)


def expand_context(context: str, item: str) -> str:
    """Reuse the city-parser heading rule without appending a model twice."""
    heading, value = clean_title(context), clean_title(item)
    if not heading:
        return value
    if re.fullmatch(r"iphone\s+\d+(?:e)?(?:\s+(?:pro\s+max|pro|plus|air|mini))?", heading, re.I) and not re.match(r"iphone\b", value, re.I):
        model = re.sub(r"^iphone\s+", "", heading, flags=re.I)
        # Supplier rows often repeat only the model after SIM.  Removing this
        # repetition prevents two distinct names for one exact source SKU.
        value = re.sub(r"^(sim\s*\+\s*e\s*-?sim|e\s*-?sim|2\s*sim)\s+" + re.escape(model) + r"(?=\s|$)", r"\1", value, flags=re.I)
        return heading + " " + value
    families = ("macbook", "imac", "dyson", "airpods")
    if heading.casefold().startswith(families) and not re.match(r"(?:macbook|imac|dyson|airpods)\b", value, re.I):
        return heading + " " + value
    brand_heading = re.fullmatch(r"(samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo|asus)(?:\s+[aszm])?", heading, re.I)
    if brand_heading and not re.match(r"(?:samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo|asus)\b", value, re.I) and re.search(r"\d", value):
        return brand_heading.group(1) + " " + value
    return value


def row(source: str, message_id: int, title: str, price: int, published_at: str) -> dict[str, object] | None:
    title = normalize_condition(title)
    group = category(title)
    if not group or price < 1000:
        return None
    return {"category": group, "title": title, "price": price, "sku": sku(title), "source": source, "messageId": str(message_id), "publishedAt": published_at}


def linked_message_ids(message: object) -> set[int]:
    """Extract category-post IDs only from Telegram URL buttons."""
    result: set[int] = set()
    for button_row in getattr(message, "buttons", None) or []:
        for button in button_row:
            match = MESSAGE_LINK.search(str(getattr(button, "url", "") or ""))
            if match: result.add(int(match.group(1)))
    return result


def is_price_message(message: object) -> bool:
    return bool(PRICE_HINT.search(str(getattr(message, "message", "") or "")))


def read_watched() -> dict[str, list[int]]:
    if not WATCHED.exists(): return {}
    try:
        raw = json.loads(WATCHED.read_text("utf-8"))
        return {str(source): [int(item) for item in ids] for source, ids in dict(raw).items()}
    except (ValueError, TypeError):
        return {}


async def message_batches(client: object, entity: object, ids: list[int]) -> list[object]:
    result: list[object] = []
    for offset in range(0, len(ids), 100):
        batch = await client.get_messages(entity, ids=ids[offset:offset + 100])
        result.extend(batch if isinstance(batch, list) else [batch])
    return [message for message in result if message]


async def top_resale_messages(client: object, entity: object, watched: dict[str, list[int]]) -> list[object]:
    """Poll stable menu posts plus newly published price-post IDs only."""
    ids = set(watched.get("top_resale", [])) | set(TOP_RESALE_MENU_POSTS)
    # New supplier posts need to be added to the fixed watch list once.
    recent = [message async for message in client.iter_messages(entity, limit=80)]
    new_ids = {int(message.id) for message in recent if is_price_message(message)} - ids
    if new_ids:
        ids.update(new_ids)
    if watched.get("top_resale", []) != sorted(ids):
        watched["top_resale"] = sorted(ids); write(WATCHED, watched)
    return await message_batches(client, entity, sorted(ids))


def parse_post(source: str, message_id: int, text: str, published_at: str, section_context: str = "") -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    context = section_context
    lines = str(text or "").replace("\r", "").split("\n")
    for raw in lines:
        line = clean_title(raw)
        if not line: continue
        match = PRICE.match(line)
        # Only Dyson's confirmed layout permits a no-dash trailing price.
        if not match and norm(section_context).startswith("dyson"):
            match = TRAILING_PRICE.match(line)
        if not match:
            if HEAD.search(line) and len(line) < 100: context = line.rstrip(":")
            continue
        price = int(re.sub(r"[^0-9]", "", match.group("price")))
        part = clean_title(match.group("title"))
        offer = row(source, message_id, part if category(part) else expand_context(context, part), price, published_at)
        if offer: result.append(offer)
    return result


async def collect(client: object) -> dict[str, object]:
    # Import at runtime so parser regression tests have no Telegram dependency.
    from telethon.tl.functions.messages import CheckChatInviteRequest
    from telethon.tl.functions.channels import GetFullChannelRequest
    invite = await client(CheckChatInviteRequest(os.environ["TG_PRIVATE_INVITE_HASH"]))
    if type(invite).__name__ != "ChatInviteAlready":
        raise RuntimeError("reserve account is not joined to Top re:sale")
    top_resale, ilublino = invite.chat, await client.get_entity("ilublino")
    sources = [("top_resale", top_resale), ("ilublino", ilublino)]
    cutoff = now() - timedelta(hours=int(os.environ.get("CATALOG_MAX_AGE_HOURS", "36")))
    offers: list[dict[str, object]] = []
    watched = read_watched()
    for source, entity in sources:
        if source == "top_resale":
            for message in await top_resale_messages(client, entity, watched):
                if not message.message: continue
                changed = message.edit_date or message.date
                offers.extend(parse_post(source, message.id, message.message, changed.astimezone(timezone.utc).isoformat(), TOP_RESALE_SECTION_CONTEXT.get(int(message.id), "")))
            continue
        recent = [message async for message in client.iter_messages(entity, limit=int(os.environ.get("HISTORY_LIMIT", "180")))]
        roots = list(recent)
        try:
            full = await client(GetFullChannelRequest(entity))
            pinned_id = getattr(getattr(full, "full_chat", None), "pinned_msg_id", None)
            if pinned_id:
                pinned = await client.get_messages(entity, ids=pinned_id)
                if pinned: roots.append(pinned)
        except Exception:
            pass
        # The price interface is a menu: follow its own buttons to category
        # posts instead of repeatedly downloading the whole channel history.
        queue, seen, chosen = list(roots), set(), []
        while queue and len(seen) < 500:
            message = queue.pop(0)
            message_id = int(getattr(message, "id", 0) or 0)
            if not message_id or message_id in seen: continue
            seen.add(message_id); chosen.append(message)
            ids = linked_message_ids(message) - seen
            if ids:
                linked = await client.get_messages(entity, ids=list(ids))
                queue.extend(linked if isinstance(linked, list) else [linked])
        recent_ids = {int(getattr(message, "id", 0) or 0) for message in recent}
        for message in chosen:
            if not message.message: continue
            changed = message.edit_date or message.date
            # A category post reached via the live menu is an active supplier
            # section even when its original publication date is old.
            if int(message.id) in recent_ids and changed.astimezone(timezone.utc) < cutoff: continue
            offers.extend(parse_post(source, message.id, message.message, changed.astimezone(timezone.utc).isoformat()))
    lowest: dict[str, dict[str, object]] = {}
    for offer in offers:
        old = lowest.get(str(offer["sku"]))
        if old is None or int(offer["price"]) < int(old["price"]): lowest[str(offer["sku"])] = offer
    groups: dict[str, list[dict[str, object]]] = defaultdict(list)
    for offer in lowest.values(): groups[str(offer["category"])].append(offer)
    for rows in groups.values(): rows.sort(key=lambda row: (str(row["title"]), int(row["price"])))
    payload = {"refreshedAt": now().isoformat(), "sources": [name for name, _ in sources], "categories": groups, "total": len(lowest)}
    write(CATALOG, payload)
    write(STATUS, {"state": "ready", "at": now().isoformat(), "total": len(lowest)})
    return payload


class Handler(BaseHTTPRequestHandler):
    secret = ""
    def log_message(self, *_: object) -> None: pass
    def send_json(self, code: int, value: object) -> None:
        data = json.dumps(value, ensure_ascii=False).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(data)
    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self.send_json(200 if STATUS.exists() else 503, json.loads(STATUS.read_text()) if STATUS.exists() else {"state": "starting"}); return
        if urlparse(self.path).path != "/belaya-kalitva/catalog" or not hmac.compare_digest(self.headers.get("X-PriceFlow-Secret", ""), self.secret): self.send_json(401, {"error": "unauthorized"}); return
        payload = fresh_catalog()
        self.send_json(200 if payload else 503, payload if payload else {"error": "catalog unavailable or stale"})


async def main() -> None:
    from telethon import TelegramClient
    DATA.mkdir(parents=True, exist_ok=True); Handler.secret = os.environ["SNAPSHOT_SECRET"]
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8091"))), Handler); threading.Thread(target=server.serve_forever, daemon=True).start()
    config = json.loads(Path(os.environ["TG_SESSION_CONFIG_PATH"]).read_text("utf-8"))
    client = TelegramClient(str(DATA / "telegram"), int(config["app_id"]), config["app_hash"]); await client.connect()
    try:
        while True:
            try:
                if not await client.is_user_authorized(): raise RuntimeError("needs_reauth")
                await collect(client)
            except Exception as error: write(STATUS, {"state": "error", "at": now().isoformat(), "error": str(error)})
            await asyncio.sleep(max(900, int(os.environ.get("REFRESH_SECONDS", "1800"))))
    finally: await client.disconnect(); server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
