import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./TelegramCatalog.gs', import.meta.url), 'utf8') + `
globalThis.API={tcChannel_,tcCategory_,tcPhone_,tcColor_,tcLayouts_,tcLayoutFor_,tcTargetRow_,tcParsePost_,tcLine_,tcSummary_,tcProductSort_,tcApplyElektrostalMarkup_,tcElektrostalMarkupAmount_,tcExpand_,tcAvitoLayout_,tcAvitoPricePlan_,tcAvitoTitleLayout_,tcAvitoTitlePricePlan_};`;
const parseCsv = (value) => String(value).trim().split(/\r?\n/).map((line) => {
  const cells = []; let current = ''; let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { cells.push(current); current = ''; continue; }
    current += char;
  }
  cells.push(current); return cells;
});
const context = { console, Utilities: { parseCsv } };
vm.createContext(context); vm.runInContext(source, context);
const api = context.API;

test('uses the original two-button sidebar interaction with one setup object', () => {
  const html = fs.readFileSync(new URL('./TelegramCatalogSidebar.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="setup">/);
  assert.match(html, /byId\('setup'\)\.addEventListener\('submit'/);
  assert.doesNotMatch(html, /2 SIM/);
  assert.match(html, /\.saveTelegramCatalogSetup\(\{project:byId\('project'\)\.value,channel:byId\('channel'\)\.value\}\)/);
  assert.match(html, /syncButton\.addEventListener\('click'/);
  assert.match(source, /function saveTelegramCatalogSetup\(form\)/);
});

test('accepts the public supplier price channel handle and t.me URLs', () => {
  assert.equal(api.tcChannel_('@opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/s/opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/+private'), '');
});

test('routes all standard source product families to client tabs', () => {
  assert.equal(api.tcCategory_('iPhone 17 Pro'), 'телефоны');
  assert.equal(api.tcCategory_('Samsung Galaxy S24'), 'телефоны');
  assert.equal(api.tcCategory_('Galaxy Book 4 Edge NP940XMA-KB1HK'), 'макбуки');
  assert.equal(api.tcCategory_('Apple iPad 11'), 'айпады');
  assert.equal(api.tcCategory_('Samsung Galaxy Tab A11'), 'айпады');
  assert.equal(api.tcCategory_('MacBook Air M4'), 'макбуки');
  assert.equal(api.tcCategory_('Apple Watch Ultra'), 'часы');
  assert.equal(api.tcCategory_('Galaxy Fit 3'), 'часы');
  assert.equal(api.tcCategory_('Galaxy Ring 7'), 'часы');
  assert.equal(api.tcCategory_('AirPods Pro'), 'наушники');
  assert.equal(api.tcCategory_('Galaxy Buds 4'), 'наушники');
  assert.equal(api.tcCategory_('PlayStation 5 Slim'), 'пс');
  assert.equal(api.tcCategory_('Dyson HD16'), 'дайсон');
  assert.equal(api.tcCategory_('iMac M4'), 'аймаки');
});

test('reads a supplier price and splits SIM and country into separate fields', () => {
  const row = api.tcLine_('iPhone 17 Pro', '256GB SIM + eSIM Синий 🇮🇳 — 102 990 ₽', 'opt_uniseil', '42');
  assert.equal(row.name, 'iPhone 17 Pro 256GB SIM + eSIM Синий');
  assert.equal(row.price, 102990);
  const phone = api.tcPhone_(row.name + ' ' + row.variant);
  assert.equal(phone.model, 'iPhone 17 Pro');
  assert.equal(phone.memory, '256 ГБ');
  assert.equal(phone.color, 'синий');
  assert.equal(phone.config, 'SIM + eSIM');
  assert.equal(phone.country, 'Индия 🇮🇳');
});

test('keeps Active and Уценка as bracketed title marks even before iPhone', () => {
  const active = api.tcParsePost_('(Active) iPhone 17\n17 256GB Black — 73 500 ₽', 'astoredirectprice', 'active');
  const markdown = api.tcParsePost_('iPhone 16\n(Уценка) 16 128GB White — 64 990 ₽', 'astoredirectprice', 'markdown');
  assert.equal(active[0].name, '(Актив) iPhone 17 256GB Black');
  assert.equal(markdown[0].name, '(Уценка) iPhone 16 128GB White');
  assert.equal(api.tcPhone_(active[0].name).model, 'iPhone 17');
});

test('reads the current price-channel Active/Уценка section and puts its status first', () => {
  const active = api.tcParsePost_('♻️ Уценка / Актив\nЦена за объём\nApple · iPhone 17\n17 256 ГБ White (1Sim+eSim) Актив\n1 шт 70 300 ₽ · 3+ 70 200 ₽', 'astoredirectprice', '6646');
  const markdown = api.tcParsePost_('♻️ Уценка / Актив\nЦена за объём\nApple · iPad Pro 13\niPad Pro 13 256 ГБ Wi-Fi Space Black Уценка\n1 шт 108 000 ₽ · 3+ 107 900 ₽', 'astoredirectprice', '6646');
  assert.equal(active[0].name, '(Актив) iPhone 17 256 ГБ White (1Sim+eSim)');
  assert.equal(active[0].category, 'телефоны');
  assert.equal(markdown[0].name, '(Уценка) iPad Pro 13 256 ГБ Wi-Fi Space Black');
  assert.equal(markdown[0].category, 'айпады');
});

test('recognises colours in any part of a Telegram item without inventing a missing one', () => {
  assert.equal(api.tcColor_('iPhone 17 Pro — чёрный 256GB 🇯🇵'), 'черный');
  assert.equal(api.tcColor_('iPhone 16 Pro (Desert Titanium), eSIM'), 'золотистый');
  assert.equal(api.tcColor_('Pixel 9 Pro 12/256GB, Obsidian 🇮🇳'), 'черный');
  assert.equal(api.tcColor_('iPhone 17 Sage 256GB'), 'зеленый');
  assert.equal(api.tcColor_('iPhone 17 Pro Blue 256GB'), 'синий');
  assert.equal(api.tcColor_('iPhone 17 Pro 256GB eSIM 🇯🇵'), '');
});

test('applies Elektrоstal Apple and Android markup to all eligible categories, then rounds up to 500 rubles', () => {
  const priced = api.tcApplyElektrostalMarkup_([
    { category: 'телефоны', name: 'iPhone 17 128GB', price: 15700 },
    { category: 'телефоны', name: 'Samsung Galaxy S25 256GB', price: 35700 },
    { category: 'телефоны', name: 'Pixel 10 Pro 256GB', price: 111100 },
    { category: 'телефоны', name: 'iPhone 17 Pro 512GB', price: 151100 },
    { category: 'айпады', name: 'iPad 11 A16 128GB Wi-Fi Blue', price: 37100 },
    { category: 'макбуки', name: 'MacBook Air M5 16/1TB Midnight', price: 127400 },
    { category: 'часы', name: 'Apple Watch Series 11 42mm', price: 28600 },
    { category: 'наушники', name: 'AirPods Pro 3', price: 20000 },
    { category: 'дайсон', name: 'Dyson HD17', price: 32600 },
    { category: 'пс', name: 'PlayStation 5 Slim', price: 70100 },
    { category: 'аксессуары', name: 'USB-C cable', price: 380 },
    { category: 'макбуки', name: 'MacBook Pro 14 M5 Max 36/2 ТБ', price: 304000 }
  ]);
  assert.deepEqual(priced.rows.map((row) => row.price), [19000,41000,121500,164500,42500,136500,33000,24000,38000,78500,380,319000]);
  assert.deepEqual(priced.rows.slice(0, 10).map((row) => row.markup), [3000,5000,10000,13000,5000,9000,4000,4000,5000,8000]);
  assert.equal(priced.rows[11].markup, 15000);
  assert.equal(priced.applied, 11);
  assert.equal(priced.withoutRule, 1);
});

test('parses the supplier price-channel bullet format and keeps a country flag', () => {
  const rows = api.tcParsePost_('📱 iPhone\n💼 Цена за объём\n• iPhone 17 Pro 256GB Blue 🇯🇵 — 102.990 ₽', 'astoredirectprice', '6331');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'телефоны');
  assert.equal(rows[0].price, 102990);
  assert.equal(api.tcPhone_(rows[0].name + ' ' + rows[0].variant).country, 'Япония 🇯🇵');
});

test('parses the supplier 1-unit price from the volume-price format without choosing cheapest country', () => {
  const rows = api.tcParsePost_('📱 iPhone\n💼 Цена за объём\n1 шт — основная · 3+ и 5+ — цена за штуку\niPhone 17 Pro\n17 Pro 256 ГБ Silver (eSim)\n1 шт 97 400 ₽ · 3+ 97 300 ₽ · 5+ 97 200 ₽\n17 Pro 256 ГБ Deep Blue (1Sim+eSim)\n1 шт 100 000 ₽ · 3+ 99 900 ₽ · 5+ 99 800 ₽', 'astoredirectprice', '6336');
  assert.equal(rows.length, 2);
  assert.deepEqual([...rows.map((row) => row.name)], ['iPhone 17 Pro 256 ГБ Silver (eSim)', 'iPhone 17 Pro 256 ГБ Deep Blue (1Sim+eSim)']);
  assert.deepEqual([...rows.map((row) => row.price)], [97400, 100000]);
});

test('does not carry a MacBook heading over to Dyson or Garmin lines in one Telegram post', () => {
  const rows = api.tcParsePost_('MacBook\nЦена за объём\n1 шт — основная · 3+ — цена за штуку\nMacBook Air 13 M5 16/1 ТБ Midnight\n1 шт 118 400 ₽ · 3+ 117 900 ₽\nDyson HS 09 Amber Silk Уценка\n1 шт 47 500 ₽ · 3+ 47 000 ₽\nGarmin Instinct Crossover Black Уценка\n1 шт 33 600 ₽ · 3+ 33 100 ₽', 'astoredirectprice', '6337');
  assert.deepEqual([...rows.map((row) => row.name)], ['MacBook Air 13 M5 16/1 ТБ Midnight', '(Уценка) Dyson HS 09 Amber Silk']);
  assert.deepEqual([...rows.map((row) => row.category)], ['макбуки', 'дайсон']);
});

test('removes an accidental opening bracket from a supplier product name', () => {
  const rows = api.tcParsePost_('Dyson\nЦена за объём\n1 шт — основная\n[ Dyson HD17 Supersonic R Pro Jasper Plum\n1 шт 32 600 ₽ · 3+ 32 100 ₽', 'astoredirectprice', '6417');
  assert.equal(rows[0].name, 'Dyson HD17 Supersonic R Pro Jasper Plum');
  assert.equal(rows[0].category, 'дайсон');
});

test('does not retain a Telegram bullet in model names and routes Galaxy families correctly', () => {
  const rows = api.tcParsePost_('Аксессуары\n• Galaxy Buds 4 Black — 6.900 ₽\n• Galaxy Watch 8 Silver — 19.900 ₽\n• Galaxy Tab A11 8/128GB Silver — 24.900 ₽', 'astoredirectprice', '7000');
  assert.deepEqual([...rows.map((row) => row.name)], ['Galaxy Buds 4 Black', 'Galaxy Watch 8 Silver', 'Galaxy Tab A11 8/128GB Silver']);
  assert.deepEqual([...rows.map((row) => row.category)], ['наушники', 'часы', 'айпады']);
});

test('parses a complete public-channel product post', () => {
  const rows = api.tcParsePost_('iPad 11 (A16)\n128GB Wi-Fi Blue 🇯🇵 — 34 990 ₽\n256GB Wi-Fi Yellow 🇺🇸 — 42 990 ₽', 'opt_uniseil', '99');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category, 'айпады');
  assert.equal(rows[1].price, 42990);
});

test('does not drop Google and Honor brand sections with Android positions', () => {
  const pixels = api.tcParsePost_('Google\nPixel 7 8/128GB Lemongrass 🇺🇸 — 23 500 ₽', 'opt_uniseil', '101');
  const honors = api.tcParsePost_('Honor\nHonor x8d 8/256GB Gray 🇷🇺 — 19 000 ₽', 'opt_uniseil', '102');
  assert.equal(pixels.length, 1);
  assert.equal(honors.length, 1);
  const pixel = api.tcPhone_(pixels[0].name + ' ' + pixels[0].variant);
  const honor = api.tcPhone_(honors[0].name + ' ' + honors[0].variant);
  assert.deepEqual({ model: pixel.model, ram: pixel.ram, memory: pixel.memory, country: pixel.country }, { model: 'Pixel 7', ram: '8 ГБ', memory: '128 ГБ', country: 'США 🇺🇸' });
  assert.deepEqual({ model: honor.model, ram: honor.ram, memory: honor.memory, country: honor.country }, { model: 'Honor x8d', ram: '8 ГБ', memory: '256 ГБ', country: 'Россия 🇷🇺' });
});

test('fills a standard phone block without relying on an old catalogue row', () => {
  const headers = ['Model', 'SimConfig', 'MemorySize', 'Color', 'Price'];
  const layout = api.tcLayouts_(headers)[0];
  const row = api.tcTargetRow_(headers, layout, { name: 'iPhone 17 Pro 256GB SIM + eSIM Blue', variant: '🇮🇳', price: 102990 });
  assert.deepEqual([...row], ['iPhone 17 Pro', 'SIM + eSIM', '256 ГБ', 'синий', 102990]);
});

test('fills Android RAM separately in the standard right-hand phone block', () => {
  const headers = ['Model', 'SimConfig', 'MemorySize', 'Color', 'RamSize', 'Price'];
  const layout = api.tcLayouts_(headers)[0];
  const row = api.tcTargetRow_(headers, layout, { name: 'Pixel 7 8/128GB Lemongrass', variant: '🇺🇸', price: 23500 });
  assert.deepEqual([...row], ['Pixel 7', 'Не знаю', '128 ГБ', 'желтый', '8 ГБ', 23500]);
});

test('keeps service-marked iPhones in the left phone block', () => {
  const layouts = api.tcLayouts_(['Model', 'SimConfig', 'MemorySize', 'Color', 'Price', '', 'Model', 'SimConfig', 'MemorySize', 'Color', 'RamSize', 'Price']);
  assert.equal(api.tcLayoutFor_(layouts, { category: 'телефоны', name: '• iPhone 17 256GB Black' }), 0);
  assert.equal(api.tcLayoutFor_(layouts, { category: 'телефоны', name: '(Уценка) iPhone 16 128GB White' }), 0);
  assert.equal(api.tcLayoutFor_(layouts, { category: 'телефоны', name: 'Galaxy S25 12/256GB Blue' }), 1);
});

test('removes supplier service markers and duplicate specs from the model field', () => {
  const phone = api.tcPhone_('iPhone (ASIS) 16 Pro 512GB Black 🇺🇸 (E-Sim)');
  assert.equal(phone.model, 'iPhone 16 Pro');
  assert.equal(phone.memory, '512 ГБ');
  assert.equal(phone.config, 'eSIM');
  assert.equal(phone.country, 'США 🇺🇸');
});

test('sorts iPhones by generation before the order of Telegram posts', () => {
  const products = [
    { name: 'iPhone 17 Pro Max 256GB Blue', price: 121500 },
    { name: 'iPhone 14 512GB Blue', price: 53500 },
    { name: 'iPhone 17e 256GB Black', price: 74000 },
    { name: 'iPhone 13 128GB White', price: 42600 },
    { name: 'iPhone 16 Pro 256GB Black', price: 78000 },
    { name: 'iPhone 15 256GB Blue', price: 63500 },
    { name: 'iPhone 17 Air 512GB Black', price: 82300 }
  ];
  products.sort(api.tcProductSort_);
  assert.deepEqual(products.map((product) => api.tcPhone_(product.name).model), [
    'iPhone 13', 'iPhone 14', 'iPhone 15', 'iPhone 16 Pro',
    'iPhone 17e', 'iPhone 17 Air', 'iPhone 17 Pro Max'
  ]);
});

test('removes restrictive dropdown validation and old country columns', () => {
  assert.match(source, /target\.clearDataValidations\(\)/);
  assert.match(source, /function tcRemoveCountryColumns_\(sheet\)/);
});

test('supports a title/price template and reports concise outcome', () => {
  const headers = ['Title', 'Price'];
  const layout = api.tcLayouts_(headers)[0];
  const row = api.tcTargetRow_(headers, layout, { name: 'Dyson HD16 Ceramic Pink', variant: '🇯🇵', price: 27890 });
  assert.deepEqual([...row], ['Dyson HD16 Ceramic Pink', 27890]);
  const summary = api.tcSummary_({ rows: 120, written: 120, markedUp: 100, withoutMarkup: 20 });
  assert.match(summary, /120 позиций/);
  assert.doesNotMatch(summary, /самых дешёвых вариантов/);
  assert.match(summary, /Наценка Электростали применена к 100/);
  assert.match(summary, /Без правила наценки: 20/);
});

test('plans direct Elektrostal Avito price updates for phones and title-based tabs', () => {
  const phoneLayout = api.tcAvitoLayout_(['Vendor', 'Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const phonePlan = api.tcAvitoPricePlan_([{ category: 'телефоны', name: 'iPhone 13 128GB 2 SIM Black', price: 46800 }], phoneLayout, [['Apple', 'iPhone 13', '128 ГБ', 'черный', '2 SIM', '4 ГБ', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(phonePlan.updates)), [{ row: 0, price: 46800 }]);
  const titleLayout = api.tcAvitoTitleLayout_(['id', 'Title', 'Price']);
  const titlePlan = api.tcAvitoTitlePricePlan_([{ category: 'дайсон', name: '(Уценка) Dyson HS 09 Amber Silk', price: 53500 }], 'дайсон', titleLayout, [['1', '(Уценка) Dyson HS 09 Amber Silk', 50000]]);
  assert.deepEqual(JSON.parse(JSON.stringify(titlePlan.updates)), [{ row: 0, price: 53500 }]);
  const lowestPhone = api.tcAvitoPricePlan_([
    { category: 'телефоны', name: 'Galaxy S25 12/256GB Blue SIM + eSIM', price: 57500 },
    { category: 'телефоны', name: 'Galaxy S25 12/256GB Blue SIM + eSIM', price: 56500 }
  ], phoneLayout, [['Samsung', 'Galaxy S25', '256 ГБ', 'синий', 'SIM + eSIM', '12 ГБ', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(lowestPhone.updates)), [{ row: 0, price: 56500 }]);
  const relaxedPhone = api.tcAvitoPricePlan_([
    { category: 'телефоны', name: 'iPhone 15 128GB Black eSIM', price: 65000 },
    { category: 'телефоны', name: 'iPhone 15 128GB Blue 2 SIM', price: 63000 }
  ], phoneLayout, [['Apple', 'iPhone 15', '128 ГБ', 'белый', 'SIM + eSIM', '6 ГБ', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(relaxedPhone.updates)), [{ row: 0, price: 63000 }]);
});
