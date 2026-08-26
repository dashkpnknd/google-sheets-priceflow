"""Safe, deterministic price extraction and lowest-price aggregation.

Only material SKU characteristics form a key.  Unknown characteristics are
kept in the normalized name instead of being guessed, so a similar device
cannot inherit a price from another configuration.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Iterable


@dataclass(frozen=True)
class Offer:
    source: str
    message_id: str
    updated_at: str
    name: str
    price: int
    sku: str

    def json(self) -> dict[str, object]:
        return asdict(self)


_PRICE_LINE = re.compile(
    r"^\s*(?P<name>.+?)\s*(?:—|–|-)\s*(?P<price>[\d\s]{3,})\s*(?:₽|р\.?|rub)?\s*$",
    re.IGNORECASE,
)
_FLAGS = re.compile(r"[\U0001F1E6-\U0001F1FF]{2}")
_MODEL = re.compile(
    r"\b(?:iphone\s+\d+(?:e)?(?:\s+(?:pro\s*max|pro|plus|mini|air))?|"
    r"ipad\s+(?:air|pro|mini)?\s*\d+|macbook\s+(?:air|pro|neo)?\s*\d+|"
    r"apple\s+watch\s+(?:s\d+|se\s*\d*|ultra\s*\d*)|"
    r"galaxy\s+(?:s|a|z|m)\d+(?:\+|\s+(?:ultra|fe|plus))?|"
    r"pixel\s+\d+(?:\s+(?:pro|xl|a))?)\b",
    re.IGNORECASE,
)
_STORAGE = re.compile(r"\b(64|128|256|512|1024|2048)\s*(гб|gb|тб|tb)\b", re.IGNORECASE)
_RAM_STORAGE = re.compile(r"\b(\d{1,2})\s*/\s*(64|128|256|512|1024|2048)\s*(гб|gb|тб|tb)?\b", re.IGNORECASE)
_COLORS = (
    "black", "white", "blue", "green", "pink", "purple", "yellow", "silver", "gray", "grey",
    "gold", "orange", "red", "starlight", "midnight", "natural", "desert", "graphite",
    "черный", "белый", "синий", "голубой", "зеленый", "розовый", "фиолетовый", "желтый",
    "серебристый", "серый", "золотистый", "оранжевый", "красный",
)


def norm(value: str) -> str:
    return " ".join(str(value or "").casefold().replace("ё", "е").split())


def memory_gb(number: str, unit: str) -> str:
    return str(int(number) * (1024 if unit.casefold() in {"тб", "tb"} else 1)) + "gb"


def sku_key(name: str) -> str:
    """Create a no-guess SKU fingerprint from material supplier attributes."""
    raw = norm(_FLAGS.sub(" ", name))
    raw = re.sub(r"\bwi[\s\-‑]?fi\b", "wifi", raw)
    raw = re.sub(r"\be[\s\-‑]?sim\b", "esim", raw)
    raw = re.sub(r"\bsim\s*\+\s*esim\b", "sim+esim", raw)
    raw = re.sub(r"\bspace\s+black\b", "black", raw)
    raw = re.sub(r"\bspace\s+gray\b", "gray", raw)
    model = _MODEL.search(raw)
    ram_storage = _RAM_STORAGE.search(raw)
    storage = _STORAGE.search(raw)
    storage_key = ""
    ram_key = ""
    if ram_storage:
        ram_key = ram_storage.group(1) + "gb"
        storage_key = memory_gb(ram_storage.group(2), ram_storage.group(3) or "gb")
    elif storage:
        storage_key = memory_gb(storage.group(1), storage.group(2))
    sim = "sim+esim" if "sim+esim" in raw else "esim" if re.search(r"\besim\b", raw) else "2sim" if re.search(r"\b2\s*sim\b", raw) else "sim" if re.search(r"\bsim\b", raw) else ""
    color = next((color for color in _COLORS if re.search(r"(?<!\w)" + re.escape(color) + r"(?!\w)", raw)), "")
    if model and storage_key:
        # Include all recognised material fields.  Absence remains absence;
        # it is never filled from a similar offer.
        return "|".join((norm(model.group(0)), storage_key, ram_key, sim, color))
    # An unknown/non-device line cannot collide with a device through fuzzy
    # matching. It is only identical when its full normalized title is equal.
    return "raw|" + re.sub(r"[^a-zа-я0-9]+", " ", raw).strip()


def parse_message(source: str, message_id: str, text: str, updated_at: str) -> list[Offer]:
    offers: list[Offer] = []
    for line in str(text or "").replace("\r", "").split("\n"):
        match = _PRICE_LINE.match(line)
        if not match or "?" in line:
            continue
        price = int(match.group("price").replace(" ", ""))
        name = " ".join(match.group("name").split())
        if price <= 0 or not name:
            continue
        offers.append(Offer(source, str(message_id), updated_at, name, price, sku_key(name)))
    return offers


def lowest_offers(offers: Iterable[Offer]) -> list[Offer]:
    """Return the lowest current supplier price for every exact safe SKU."""
    lowest: dict[str, Offer] = {}
    for offer in offers:
        old = lowest.get(offer.sku)
        if old is None or offer.price < old.price or (offer.price == old.price and offer.source < old.source):
            lowest[offer.sku] = offer
    return sorted(lowest.values(), key=lambda offer: (offer.sku, offer.price, offer.source))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
