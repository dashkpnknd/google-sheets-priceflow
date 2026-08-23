"""Short-lived Telegram login by code for the read-only account.

Run with TG_LOGIN_MODE=request and TG_PHONE to request a code, then once with
TG_LOGIN_MODE=verify and TG_CODE. The short-lived Telegram code hash is kept
only in the Docker volume and is removed after successful authorization.
"""
import asyncio
import json
import os
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

DATA = Path("/data")
STATE = DATA / "telegram-code-login.json"
STATUS = DATA / "telegram-login-status.txt"


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def status(value: str) -> None:
    STATUS.write_text(value + "\n", encoding="utf-8")
    print(value, flush=True)


async def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(
        str(DATA / "telegram"), int(required("TG_API_ID")), required("TG_API_HASH")
    )
    await client.connect()
    try:
        if await client.is_user_authorized():
            status("AUTHORIZED")
            return
        mode = required("TG_LOGIN_MODE")
        if mode == "request":
            phone = required("TG_PHONE")
            sent = await client.send_code_request(phone)
            STATE.write_text(
                json.dumps({"phone": phone, "hash": sent.phone_code_hash}), encoding="utf-8"
            )
            status("CODE_SENT")
            return
        if mode == "verify":
            state = json.loads(STATE.read_text(encoding="utf-8"))
            try:
                await client.sign_in(state["phone"], required("TG_CODE"), phone_code_hash=state["hash"])
            except SessionPasswordNeededError:
                status("PASSWORD_REQUIRED")
                return
            STATE.unlink(missing_ok=True)
            status("AUTHORIZED")
            return
        raise RuntimeError("TG_LOGIN_MODE must be request or verify")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
