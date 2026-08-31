import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../PriceFlowAvitoMatcher.gs', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('./RuStoreCatalog.gs', import.meta.url), 'utf8') + '\nglobalThis.API={rusParsePost_,rusCategory_,rusPhone_,rusExpand_,rusCountry_,rusColor_,rusLayoutFor_,rusReadySim_,PriceFlowAvitoMatcher};';
const ctx = { console }; vm.createContext(ctx); vm.runInContext(src, ctx); const api = ctx.API;

test('uses the channel price exactly as written, without markup', () => {
  const r = api.rusParsePost_('📱 iPhone 15\n🇮🇳15 Pro 128 ГБ Natural (1Sim+eSim) — 71 800 ₽', '1').rows;
  assert.equal(r.length, 1); assert.equal(r[0].name, 'iPhone 15 Pro 128 ГБ Natural (1Sim+eSim) 🇮🇳'); assert.equal(r[0].price, 71800);
});
test('does not treat an Elektrostal volume-price line as a Krasnodar SKU', () => {
  const result = api.rusParsePost_('iPhone 15 Pro\n15 Pro 128 ГБ Natural\n1 шт 71 800 ₽ · 3+ 71 700 ₽', 'vol');
  assert.equal(result.rows.length, 0); assert.match(result.skipped[0], /объёмная цена/);
});
test('skips a supplier price marked with a question mark', () => {
  const r = api.rusParsePost_('📱 iPhone 16\n🇯🇵16 256 Pink-71 490 ?', '2').rows;
  assert.equal(r.length, 0);
});
test('does not create zero-price rows from ordinary-price placeholders', () => {
  const r = api.rusParsePost_('iPhone 16 Pro\n🇨🇳16 Pro 128 Natural —\nУказано по обычной цене', '3'); assert.equal(r.rows.length, 0); assert.deepEqual(Array.from(r.categories), ['телефоны']);
});
test('routes all required catalogues safely', () => {
  assert.equal(api.rusCategory_('iPhone 17 Pro'), 'телефоны'); assert.equal(api.rusCategory_('Galaxy Tab A11'), 'айпады'); assert.equal(api.rusCategory_('AirPods Max'), 'наушники'); assert.equal(api.rusCategory_('PS5 Slim Disk'), 'пс'); assert.equal(api.rusCategory_('GamePad PS5 Black'), 'прочее'); assert.equal(api.rusCategory_('Dyson HD16'), 'дайсон');
});
test('sends every supported Android phone family to the right phone block', () => {
  const layouts = [{}, {}];
  ['Samsung Galaxy S25', 'Google Pixel 10 Pro', 'Xiaomi 14', 'Redmi Note 14', 'Honor 400', 'Huawei Pura 80', 'OnePlus 13', 'realme GT 7', 'OPPO Find X8', 'vivo X200'].forEach(function(name) {
    assert.equal(api.rusCategory_(name), 'телефоны');
    assert.equal(api.rusLayoutFor_(layouts, { category: 'телефоны', name: name }), 1);
  });
  assert.equal(api.rusLayoutFor_(layouts, { category: 'телефоны', name: 'iPhone 17 Pro' }), 0);
});
test('keeps an Android brand-only supplier heading on abbreviated rows', () => {
  const r = api.rusParsePost_('Xiaomi\n14 12/256 Black — 54 990\nRedmi\nNote 14 8/256 Green — 22 990', 'android').rows;
  assert.deepEqual(Array.from(r, function(row) { return [row.name, row.category]; }), [['Xiaomi 14 12/256 Black', 'телефоны'], ['Redmi Note 14 8/256 Green', 'телефоны']]);
});
test('parses the actual Samsung post with its robot heading and sends it to phones', () => {
  const r = api.rusParsePost_('🤖 SAMSUNG •••••••\n🇦🇪S26 12/256 Black-63 990\n🇦🇪S26 12/256 Silver-63 990 ?', '15').rows;
  assert.deepEqual(Array.from(r, function(row) { return [row.name, row.category, row.price]; }), [['SAMSUNG S26 12/256 Black 🇦🇪', 'телефоны', 63990]]);
});
test('normalizes SIM, country and Android RAM/memory separately', () => {
  const p = api.rusPhone_('🇦🇪S26 12/256 Black SIM+eSIM'); assert.equal(p.ram, '12 ГБ'); assert.equal(p.memory, '256 ГБ'); assert.equal(p.sim, 'SIM + eSIM'); assert.equal(p.country, 'ОАЭ 🇦🇪');
});
test('writes Europe and every present country flag to the country field', () => {
  assert.equal(api.rusCountry_('🇪🇺 iPhone'), 'Европа 🇪🇺');
  assert.equal(api.rusCountry_('🇩🇪🇫🇷'), 'Германия 🇩🇪');
});
test('keeps a product section as context instead of accumulating prior flags', () => {
  const r = api.rusParsePost_('📱 iPhone 16 •••••\n🇯🇵16 128 White — 64 990\n🇪🇺16 256 Black — 72 990', 'ctx').rows;
  assert.deepEqual(Array.from(r, x => x.name), ['iPhone 16 128 White 🇯🇵', 'iPhone 16 256 Black 🇪🇺']);
  assert.deepEqual(Array.from(r, x => api.rusPhone_(x.name).memory), ['128 ГБ', '256 ГБ']);
});
test('splits multiple supplier countries into one row per country', () => {
  const r = api.rusParsePost_('iPhone 17\n🇯🇵🇪🇺17 128 Black — 70 000', 'countries').rows;
  assert.equal(r.length, 2); assert.deepEqual(Array.from(r, x => api.rusPhone_(x.name).country), ['Япония 🇯🇵', 'Европа 🇪🇺']);
});
test('recognizes terabyte memory and does not duplicate the Pro Max model', () => {
  const r = api.rusParsePost_('iPhone 17 Pro Max •••\n🇯🇵17 Pro Max 1TB Blue — 150 000', 'tb').rows[0];
  assert.equal(r.name, 'iPhone 17 Pro Max 1TB Blue 🇯🇵'); assert.equal(api.rusPhone_(r.name).memory, '1 ТБ');
});
test('parses an iPad section whose headings start with supplier emoji', () => {
  const r = api.rusParsePost_('💻 iPad •••\n🔘 iPad 11 •••\n🇺🇸11" A16 128GB Wi-Fi Pink-44 990', 'ipad').rows[0];
  assert.equal(r.category, 'айпады'); assert.equal(api.rusPhone_(r.name).memory, '128 ГБ'); assert.equal(r.price, 44990);
});
test('does not falsely carry an iPhone context into another product family', () => {
  assert.equal(api.rusExpand_('iPhone 16 Pro', 'Dyson HD16 Blue'), 'Dyson HD16 Blue');
});
test('keeps MacBook and Watch families from supplier headings', () => {
  const mac = api.rusParsePost_('💻 MacBook •••\n🇺🇸Neo 13 8/256 Citrus — 68 990', 'mac').rows[0];
  assert.equal(mac.category, 'макбуки'); assert.equal(mac.name, 'MacBook Neo 13 8/256 Citrus 🇺🇸');
  assert.equal(api.rusPhone_(mac.name).memory, '256 ГБ'); assert.equal(mac.price, 68990);
  const watch = api.rusParsePost_('⌚ Watch •••\n🔘 SE3 40mm •••\n🇺🇸SE3 40mm Midnight S/M — 24 490', 'watch').rows[0];
  assert.equal(watch.category, 'часы'); assert.equal(watch.name, 'Apple Watch SE3 40mm Midnight S/M 🇺🇸');
  assert.equal(watch.price, 24490);
});
test('removes supplier emoji from headphone names and recognizes all supplied colors', () => {
  const r = api.rusParsePost_('🎧 AirPods •••\n🔈AirPods Max 2026 Midnight — 46 990', 'pods').rows[0];
  assert.equal(r.name, 'AirPods Max 2026 Midnight'); assert.equal(r.category, 'наушники');
  assert.equal(api.rusColor_('MacBook Neo Citrus'), 'желтый');
  assert.equal(api.rusColor_('Watch SE3 Starlight'), 'белый');
  assert.equal(api.rusColor_('AirPods Max Purple'), 'фиолетовый');
});
test('excludes SmartTag trackers from the phone catalogue and removes their location marker', () => {
  const parsed = api.rusParsePost_('📍 Galaxy SmartTag2 — 3 490\n📍 Galaxy SmartTag2 (4 Pack) — 6 990', 'smarttag');
  assert.deepEqual(Array.from(parsed.rows), []);
  assert.equal(api.rusCategory_('Galaxy SmartTag2'), 'прочее');
  assert.equal(api.rusExpand_('', '📍 Galaxy SmartTag2'), 'Galaxy SmartTag2');
});
test('uses a price with a supplier article but skips an unconfirmed one', () => {
  const r = api.rusParsePost_('MacBook\n🇺🇸Neo 13 8/256 Citrus-66 990 MHFD4\n🇺🇸Neo 13 8/256 Blush-70 490 MHFH4 ?', 'article').rows;
  assert.equal(r.length, 1); assert.equal(r[0].price, 66990); assert.equal(r[0].name, 'MacBook Neo 13 8/256 Citrus 🇺🇸');
});
test('keeps iPhone Air and fills the remaining supplier colors', () => {
  const r = api.rusParsePost_('iPhone Air\n🇯🇵Air 256 Gold (eSim)-78 490', 'air').rows[0];
  assert.equal(r.category, 'телефоны'); assert.equal(api.rusPhone_(r.name).model, 'iPhone Air');
  assert.equal(api.rusPhone_(r.name).memory, '256 ГБ'); assert.equal(api.rusPhone_(r.name).color, 'золотистый');
  assert.equal(api.rusColor_('GamePad PS5 Camouflage'), 'зеленый');
  assert.equal(api.rusColor_('GamePad PS5 Chroma Pearl'), 'белый');
  assert.equal(api.rusColor_('GamePad PS5 Volcanic Red'), 'красный');
  assert.equal(api.rusColor_('iPhone 17 Lavender'), 'фиолетовый');
  assert.equal(api.rusColor_('iPhone 17 Sage'), 'зеленый');
});

test('normalizes Galaxy S26 SIM before the shared matcher and exposes phones only', () => {
  assert.equal(api.rusReadySim_({ model:'Galaxy S26', sim:'' }), 'SIM + eSIM');
  assert.match(src, /sheets:\{ 'телефоны'/);
  assert.match(src, /getProperty\(RUS\.props\.snapshotSecret\)/);
});
