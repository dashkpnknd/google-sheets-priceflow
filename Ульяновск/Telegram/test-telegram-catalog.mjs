import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./TelegramCatalog.gs', import.meta.url), 'utf8') + `
globalThis.API={tcChannel_,tcCategory_,tcPhone_,tcColor_,tcColorGroup_,tcModel_,tcAndroidTechnicalModifiers_,tcIsAsis_,tcLayouts_,tcTargetRow_,tcParsePost_,tcLine_,tcSummary_,tcProductSort_,tcAddTwoSimMirror_,tcChooseCheapestCountry_,tcParseMarkupCsv_,tcApplyUlyanovskMarkup_,tcMarkupAmount_,tcMarkupKey_,tcAvitoLayout_,tcAvitoPricePlan_,tcAvitoTitleLayout_,tcAvitoTitlePricePlan_,tcAvitoDirectSource_,tcAvitoDirectPhonePlan_,tcAvitoDirectTitlePlan_,tcAvitoSafePhoneFallback_,tcAvitoTitleFallback_,tcAvitoTitleScore_,tcAvitoTitleWithoutConnectivityKey_};`;
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
    { model: 'iPhone 13', memory: '128 ГБ', color: 'белый', sim: 'SIM + eSIM', ram: '', price: 50800 }
  ], layout, [['iPhone 13', '128 ГБ', 'белый', 'Не знаю', '4 ГБ', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(relaxedPhonePlan.updates)), [{ row: 0, price: 50800 }]);
  const avitoEsimPlan = api.tcAvitoDirectPhonePlan_([
    { model: 'iPhone 17 Pro', memory: '256 ГБ', color: 'серебристый', sim: 'eSIM', ram: '', price: 99300 },
    { model: 'iPhone 17 Pro', memory: '256 ГБ', color: 'серебристый', sim: '2 SIM', ram: '', price: 104800 }
  ], layout, [['iPhone 17 Pro', '256 ГБ', 'серебристый', 'Только eSIM', '', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(avitoEsimPlan.updates)), [{ row: 0, price: 99300 }]);
  const titlePlan = api.tcAvitoDirectTitlePlan_([{ title: 'iPad 11 128GB Wi-Fi Pink', price: 40800 }], 'айпады', api.tcAvitoTitleLayout_(['Title', 'Price', 'DateEnd']), [['Apple iPad 11, 128 ГБ Wi-Fi Pink', '', new Date('2099-01-01')]]);
  assert.deepEqual(JSON.parse(JSON.stringify(titlePlan.updates)), [{ row: 0, price: 40800 }]);
  const unknownSimTitlePlan = api.tcAvitoDirectTitlePlan_([{ category:'айпады', title: 'iPad Pro 11 M4 2024 256GB Wi-Fi + LTE Black', price: 82400 }], 'айпады', api.tcAvitoTitleLayout_(['Title', 'Price']), [['Apple iPad Pro 11 M4 2024, 256 ГБ Не знаю Black', '']]);
  assert.equal(api.tcAvitoTitleWithoutConnectivityKey_('iPad Pro 11 M4 2024 256GB Wi-Fi + LTE Black'), api.tcAvitoTitleWithoutConnectivityKey_('Apple iPad Pro 11 M4 2024, 256 ГБ Не знаю Black'));
  assert.deepEqual(JSON.parse(JSON.stringify(unknownSimTitlePlan.updates)), [{ row: 0, price: 82400 }]);
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

test('ignores SIM and colour when selecting the lowest ordinary phone price', () => {
  const layout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const plan = api.tcAvitoDirectPhonePlan_([
    { model:'iPhone 16 Pro', memory:'128 ГБ', color:'белый', sim:'2 SIM', ram:'', price:81900 }
  ], layout, [['iPhone 16 Pro', '128 ГБ', 'белый', 'eSIM', '', 74600]]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:81900 }]);
  assert.equal(plan.cleared, 0);
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
    { title: 'iPad 11 (A16) 2025 128GB Wi-Fi + LTE Pink', price: 50300 }
  ], 'айпады', 'Apple iPad 11 (A16, 2025), 128 ГБ Wi-Fi Не знаю Pink').price, 50300);
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

test('uses the minimum only among the same non-phone product identity', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const ps = api.tcAvitoDirectTitlePlan_([
    { category:'пс', title:'PS5 Slim Digital 1TB', price:61800 },
    { category:'пс', title:'PS5 Pro Digital 2TB', price:104300 }
  ], 'пс', layout, [['PS5 Slim', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ps.updates)), [{ row:0, price:61800 }]);
  const controller = api.tcAvitoDirectTitlePlan_([
    { category:'пс', title:'DualSense Black', price:6400 },
    { category:'пс', title:'DualSense Edge Black', price:17100 }
  ], 'пс', layout, [['DualSense Black', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.updates)), [{ row:0, price:6400 }]);
  const pods = api.tcAvitoDirectTitlePlan_([
    { category:'наушники', title:'AirPods 4 Type-C', price:11600 },
    { category:'наушники', title:'AirPods 4 ANC', price:15100 },
    { category:'наушники', title:'AirPods 4 ANC Уценка', price:15000 }
  ], 'наушники', layout, [['AirPods 4 с шумоподавлением', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(pods.updates)), [{ row:0, price:15100 }]);
});

test('updates ordinary MacBook configuration but excludes pre-activated and damaged-box stock', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const plan = api.tcAvitoDirectTitlePlan_([
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Silver', price:130800 },
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Silver предактивированный', price:122400 },
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Silver мятая коробка', price:120000 }
  ], 'макбуки', layout, [['MacBook Air 13 M5 16/1 ТБ Silver', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:130800 }]);
});

test('normalises 1TB/1024 and matches MacBook Neo configurations', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const plan = api.tcAvitoDirectTitlePlan_([
    { category:'макбуки', title:'MacBook Neo M4 8/256GB Silver', price:65200 },
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Silver', price:131800 }
  ], 'макбуки', layout, [
    ['MacBook Neo M4 8/256 Silver', ''],
    ['MacBook Air 13 M5 16/1024 GB Silver', '']
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:65200 }, { row:1, price:131800 }]);
});

test('uses strict MacBook identity despite Avito title formatting', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const plan = api.tcAvitoDirectTitlePlan_([
    { category:'макбуки', title:'MacBook Neo M4 8/256GB Indigo', price:65200 },
    { category:'макбуки', title:'MacBook Air 15 M5 24GB 1TB Midnight', price:186300 },
    { category:'макбуки', title:'MacBook Pro 14 M5 16/1TB Black', price:177800 },
    { category:'макбуки', title:'MacBook Pro 14 M5 16/512GB Black', price:173800 }
  ], 'макбуки', layout, [
    ['MacBook Neo M4 (2025) 8/256 Silver', ''],
    ['MacBook Air 15 (2025) M5 24/1024 GB Starlight', ''],
    ['MacBook Pro 14 M5 16/1024 GB Silver', '']
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:65200 }, { row:1, price:186300 }, { row:2, price:177800 }]);
});

test('uses lowest ordinary MacBook price even when a literal colour title exists', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const plan = api.tcAvitoDirectTitlePlan_([
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Silver', price:131800 },
    { category:'макбуки', title:'MacBook Air 13 M5 16/1TB Sky Blue мятая коробка', price:130800 },
    { category:'макбуки', title:'MacBook Pro 14 M5 24/1TB Black', price:198800 },
    { category:'макбуки', title:'MacBook Pro 14 M5 24/1TB Silver', price:194800 }
  ], 'макбуки', layout, [
    ['MacBook Air 13 M5 16/1TB Sky Blue', ''],
    ['MacBook Pro 14 M5 24/1024 GB Black', '']
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:131800 }, { row:1, price:194800 }]);
});


test('prices MacBook Neo across Avito colours and rejects a damaged-box MacBook', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const rows = [
    ['MacBook 13 Neo (2026) 8/256 Blush', ''],
    ['MacBook Air 13 (2026, M5) 16/1024 Sky Blue', '130800']
  ];
  const plan = api.tcAvitoDirectTitlePlan_([
    { title:'MacBook Neo Air MHFD4 Neo Citrus 8/256GB', price:65300 },
    { title:'MacBook Air 13 Sky Blue M5 16/1TB (Мятая 📦)', price:130800 },
    { title:'MacBook Air 13 Starlight M5 16/1TB', price:131800 }
  ], 'макбуки', layout, rows);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:65300 }, { row:1, price:131800 }]);
  assert.equal(plan.matched, 2);
});


test('uses Ulyanovsk relaxed fields only where the client made them irrelevant', () => {
  const phoneLayout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const phones = api.tcAvitoDirectPhonePlan_([
    { model:'iPhone 17 Pro Max', memory:'2 ТБ', color:'черный', sim:'2 SIM', ram:'', price:150000 }
  ], phoneLayout, [['iPhone 17 Pro Max', '2 ТБ', 'черный', 'SIM + eSIM', '', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(phones.updates)), [{ row:0, price:150000 }]);
  const titles = api.tcAvitoDirectTitlePlan_([
    { title:'iPad Air 13 M3 256GB Wi-Fi + LTE Blue', price:75000 },
    { title:'Apple Watch Ultra 3 Black', price:82000 }
  ], 'айпады', api.tcAvitoTitleLayout_(['Title', 'Price']), [['iPad Air 13 M3 256GB Wi-Fi Blue', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(titles.updates)), [{ row:0, price:75000 }]);
  const watch = api.tcAvitoDirectTitlePlan_([{ title:'Apple Watch Ultra 3 Black', price:82000 }], 'часы', api.tcAvitoTitleLayout_(['Title', 'Price']), [['Apple Watch Ultra 3 Black', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(watch.updates)), [{ row:0, price:82000 }]);
});


test('normalises phone TB memory and supplier Watch spelling in live Avito keys', () => {
  const phoneLayout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const phone = api.tcAvitoDirectPhonePlan_([{ model:'iPhone 17 Pro Max', memory:'2 ТБ', color:'серебристый', sim:'2 SIM', ram:'', price:176800 }], phoneLayout, [['iPhone 17 Pro Max', '2048 ГБ', 'серебристый', 'SIM + eSIM', '', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(phone.updates)), [{ row:0, price:176800 }]);
  const watch = api.tcAvitoDirectTitlePlan_([{ title:'Watch Ultra 3 (2025) 49mm Natural case Ocean Band Blue', price:64100 }], 'часы', api.tcAvitoTitleLayout_(['Title', 'Price']), [['Apple Watch Ultra 3 49mm Natural Ocean Band Blue', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(watch.updates)), [{ row:0, price:64100 }]);
});

test('applies all Ulyanovsk optional-field matching rules', () => {
  const phoneLayout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const android = api.tcAvitoDirectPhonePlan_([
    { model:'Galaxy S25', memory:'256 ГБ', color:'синий', sim:'eSIM', ram:'8 ГБ', price:40000 },
    { model:'Galaxy S25', memory:'256 ГБ', color:'черный', sim:'2 SIM', ram:'', price:42000 },
    { model:'Galaxy S25', memory:'256 ГБ', color:'белый', sim:'SIM + eSIM', ram:'12 ГБ', price:45000 }
  ], phoneLayout, [['Galaxy S25', '256 ГБ', 'черный', '2 SIM', '12 ГБ', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(android.updates)), [{ row:0, price:42000 }]);

  const titleLayout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const ipad = api.tcAvitoDirectTitlePlan_([
    { title:'iPad Air 11 M3 256GB Wi-Fi Blue', price:75000 },
    { title:'iPad Air 11 M3 256GB Wi-Fi + LTE Black', price:72000 }
  ], 'айпады', titleLayout, [['iPad Air 11 M3 256GB Wi-Fi Black', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ipad.updates)), [{ row:0, price:72000 }]);

  const watch = api.tcAvitoDirectTitlePlan_([
    { title:'Apple Watch Series 10 41mm Black', price:29000 },
    { title:'Apple Watch Series 10 45mm Silver', price:31000 }
  ], 'часы', titleLayout, [['Apple Watch Series 10 45mm Silver', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(watch.updates)), [{ row:0, price:31000 }]);

  const controller = api.tcAvitoDirectTitlePlan_([
    { title:'DualSense Black', price:6400 },
    { title:'DualSense Edge Black', price:17100 },
    { title:'DualSense White', price:6200 },
    { title:'PS5 Slim Digital 1TB', price:62000 }
  ], 'пс', titleLayout, [['DualSense Edge White', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.updates)), [{ row:0, price:6200 }]);
});

test('matches only the approved AirPods Max 2 2026 title variant', () => {
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const plan = api.tcAvitoDirectTitlePlan_([
    { title:'AirPods Max 2 2026 Midnight', price:48000 },
    { title:'AirPods Max 2024 Midnight', price:39000 },
    { title:'AirPods 4 ANC', price:15000 }
  ], 'наушники', layout, [['AirPods Max 2026 Midnight', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:48000 }]);
});

test('uses filled iPhone colour and Apple Watch case and band characteristics exactly', () => {
  const phoneLayout = api.tcAvitoLayout_(['Model', 'MemorySize', 'Color', 'SimConfig', 'RamSize', 'Price']);
  const iphone = api.tcAvitoDirectPhonePlan_([
    { model:'iPhone 14', memory:'512 ГБ', color:'черный', sim:'eSIM', ram:'', price:56300 },
    { model:'iPhone 14', memory:'512 ГБ', color:'фиолетовый', sim:'2 SIM', ram:'', price:56800 }
  ], phoneLayout, [['iPhone 14', '512 GB', 'фиолетовый', 'eSIM', '', 56300]]);
  assert.deepEqual(JSON.parse(JSON.stringify(iphone.updates)), [{ row:0, price:56800 }]);
  const absent = api.tcAvitoDirectPhonePlan_([{ model:'iPhone 17 Pro', memory:'1 ТБ', color:'оранжевый', sim:'eSIM', ram:'', price:100000 }], phoneLayout, [['iPhone 17 Pro', '1 TB', 'серебристый', 'eSIM', '', 99000]]);
  assert.deepEqual(JSON.parse(JSON.stringify(absent.updates)), [{ row:0, price:'' }]);

  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const se = api.tcAvitoDirectTitlePlan_([
    { title:'Apple Watch SE 3 2025 40mm Black', price:22600 },
    { title:'Apple Watch SE 3 2025 40mm Starlight', price:24300 }
  ], 'часы', layout, [['Apple Watch SE 3 (2025) 40mm Starlight', 22600]]);
  assert.deepEqual(JSON.parse(JSON.stringify(se.updates)), [{ row:0, price:24300 }]);
  const ultra = api.tcAvitoDirectTitlePlan_([
    { title:'Apple Watch Ultra 3 49mm Black Ocean Band Black', price:61300 },
    { title:'Apple Watch Ultra 3 49mm Natural Ocean Band Blue', price:64100 }
  ], 'часы', layout, [['Apple Watch Ultra 3 49mm Natural Ocean Band Blue', 61300]]);
  assert.deepEqual(JSON.parse(JSON.stringify(ultra.updates)), [{ row:0, price:64100 }]);
});

test('keeps Galaxy Z Flip distinct from Fold and applies its explicit Fold-level markup', () => {
  const rules = api.tcParseMarkupCsv_('Модель,Наценка\nS - серии / z-Fold,5000\nA - серия,2000');
  const flip = { name:'Galaxy Z Flip8 12/256GB Jetblack', price:71300 };
  assert.equal(api.tcModel_(flip.name), 'Galaxy Z Flip8');
  assert.equal(api.tcModel_('Galaxy Z Fold8 12/256GB Lavender'), 'Galaxy Z Fold8');
  assert.equal(api.tcMarkupAmount_(flip, rules), 5000);
  assert.equal(api.tcColor_(flip.name), 'черный');
  assert.equal(api.tcColor_('Galaxy S25 12/128GB Icyblue'), 'голубой');
  assert.equal(api.tcIsAsis_('Galaxy S25 12/256GB (мятая коробка)'), true);
});

test('uses Android colour groups and retains technical model modifiers', () => {
  assert.equal(api.tcColorGroup_('Graphite'), 'black');
  assert.equal(api.tcColorGroup_('Icyblue'), 'blue');
  assert.equal(api.tcColorGroup_('Lilac'), 'violet');
  assert.equal(api.tcColorGroup_('Silver'), 'white');
  assert.equal(api.tcColorGroup_('Violet Shadow'), 'violet');
  assert.equal(api.tcModel_('Galaxy S26 Plus 12/256GB 5G Sky Blue'), 'Galaxy S26 Plus 5G');
  assert.equal(api.tcModel_('Galaxy A27 8/256GB (NFC) 4G Black'), 'Galaxy A27 4G NFC');
  assert.equal(api.tcModel_('Galaxy Z Flip8 12/256GB LTE Cream'), 'Galaxy Z Flip8 LTE');
});

test('does not split Android supplier candidates by SIM configuration', () => {
  const selected = api.tcChooseCheapestCountry_([
    { category:'телефоны', name:'Galaxy S26 12/256GB 2 SIM Sky Blue', price:61800 },
    { category:'телефоны', name:'Galaxy S26 12/256GB SIM + eSIM Icyblue', price:60300 }
  ]);
  assert.equal(selected.rows.length, 1);
  assert.equal(selected.rows[0].price, 60300);
});

test('keeps Titanium Silverblue blue and uses one minimum for an empty Android colour', () => {
  assert.equal(api.tcColor_('Galaxy S25 Ultra Titanium Silverblue'), 'голубой');
  assert.equal(api.tcColorGroup_(api.tcColor_('Galaxy S25 Ultra Titanium Silverblue')), 'blue');
  assert.equal(api.tcModel_('Huawei Pura 90S Pro 12/256GB Guava Soda'), 'Huawei Pura 90S Pro');
  const selected = api.tcChooseCheapestCountry_([
    { category:'телефоны', name:'Huawei Pura 90S Pro 12/256GB Guava Soda', price:51300 },
    { category:'телефоны', name:'Huawei Pura 90S Pro 12/256GB Orange Soda', price:51200 }
  ]);
  assert.equal(selected.rows.length, 1);
  assert.equal(selected.rows[0].price, 51200);
});

test('uses the 17 Pro 1TB markup and never crosses PS or Dyson model identities', () => {
  const rules = api.tcParseMarkupCsv_('Модель,Наценка\niPhone 13 - 17 Pro max 256,3000\niPhone 17 Pro 512/1тб - 17 Pro Max 512/1тб,4000\nPlayStation 5 Slim Disc 1TB,3000');
  assert.equal(api.tcMarkupAmount_({ name:'iPhone 17 Pro 1TB Black', price:100000 }, rules), 4000);
  assert.equal(api.tcMarkupAmount_({ name:'iPhone 17 Pro Max 1TB Black', price:100000 }, rules), 4000);
  assert.equal(api.tcMarkupAmount_({ name:'PlayStation 5 Slim Disk 1TB', price:66000 }, rules), 3000);
  const layout = api.tcAvitoTitleLayout_(['Title', 'Price']);
  const ps = api.tcAvitoDirectTitlePlan_([
    { category:'пс', title:'PlayStation 5 Slim Digital 825GB', price:59000 },
    { category:'пс', title:'DualSense Black', price:6400 },
    { category:'пс', title:'DualSense Charging Station copy Black', price:2200 }
  ], 'пс', layout, [['PlayStation 5 Slim 1TB', 59000], ['DualSense Black', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ps.updates)), [{ row:0, price:'' }, { row:1, price:6400 }]);
  const dyson = api.tcAvitoDirectTitlePlan_([
    { category:'дайсон', title:'Dyson HS08 Ceramic Pink', price:35000 }
  ], 'дайсон', layout, [['Dyson OnTrac CNC Copper', 2800]]);
  assert.deepEqual(JSON.parse(JSON.stringify(dyson.updates)), [{ row:0, price:'' }]);
});
