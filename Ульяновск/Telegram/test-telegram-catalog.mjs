import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./TelegramCatalog.gs', import.meta.url), 'utf8') + `
globalThis.API={tcChannel_,tcCategory_,tcPhone_,tcColor_,tcLayouts_,tcTargetRow_,tcParsePost_,tcLine_,tcSummary_,tcProductSort_,tcAddTwoSimMirror_,tcChooseCheapestCountry_,tcParseMarkupCsv_,tcApplyUlyanovskMarkup_,tcMarkupAmount_,tcMarkupKey_,tcAvitoLayout_,tcAvitoPricePlan_,tcAvitoTitleLayout_,tcAvitoTitlePricePlan_,tcAvitoDirectSource_,tcAvitoDirectPhonePlan_,tcAvitoDirectTitlePlan_,tcAvitoSafePhoneFallback_,tcAvitoTitleFallback_,tcAvitoTitleScore_};`;
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
  assert.match(html, /id="mirrorTwoSim"/);
  assert.match(html, /Добавлять вариант <b>2 SIM<\/b> по цене <b>SIM \+ eSIM<\/b>/);
  assert.match(html, /\.saveTelegramCatalogSetup\(\{project:byId\('project'\)\.value,channel:byId\('channel'\)\.value,mirrorTwoSim:byId\('mirrorTwoSim'\)\.checked\}\)/);
  assert.match(html, /syncButton\.addEventListener\('click'/);
  assert.match(source, /function saveTelegramCatalogSetup\(form\)/);
});

test('accepts public channel handles and t.me URLs', () => {
  assert.equal(api.tcChannel_('@opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/s/opt_uniseil'), 'opt_uniseil');
  assert.equal(api.tcChannel_('https://t.me/+private'), '');
});

test('routes all standard source product families to client tabs', () => {
  assert.equal(api.tcCategory_('iPhone 17 Pro'), 'телефоны');
  assert.equal(api.tcCategory_('Samsung Galaxy S24'), 'телефоны');
  assert.equal(api.tcCategory_('Apple iPad 11'), 'айпады');
  assert.equal(api.tcCategory_('MacBook Air M4'), 'макбуки');
  assert.equal(api.tcCategory_('Apple Watch Ultra'), 'часы');
  assert.equal(api.tcCategory_('AirPods Pro'), 'наушники');
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

test('does not duplicate a model supplied both by the section title and its row', () => {
  const row = api.tcLine_('iPhone 16 Pro', '16 Pro 128GB White 🇨🇳 (Dual-Sim) - 78 900 ₽', 'opt_uniseil', '7291');
  assert.equal(row.name, 'iPhone 16 Pro 128GB White');
  const phone = api.tcPhone_(row.name + ' ' + row.variant);
  assert.equal(phone.model, 'iPhone 16 Pro');
  assert.equal(phone.config, '2 SIM');
  assert.equal(phone.country, 'Китай 🇨🇳');
});

test('recognises colours in any part of a Telegram item without inventing a missing one', () => {
  assert.equal(api.tcColor_('iPhone 17 Pro — чёрный 256GB 🇯🇵'), 'черный');
  assert.equal(api.tcColor_('iPhone 16 Pro (Desert Titanium), eSIM'), 'золотистый');
  assert.equal(api.tcColor_('Pixel 9 Pro 12/256GB, Obsidian 🇮🇳'), 'черный');
  assert.equal(api.tcColor_('iPhone 17 Sage 256GB'), 'зеленый');
  assert.equal(api.tcColor_('iPhone 17 Pro Blue 256GB'), 'синий');
  assert.equal(api.tcColor_('iPhone 17 Pro 256GB eSIM 🇯🇵'), '');
});

test('adds exactly one 2 SIM variant at the SIM + eSIM price when the Ulyanovsk rule is enabled', () => {
  const sourceRows = [
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB SIM + eSIM Blue', variant: '🇮🇳', price: 102990 },
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB eSIM Blue', variant: '🇮🇳', price: 98500 }
  ];
  const mirrored = api.tcAddTwoSimMirror_(sourceRows, true);
  assert.equal(mirrored.mirrored, 1);
  assert.equal(mirrored.rows.length, 3);
  const twoSim = mirrored.rows.find((row) => api.tcPhone_(row.name + ' ' + row.variant).config === '2 SIM');
  assert.ok(twoSim);
  assert.equal(twoSim.price, 102990);
  assert.equal(api.tcPhone_(twoSim.name).model, 'iPhone 17 Pro');
  assert.equal(api.tcAddTwoSimMirror_(mirrored.rows, true).mirrored, 0);
  assert.equal(api.tcAddTwoSimMirror_(sourceRows, false).rows.length, 2);
});

test('keeps one cheapest country per full phone configuration', () => {
  const rows = [
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB SIM + eSIM Blue', variant: '🇯🇵', price: 103000 },
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB SIM + eSIM Blue', variant: '🇮🇳', price: 101000 },
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB eSIM Blue', variant: '🇯🇵', price: 98000 },
    { category: 'телефоны', name: 'iPhone 17 Pro 512GB SIM + eSIM Blue', variant: '🇯🇵', price: 120000 }
  ];
  const selected = api.tcChooseCheapestCountry_(rows);
  assert.equal(selected.rows.length, 3);
  assert.equal(selected.removed, 1);
  assert.equal(selected.rows.find((row) => row.price === 101000).variant, '🇮🇳');
  assert.ok(selected.rows.some((row) => api.tcPhone_(row.name).config === 'eSIM'));
});

test('applies Ulyanovsk markup directly from the markup-file rules', () => {
  const rules = api.tcParseMarkupCsv_('Модель,Наценка\niPhone 13 - 17 Pro max 256,3000\niPhone 17 Pro 512/1тб  - 17 Pro Max 512/1тб,4000\nНаушники AirPods,2000\nЧасы,2500\n"iPad все, кроме Про",3000\niPad Pro,4000\nMacBook,3500\nimac/mini,3000');
  const priced = api.tcApplyUlyanovskMarkup_([
    { category: 'телефоны', name: 'iPhone 17 Pro 256GB eSIM Blue', variant: '🇯🇵', price: 98500 },
    { category: 'телефоны', name: 'iPhone 17 Pro 512GB eSIM Blue', variant: '🇯🇵', price: 119800 },
    { category: 'наушники', name: 'AirPods Pro 3', price: 20000 },
    { category: 'айпады', name: 'iPad Pro 13 256GB', price: 70000 },
    { category: 'телефоны', name: 'Pixel 10 256GB', price: 50000 }
  ], rules);
  assert.deepEqual(priced.rows.map((row) => row.price), [101500, 123800, 22000, 74000]);
  assert.equal(priced.applied, 4);
  assert.equal(priced.withoutRule, 1);
});

test('uses exact rules from every Ulyanovsk markup tab before broad brand rules', () => {
  const rules = api.tcParseMarkupCsv_('Модель,Наценка\nGalaxy S25 12/256GB Blue 🇪🇺,4500\nDyson HJ10 HushJet Black/Teal 🇸🇬,2000\nНаушники AirPods,2000');
  const priced = api.tcApplyUlyanovskMarkup_([
    { category: 'телефоны', name: 'Galaxy S25 12/256 ГБ Blue', variant: '🇪🇺', price: 60000 },
    { category: 'дайсон', name: '(Уценка) Dyson HJ10 HushJet Black/Teal', variant: '🇸🇬', price: 30000 }
  ], rules);
  assert.deepEqual(priced.rows.map((row) => row.price), [64500, 32000]);
  assert.equal(api.tcMarkupKey_('Galaxy S25 12/256GB Blue 🇪🇺'), api.tcMarkupKey_('Galaxy S25 12/256 ГБ Blue'));
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
  const summary = api.tcSummary_({ rows: 120, written: 120, cheapest: 10, markedUp: 100, withoutMarkup: 20 });
  assert.match(summary, /120 позиций/);
  assert.match(summary, /самых дешёвых вариантов: 10/);
  assert.match(summary, /Наценка из файла применена к 100/);
  assert.match(summary, /Без правила наценки: 20/);
});

test('plans direct Ulyanovsk Avito price updates without changing any product fields', () => {
  const layout = api.tcAvitoLayout_(['Vendor', 'Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price', 'DateEnd']);
  const products = [
    { category: 'телефоны', name: 'iPhone 13 128GB 2 SIM Black', price: 46800 },
    { category: 'телефоны', name: 'Galaxy A17 4/128GB Black', price: 13000 }
  ];
  const rows = [
    ['Apple', 'iPhone 13', '128 ГБ', 'черный', '2 SIM', '4 ГБ', '', new Date('2099-01-01')],
    ['Samsung', 'Galaxy A17', '128 ГБ', 'черный', 'Не знаю', '4 ГБ', '', new Date('2099-01-01')]
  ];
  const plan = api.tcAvitoPricePlan_(products, layout, rows);
  assert.equal(JSON.stringify(plan.updates), JSON.stringify([{ row: 0, price: 46800 }, { row: 1, price: 13000 }]));
  assert.equal(plan.matched, 2);
});

test('copies Avito prices from the prepared catalogue fields, not raw Telegram names', () => {
  const sourceHeaders = ['Model', 'SimConfig', 'MemorySize', 'Color', 'Price', '', 'Model', 'SimConfig', 'MemorySize', 'Color', 'RamSize', 'Price'];
  const source = api.tcAvitoDirectSource_(sourceHeaders, [
    ['iPhone 13', '2 SIM', '128 ГБ', 'черный', 46800, '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', 'Galaxy S25', 'SIM + eSIM', '256 ГБ', 'синий', '12 ГБ', 48800]
  ]);
  const layout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price', 'DateEnd']);
  const plan = api.tcAvitoDirectPhonePlan_(source, layout, [
    ['iPhone 13', '128 ГБ', 'черный', '2 SIM', '4 ГБ', '', new Date('2099-01-01')],
    ['Galaxy S25', '256 ГБ', 'синий', 'SIM + eSIM', '12 ГБ', '', new Date('2099-01-01')]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row: 0, price: 46800 }, { row: 1, price: 48800 }]);
  const relaxedPhonePlan = api.tcAvitoDirectPhonePlan_([
    { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: '2 SIM', ram: '', price: 52800 },
    { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: 'SIM + eSIM', ram: '', price: 52800 }
  ], layout, [['iPhone 13', '128 ГБ', 'белый', 'Не знаю', '4 ГБ', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(relaxedPhonePlan.updates)), []);
  const titlePlan = api.tcAvitoDirectTitlePlan_([{ title: 'iPad 11 128GB Wi-Fi Pink', price: 40800 }], 'айпады', api.tcAvitoTitleLayout_(['Title', 'Price', 'DateEnd']), [['Apple iPad 11, 128 ГБ Wi-Fi Pink', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(titlePlan.updates)), [{ row: 0, price: 40800 }]);
  const cheapestPhonePlan = api.tcAvitoDirectPhonePlan_([
    { model: 'Galaxy S25', memory: '256 ГБ', color: 'синий', sim: 'SIM + eSIM', ram: '12 ГБ', price: 48800 },
    { model: 'Galaxy S25', memory: '256 ГБ', color: 'синий', sim: 'SIM + eSIM', ram: '12 ГБ', price: 48000 }
  ], layout, [['Galaxy S25', '256 ГБ', 'синий', 'SIM + eSIM', '12 ГБ', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(cheapestPhonePlan.updates)), [{ row: 0, price: 48000 }]);
});

test('never substitutes a different supplier SIM or colour configuration', () => {
  const phones = [
    { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: '2 SIM', ram: '', price: 52800 },
    { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: 'SIM + eSIM', ram: '', price: 52800 },
    { model: 'iPhone 13 Mini', memory: '512 ГБ', color: 'черный', sim: '2 SIM', ram: '', price: 48800 }
  ];
  assert.equal(api.tcAvitoSafePhoneFallback_(phones, { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: 'Не знаю', ram: '4 ГБ' }), null);
  assert.equal(api.tcAvitoSafePhoneFallback_(phones, { model: 'iPhone 13 Mini', memory: '512 ГБ', color: 'розовый', sim: 'Не знаю', ram: '4 ГБ' }), null);
  assert.equal(api.tcAvitoSafePhoneFallback_([
    { model: 'iPhone 13', memory: '128 ГБ', color: 'черный', sim: '2 SIM', ram: '', price: 46800 },
    { model: 'iPhone 13', memory: '128 ГБ', color: 'черный', sim: 'SIM + eSIM', ram: '', price: 40000 }
  ], { model: 'iPhone 13', memory: '128 ГБ', color: 'черный', sim: 'Не знаю', ram: '4 ГБ' }), null);
});

test('does not copy a 2 SIM price into an unavailable eSIM listing', () => {
  const layout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const plan = api.tcAvitoDirectPhonePlan_([
    { model:'iPhone 16 Pro', memory:'128 ГБ', color:'белый', sim:'2 SIM', ram:'', price:81900 }
  ], layout, [['iPhone 16 Pro', '128 ГБ', 'белый', 'eSIM', '', 74600]]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:'' }]);
  assert.equal(plan.cleared, 1);
});

test('uses an unambiguous phone price when the supplier omitted only the colour', () => {
  const layout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price', 'DateEnd']);
  const plan = api.tcAvitoPricePlan_([
    { category: 'телефоны', name: 'Galaxy S25 FE 8/128GB SIM + eSIM', price: 37300 }
  ], layout, [['Galaxy S25 FE', '128 ГБ', 'белый', 'SIM + eSIM', '8 ГБ', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row: 0, price: 37300 }]);
});

test('plans direct Ulyanovsk Avito price updates for a title-based non-phone tab', () => {
  const layout = api.tcAvitoTitleLayout_(['id', 'Title', 'Description', 'Price', 'DateEnd']);
  const products = [
    { category: 'макбуки', name: 'MacBook Air 13 M4 Midnight', variant: '🇯🇵', price: 104000 },
    { category: 'макбуки', name: 'MacBook Air 13 M4 Midnight', variant: '🇺🇸', price: 106000 }
  ];
  const rows = [['1', 'MacBook Air 13 M4 Midnight', '', 99000, new Date('2099-01-01')], ['2', 'MacBook Pro 14 M4', '', 123000, new Date('2099-01-01')]];
  const plan = api.tcAvitoTitlePricePlan_(products.slice(0, 1), 'макбуки', layout, rows);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row: 0, price: 104000 }]);
  assert.equal(plan.matched, 1);
  const conflicted = api.tcAvitoTitlePricePlan_(products, 'макбуки', layout, rows);
  assert.equal(conflicted.ambiguous[0], 'MacBook Air 13 M4 Midnight');
});

test('matches iPad and Dyson titles by meaningful words but rejects conflicting hardware', () => {
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'iPad Mini 7 (A17) 2024 128GB Wi-Fi Blue', price: 42000 }
  ], 'айпады', 'iPad 7 mini (2024), 128 ГБ Wi-Fi Blue').price, 42000);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'Dyson HS08 Ceramic Pink/Rose Gold', price: 45000 }
  ], 'дайсон', 'Стайлер Dyson HS08 Ceramic Pink/Rose Gold').price, 45000);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'MacBook Air 13 M5 16/512GB Starlight', price: 150000 }
  ], 'макбуки', 'MacBook Air 13 M4 16/256 Starlight'), null);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'iPad 11 (A16) 2025 128GB Wi-Fi Pink', price: 40800 },
    { title: 'iPad 11 (A16) 2025 128GB Wi-Fi + LTE Pink', price: 50300 },
    { title: 'iPad 11 (A16) 2025 256GB Wi-Fi Pink', price: 48100 }
  ], 'айпады', 'Apple iPad 11 (A16, 2025), 128 ГБ Wi-Fi Pink').price, 40800);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'MacBook Air 13 M5 16/512GB Silver', price: 131800 },
    { title: 'MacBook Air 13 M5 16/1TB Silver', price: 143200 }
  ], 'макбуки', 'MacBook Air 13 (2026, M5) 16/512 Silver').price, 131800);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'Apple Watch SE 2 40mm Silver (M/L)', price: 21800 },
    { title: 'Apple Watch SE 3 40mm Silver (M/L)', price: 23600 }
  ], 'часы', 'Apple Watch SE 2 40mm Silver').price, 21800);
  assert.equal(api.tcAvitoTitleFallback_([
    { title: 'Apple Watch SE 2 40mm Silver (M/L)', price: 25000 },
    { title: 'Apple Watch SE 2 40mm Silver (S/M)', price: 27000 }
  ], 'часы', 'Apple Watch SE 2 40mm Silver').ambiguous, true);
});
