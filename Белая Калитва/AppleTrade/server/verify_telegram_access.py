"""Read-only preflight for the AppleTrade supplier sources and bot.

Run this inside the existing authorized Telegram collector container.  It does
not join channels, send a message, press a bot button, or expose credentials.
"""
import asyncio
import os

from telethon import TelegramClient
from telethon.tl.functions.messages import CheckChatInviteRequest


async def main() -> None:
    client = TelegramClient("/data/telegram", int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
    await client.connect()
    try:
        print("authorized=", await client.is_user_authorized())
        try:
            invite = await client(CheckChatInviteRequest("7uEm3vcRuBRiNWZi"))
            chat = getattr(invite, "chat", None)
            print("private_invite=", type(invite).__name__, getattr(chat, "title", None))
        except Exception as error:
            print("private_invite_error=", type(error).__name__)
        for username in ("ilublino", "AppleTrade_price_bot"):
            try:
                entity = await client.get_entity(username)
                print(username + "=", type(entity).__name__, getattr(entity, "title", None) or getattr(entity, "username", None))
            except Exception as error:
                print(username + "_error=", type(error).__name__)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
