"""One-time QR authorization for the read-only Telegram account.

The session is stored only in /data (a Docker volume) and never printed,
copied to Git, or sent to Apps Script. The QR image expires frequently; this
script refreshes it until the account scans it or the container is stopped.
"""
import asyncio
import os
from pathlib import Path

import qrcode
from telethon import TelegramClient

DATA = Path("/data")
QR = DATA / "telegram-login-qr.png"
STATUS = DATA / "telegram-login-status.txt"


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def write_status(value: str) -> None:
    STATUS.write_text(value + "\n", encoding="utf-8")


async def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    api_id = int(required("TG_API_ID"))
    api_hash = required("TG_API_HASH")
    client = TelegramClient(str(DATA / "telegram"), api_id, api_hash)
    await client.connect()
    if await client.is_user_authorized():
        write_status("AUTHORIZED")
        print("AUTHORIZED", flush=True)
        return

    try:
        while True:
            qr = await client.qr_login()
            qrcode.make(qr.url).save(QR)
            write_status("WAITING_FOR_QR_SCAN")
            print("QR_READY", flush=True)
            try:
                await qr.wait(timeout=25)
            except TimeoutError:
                continue
            write_status("AUTHORIZED")
            print("AUTHORIZED", flush=True)
            return
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
