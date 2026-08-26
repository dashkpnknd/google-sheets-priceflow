import unittest

from price_engine import Offer, lowest_offers, parse_message, sku_key


class PriceEngineTests(unittest.TestCase):
    def test_normalizes_safe_spelling_only(self):
        self.assertEqual(
            sku_key("iPhone 16 128 GB Wi-Fi Blue SIM + eSIM"),
            sku_key("iPhone 16 128ГБ Wi‑Fi Blue SIM+eSIM 🇯🇵"),
        )

    def test_does_not_mix_memory_or_colour(self):
        self.assertNotEqual(sku_key("iPhone 16 128 GB Blue"), sku_key("iPhone 16 256 GB Blue"))
        self.assertNotEqual(sku_key("iPhone 16 128 GB Blue"), sku_key("iPhone 16 128 GB Pink"))

    def test_keeps_android_ram_material(self):
        self.assertNotEqual(sku_key("Galaxy S25 8/256 GB Black"), sku_key("Galaxy S25 12/256 GB Black"))

    def test_uses_lowest_price_for_same_sku(self):
        offers = parse_message("closed", "1", "iPhone 16 128 GB Blue — 63 000 ₽", "2026-08-26T00:00:00Z")
        offers += parse_message("public", "2", "iPhone 16 128 GB Blue — 62 500 ₽", "2026-08-26T00:00:00Z")
        self.assertEqual(lowest_offers(offers)[0].price, 62500)
        self.assertEqual(lowest_offers(offers)[0].source, "public")

    def test_skips_unconfirmed_price(self):
        self.assertEqual(parse_message("x", "1", "iPhone 16 128 GB Blue — 63 000 ₽?", "now"), [])


if __name__ == "__main__":
    unittest.main()
