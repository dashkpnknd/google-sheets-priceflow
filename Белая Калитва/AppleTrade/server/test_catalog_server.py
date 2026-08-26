import unittest

from catalog_server import TOP_RESALE_MENU_POSTS, category, parse_post


class CatalogPriceParserTests(unittest.TestCase):
    def test_does_not_import_elektrostal_volume_price_rule(self):
        rows = parse_post(
            "supplier", 1,
            "Цена за объем\niPad Air 13 M3\niPad Air 13 M3 128 ГБ Wi-Fi Blue\n1 шт 67 600 ₽ · 3+ 67 500 ₽ · 5+ 67 400 ₽",
            "2026-08-26T00:00:00+00:00",
        )
        self.assertEqual(rows, [])

    def test_does_not_repeat_iphone_heading_in_title(self):
        rows = parse_post(
            "supplier", 2, "iPhone 17 Pro\nSIM + eSIM 17 Pro 1TB Natural — 124 490 ₽",
            "2026-08-26T00:00:00+00:00",
        )
        self.assertEqual(rows[0]["title"], "iPhone 17 Pro SIM + eSIM 1TB Natural")

    def test_tb_is_kept_in_the_raw_supplier_title(self):
        rows = parse_post("supplier", 3, "iPhone 17 Pro 2TB Blue — 159 990 ₽", "2026-08-26T00:00:00+00:00")
        self.assertEqual(rows[0]["title"], "iPhone 17 Pro 2TB Blue")

    def test_asis_is_preserved_at_the_start_and_not_mixed_with_regular_stock(self):
        rows = parse_post("supplier", 4, "iPhone 16 512Gb Black (Asis+) — 63 100 ₽", "2026-08-26T00:00:00+00:00")
        self.assertEqual(rows[0]["title"], "(Asis+) iPhone 16 512Gb Black")
        regular = parse_post("supplier", 5, "iPhone 16 512Gb Black — 62 000 ₽", "2026-08-26T00:00:00+00:00")
        self.assertNotEqual(rows[0]["sku"], regular[0]["sku"])

    def test_asis_packed_variant_is_preserved_with_its_exact_variant_name(self):
        rows = parse_post("supplier", 8, "iPhone Air 256Gb Cloud White 🇭🇰 (Asis запак) — 66 700 ₽", "2026-08-26T00:00:00+00:00")
        self.assertEqual(rows[0]["title"], "(Asis запак) iPhone Air 256Gb Cloud White")
        self.assertEqual(rows[0]["category"], "телефоны")

    def test_all_visible_source_families_have_a_destination(self):
        self.assertEqual(category("Samsung A17 6/128 Black"), "телефоны")
        self.assertEqual(category("Xiaomi 14 12/256 Black"), "телефоны")
        self.assertEqual(category("ASUS ROG Phone 16/512 Black"), "телефоны")
        self.assertEqual(category("iMac M4 24 inch Blue"), "аймак")
        self.assertEqual(category("Insta360 X5 camera"), "камеры")
        self.assertEqual(category("USB-C Adapter 20W"), "аксессуары")
        self.assertEqual(category("Mac mini M4 16/256"), "макбуки")
        self.assertEqual(category("Xbox Series X"), "пс")

    def test_samsung_and_xiaomi_section_heads_are_kept_on_short_model_rows(self):
        samsung = parse_post("supplier", 6, "SAMSUNG A\nA17 6/128 Black — 14 700 ₽", "2026-08-26T00:00:00+00:00")
        xiaomi = parse_post("supplier", 7, "XIAOMI\n14 12/256 Black — 35 000 ₽", "2026-08-26T00:00:00+00:00")
        self.assertEqual(samsung[0]["title"], "SAMSUNG A17 6/128 Black")
        self.assertEqual(xiaomi[0]["title"], "XIAOMI 14 12/256 Black")

    def test_fixed_android_menu_posts_get_their_menu_context(self):
        rows = parse_post("top_resale", 8, "A17 6/128 Black 🇷🇺 — 14 700₽", "2026-08-26T00:00:00+00:00", "Samsung")
        self.assertEqual(rows[0]["title"], "Samsung A17 6/128 Black")
        self.assertEqual(rows[0]["category"], "телефоны")

    def test_dyson_fixed_section_accepts_its_confirmed_no_dash_price_layout(self):
        rows = parse_post("top_resale", 1495, "Dyson HS05 Long Nickel Copper 40500", "2026-08-26T00:00:00+00:00", "Dyson")
        self.assertEqual(rows[0]["title"], "Dyson HS05 Long Nickel Copper")
        self.assertEqual(rows[0]["price"], 40500)

    def test_top_resale_fixed_menu_covers_every_visible_product_section(self):
        required = {7, 8, 10, 12, 13, 15, 16, 17, 1495, 1496, 3126, 4006, 4007, 4021, 4203}
        self.assertTrue(required.issubset(TOP_RESALE_MENU_POSTS))


if __name__ == "__main__":
    unittest.main()
