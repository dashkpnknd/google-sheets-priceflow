import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../PriceFlowAvitoMatcher.gs', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../../PriceFlowTemplateMatcher.gs', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('./TelegramCatalog.gs', import.meta.url), 'utf8') + `
globalThis.API={tcChannel_,tcCategory_,tcPhone_,tcColor_,tcColorGroup_,tcModel_,tcAndroidTechnicalModifiers_,tcIsAsis_,tcLayouts_,tcTargetRow_,tcParsePost_,tcLine_,tcExpand_,tcSummary_,tcProductSort_,tcAddTwoSimMirror_,tcChooseCheapestCountry_,tcParseMarkupCsv_,tcApplyUlyanovskMarkup_,tcMarkupAmount_,tcMarkupKey_,PriceFlowAvitoMatcher,PriceFlowTemplateMatcher};`;
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

test('shared matcher preserves Ulyanovsk title safety and only plans Price', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = matcher.titleLayout(['Title', 'Price', 'DateEnd']);
  const plan = matcher.planTitle([{ title:'MacBook Air 13 M5 16/512 Blue', price:120000 }], 'макбуки', layout, [['MacBook Air 15 M5 16/512 Blue', 90000, '2099-01-01']]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:'' }]);
  assert.equal(matcher.runRegressionTests().passed, 23);
});

test('shared matcher keeps iPad mini generations separate', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = matcher.titleLayout(['Title', 'Price']);
  const plan = matcher.planTitle([
    { title:'iPad Mini 6 256GB Wi-Fi Blue', price:41700 },
    { title:'iPad Mini 7 A17 256GB Wi-Fi Blue', price:56800 }
  ], 'айпады', layout, [['iPad 7 mini (2024), 256 ГБ Wi-Fi Blue', 41700]]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:56800 }]);
});

test('price-template matcher supports separate iPhone and Android blocks', () => {
  const layouts = api.PriceFlowTemplateMatcher.phoneLayouts([
    'Model', 'SimConfig', 'MemorySize', 'Color', 'Price', '', '', '',
    'Model', 'SimConfig', 'MemorySize', 'Color', 'RamSize', 'Price'
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(layouts)), [
    { model: 0, memory: 2, color: 3, sim: 1, ram: -1, price: 4, diagnostic: 5 },
    { model: 8, memory: 10, color: 11, sim: 9, ram: 12, price: 13, diagnostic: 14 }
  ]);
  assert.match(source, /const templateSync = tcSyncPriceTemplate_\(\);/);
  assert.match(source, /templateSpreadsheetId:TC\.priceTemplate\.spreadsheetId/);
  assert.match(source, /function runPriceTemplateSyncNow\(\)/);
  assert.match(source, /16zsIEQF1CqeQJWvskAChZQmZiRZj7NIxrzle_uKDM0I/);
  assert.doesNotMatch(source, /tcSyncAvitoPrices_|19GKgYl_RYR5Ezl6_L_bjIGkHmM2_vsWp5X1ZTV4rAF0/);
});

test('template phone matching preserves every explicit SKU field and reports its first failed field', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const sourceRows = [
    { model:'Galaxy S26 Plus', memory:'256 ГБ', color:'синий', sim:'SIM + eSIM', ram:'12 ГБ', price:71000, search:'Galaxy S26 Plus 12/256 Blue SIM + eSIM' },
    { model:'Galaxy S26 Plus', memory:'512 ГБ', color:'синий', sim:'SIM + eSIM', ram:'12 ГБ', price:75000, search:'Galaxy S26 Plus 12/512 Blue SIM + eSIM' }
  ];
  const plan = matcher.planPhone(sourceRows, layout, [
    ['Galaxy S26+', '2 SIM', '256 ГБ', 'синий', '12 ГБ', ''],
    ['Galaxy S26+', 'eSIM', '256 ГБ', 'синий', '12 ГБ', ''],
    ['Galaxy S26+', '2 SIM', '1 ТБ', 'синий', '12 ГБ', '']
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:71000 }]);
  assert.deepEqual([...plan.reasons], ['', 'Нет нужной SIM', 'Нет нужной памяти']);
});

test('approved iPhone 17 Air alias preserves memory and colour while unknown SIM does not restrict it', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  assert.notEqual(matcher.phoneModel('iPhone Air'), matcher.phoneModel('iPhone 17 Air'));
  assert.equal(matcher.phoneModel('iPhone Air', { allowIphoneAirAlias:true }), matcher.phoneModel('iPhone 17 Air', { allowIphoneAirAlias:true }));
  const layout = { model:0, sim:1, memory:2, color:3, ram:-1, price:4 };
  const plan = matcher.planPhone([
    { model:'iPhone 17 Air', memory:'256 ГБ', color:'белый', sim:'eSIM', price:80000, search:'iPhone 17 Air 256GB White eSIM' },
    { model:'iPhone 17 Air', memory:'256 ГБ', color:'белый', sim:'SIM + eSIM', price:82000, search:'iPhone 17 Air 256GB White SIM + eSIM' }
  ], layout, [['iPhone Air', 'Не знаю', '256 ГБ', 'белый', '']], { allowIphoneAirAlias:true });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:80000 }]);
});

test('excludes special conditions in every ready-catalogue field', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const plan = matcher.planPhone([{ model:'Galaxy S26', memory:'256 ГБ', color:'синий', sim:'SIM + eSIM', ram:'12 ГБ', price:1, search:'Galaxy S26 | Open Box' }], layout, [['Galaxy S26', '2 SIM', '256 ГБ', 'синий', '12 ГБ', '999']]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:'' }]);
  assert.deepEqual([...plan.reasons], ['Нет модели в общей таблице']);
  assert.equal(matcher.eligible('Galaxy S26 распакованный'), false);
  assert.equal(matcher.eligible('Galaxy S26 брак'), false);
});

test('uses the agreed PS5 Slim fallback and isolates ordinary PS5 and OnTrac', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const title = matcher.titleLayout(['Title', 'Price']);
  const ps = matcher.planTitle([
    { title:'PlayStation 5 Slim Digital 825 GB', price:60800, search:'PlayStation 5 Slim Digital 825 GB' },
    { title:'PlayStation 5 Slim Disc 1 TB', price:70100, search:'PlayStation 5 Slim Disc 1 TB' }
  ], 'пс', title, [['PlayStation 5 Slim', ''], ['PlayStation 5', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ps.updates)), [{ row:0, price:60800 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(ps.ambiguous)), [{ row:0, title:'PlayStation 5 Slim', prices:[60800,70100] }]);
  const ontrac = matcher.planTitle([{ title:'AirPods Pro 3', price:20000, search:'AirPods Pro 3' }], 'наушники', title, [['Dyson OnTrac', '12000']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ontrac.updates)), [{ row:0, price:'' }]);
});

test('splits the mixed iPhone 17e / 17 supplier section into its actual per-row models', () => {
  const rows = api.tcParsePost_('iPhone 17e \\ 17\n17 256GB Black 🇮🇳 (SIM + eSIM) — 70 000 ₽\n17e 256GB Black 🇮🇳 (eSIM) — 60 000 ₽', 'opt_uniseil', '100');
  assert.equal(rows.length, 2);
  assert.equal(api.tcPhone_(rows[0].name + ' ' + rows[0].variant).model, 'iPhone 17');
  assert.equal(api.tcPhone_(rows[1].name + ' ' + rows[1].variant).model, 'iPhone 17e');
  assert.equal(api.tcPhone_(rows[0].name + ' ' + rows[0].variant).config, 'SIM + eSIM');
});

test('fills 19 of 20 exact base iPhone 17 SKUs and leaves only 512GB violet eSIM blank', () => {
  const colors = [['Black', 'черный'], ['White', 'белый'], ['Blue', 'голубой'], ['Sage', 'зеленый'], ['Lavender', 'фиолетовый']];
  const physical = [], esim = [];
  colors.forEach(([sourceColor, targetColor]) => [256, 512].forEach((memory) => {
    physical.push(`17 ${memory}GB ${sourceColor} 🇮🇳 (SIM + eSIM) — ${70000 + physical.length * 100} ₽`);
    if (!(memory === 512 && sourceColor === 'Lavender')) esim.push(`17 ${memory}GB ${sourceColor} 🇯🇵 (eSIM) — ${68000 + esim.length * 100} ₽`);
  }));
  const parsed = api.tcParsePost_(['iPhone 17e \\ 17', ...physical, ...esim].join('\n'), 'opt_uniseil', '101');
  assert.equal(parsed.length, 19);
  const sourceRows = parsed.map((row) => {
    const phone = api.tcPhone_(row.name + ' ' + row.variant);
    return { model:phone.model, memory:phone.memory, color:phone.color, sim:phone.config, ram:phone.ram, price:row.price, search:row.name + ' ' + row.variant };
  });
  const targets = [];
  colors.forEach(([, color]) => [256, 512].forEach((memory) => {
    targets.push(['iPhone 17', 'SIM + eSIM', `${memory} ГБ`, color, '']);
    targets.push(['iPhone 17', 'Только eSIM', `${memory} ГБ`, color, '']);
  }));
  const plan = api.PriceFlowAvitoMatcher.planPhone(sourceRows, { model:0, sim:1, memory:2, color:3, ram:-1, price:4 }, targets);
  assert.equal(plan.updates.filter((update) => update.price !== '').length, 19);
  const missing = targets.findIndex((row) => row[1] === 'Только eSIM' && row[2] === '512 ГБ' && row[3] === 'фиолетовый');
  assert.equal(plan.reasons[missing], 'Нет нужной SIM');
  assert.equal(plan.updates.some((update) => update.row === missing && update.price !== ''), false);
});

test('splits iPhone 16e / 16 and fills only the eight audited iPhone 16 colours', () => {
  const parsed = api.tcParsePost_([
    'iPhone 16e \\ 16',
    '16 128GB White 🇮🇳 (Sim + E-Sim) — 60 300 ₽',
    '16 128GB Black 🇮🇳 (Sim + E-Sim) — 61 000 ₽',
    '16 128GB Pink 🇮🇳 (Sim + E-Sim) — 61 900 ₽',
    '16 128GB Teal 🇮🇳 (Sim + E-Sim) — 59 900 ₽',
    '16 128GB Ultramarine 🇺🇸 (E-Sim) — 59 700 ₽',
    '16 256GB Black 🇮🇳 (Sim + E-Sim) — 66 100 ₽',
    '16 256GB Teal 🇮🇳 (Sim + E-Sim) — 65 600 ₽',
    '16 512GB Pink 🇦🇺 (Sim + E-Sim) — 87 700 ₽',
    '16 512GB Ultramarine 🇦🇺 (Sim + E-Sim) — 85 000 ₽',
    '16e 128GB Black 🇺🇸 (E-Sim) — 44 900 ₽'
  ].join('\n'), 'opt_uniseil', '102');
  assert.equal(api.tcPhone_(parsed[0].name + ' ' + parsed[0].variant).model, 'iPhone 16');
  assert.equal(api.tcPhone_(parsed.at(-1).name + ' ' + parsed.at(-1).variant).model, 'iPhone 16e');
  const sourceRows = parsed.map((row) => { const phone = api.tcPhone_(row.name + ' ' + row.variant); return { model:phone.model, memory:phone.memory, color:phone.color, sim:phone.config, ram:phone.ram, price:row.price, search:row.name + ' ' + row.variant }; });
  const targets = [
    ['128 ГБ', 'белый'], ['128 ГБ', 'голубой'], ['128 ГБ', 'розовый'], ['128 ГБ', 'черный'],
    ['256 ГБ', 'голубой'], ['256 ГБ', 'черный'], ['512 ГБ', 'голубой'], ['512 ГБ', 'розовый'],
    ['128 ГБ', 'зеленый']
  ].map(([memory, color]) => ['iPhone 16', 'Не знаю', memory, color, '']);
  const plan = api.PriceFlowAvitoMatcher.planPhone(sourceRows, { model:0, sim:1, memory:2, color:3, ram:-1, price:4 }, targets);
  assert.equal(plan.updates.filter((update) => update.price !== '').length, 8);
  assert.equal(plan.reasons[8], 'Нет нужного цвета');
});

test('distinguishes an absent ready-catalogue model from a first-stage transmission failure', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const target = [['iPhone 17', 'SIM + eSIM', '256 ГБ', 'черный', '', '']];
  assert.deepEqual([...matcher.planPhone([], layout, target, { supplierModels:['iphone 17'] }).reasons], ['Не передано из прайса поставщика']);
  assert.deepEqual([...matcher.planPhone([], layout, target, { supplierModels:[] }).reasons], ['Нет модели в общей таблице']);
});

test('filters activated and unpacked supplier rows before they can reach the ready catalogue', () => {
  assert.equal(api.tcIsAsis_('iPhone 17 256GB Active'), true);
  assert.equal(api.tcIsAsis_('iPhone 17 256GB распакованный'), true);
  assert.equal(api.tcIsAsis_('iPhone 17 256GB поврежденная упаковка'), true);
});

test('matches all 20 canonical MacBook RAM/SSD keys including 1024GB and 1TB spelling', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = matcher.titleLayout(['Title', 'Price']);
  const sources = [], targets = [];
  [8, 16, 24, 32, 36].forEach((ram) => [256, 512, 1024, 2048].forEach((ssd) => {
    sources.push({ title:`MacBook Air 13 M4 ${ram}/${ssd} Silver`, price:100000 + sources.length, search:`MacBook Air 13 M4 ${ram}/${ssd} Silver` });
    const targetSsd = ssd === 1024 ? '1 ТБ' : ssd === 2048 ? '2 ТБ' : `${ssd} ГБ`;
    targets.push([`MacBook Air 13 M4 ${ram} ГБ ${targetSsd} Silver`, '']);
  }));
  const plan = matcher.planTitle(sources, 'макбуки', layout, targets);
  assert.equal(plan.updates.length, 20);
  assert.equal(plan.matched, 20);
});

test('keeps explicit Android and MacBook colours as separate SKU fields', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const plan = matcher.planPhone([
    { model:'Galaxy S25', memory:'128 ГБ', ram:'8 ГБ', color:'голубой', sim:'Не знаю', price:70000, search:'Galaxy S25 Icyblue 8/128' },
    { model:'Galaxy S25', memory:'128 ГБ', ram:'8 ГБ', color:'синий', sim:'Не знаю', price:69000, search:'Galaxy S25 Navy 8/128' }
  ], layout, [['Galaxy S25','Не знаю','128 ГБ','голубой','8 ГБ','']], {});
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{ row:0, price:70000 }]);
  assert.equal(matcher.titleMatches('макбуки', 'MacBook Air 13 M5 16/1TB Sky Blue', 'MacBook Air 13 M5 16/1TB Silver'), false);
});

test('uses the agreed Android diagnostic order and preserves technical model boundaries', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const plan = matcher.planPhone([
    { model:'Galaxy Z Fold8', memory:'1024 ГБ', ram:'16 ГБ', color:'серый', sim:'Не знаю', price:170300, search:'Galaxy Z Fold8 16/1TB Graphite' }
  ], layout, [['Galaxy Z Fold8','Не знаю','1024 ГБ','зеленый','12 ГБ','']], {});
  assert.equal(plan.reasons[0], 'Нет нужной RAM');
  assert.equal(api.tcModel_('POCO X7 Pro 5G 8/256GB Black'), 'POCO X7 Pro');
  assert.equal(api.tcModel_('Pixel 10 Pro Fold 16/512GB'), 'Pixel 10 Pro Fold');
  assert.equal(api.tcIsAsis_('MacBook Air 13 M5 (Мятая 📦)'), true);
});

test('matches four iPad Air M4 colours, eight Watch Ultra 2 rows, and current AirPods', () => {
  const matcher = api.PriceFlowAvitoMatcher;
  const layout = matcher.titleLayout(['Title', 'Price']);
  const ipad = matcher.planTitle([{ title:'iPad Air 11 M4 256GB Wi-Fi Blue', price:65000, search:'iPad Air 11 M4 256GB Wi-Fi Blue' }], 'айпады', layout, ['Blue','Purple','Starlight','Space Gray'].map((color) => [`iPad Air 11 M4 256 ГБ Wi-Fi ${color}`, '']));
  assert.equal(ipad.matched, 4);
  const watch = matcher.planTitle([{ title:'Apple Watch Ultra 2 Black Ocean Band', price:70000, search:'Apple Watch Ultra 2 Black Ocean Band' }], 'часы', layout, Array.from({ length:8 }, (_, index) => [`Watch Ultra 2 strap ${index + 1}`, '']));
  assert.equal(watch.matched, 8);
  const headphones = matcher.planTitle([{ title:'AirPods Pro 2', price:20000, search:'AirPods Pro 2' }, { title:'AirPods 4', price:15000, search:'AirPods 4' }], 'наушники', layout, [['AirPods Pro 2', ''], ['AirPods 4', '']]);
  assert.equal(headphones.matched, 2);
});

test('parses MacBook Neo / Air rows by their own family and removes the article', () => {
  assert.equal(api.tcExpand_('MacBook Neo \\ Air', 'MDHJ4 Air 13 M5 16/1TB Blue'), 'MacBook Air 13 M5 16/1TB Blue');
  assert.equal(api.tcExpand_('MacBook Neo \\ Air', 'MHFD4 Neo 16/512 Silver'), 'MacBook Neo 16/512 Silver');
});

test('normalizes audited Android 1TB, RAM and model-specific colours without relaxing SKU fields', () => {
  const android = api.tcPhone_('Galaxy S26 Ultra 16/1TB Titanium Whitesilver');
  assert.deepEqual({ memory:android.memory, ram:android.ram, color:android.color }, { memory:'1024 ГБ', ram:'16 ГБ', color:'белый' });
  assert.equal(api.tcPhone_('Galaxy Z Fold8 12/256 Graphite').color, 'серый');
  assert.equal(api.tcPhone_('Galaxy A56 12/256 Awesome Olive').color, 'зеленый');
  assert.equal(api.tcPhone_('Pixel 10 12/256 Obsidian').color, 'черный');
  const matcher = api.PriceFlowAvitoMatcher, layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const source = [{ model:'Galaxy Z Fold8', memory:'1024 ГБ', color:'серый', sim:'', ram:'16 ГБ', price:100000, search:'Galaxy Z Fold8 16/1TB Graphite' }];
  const plan = matcher.planPhone(source, layout, [['Galaxy Z Fold8', 'Не знаю', '1024 ГБ', 'серый', '12 ГБ', '']]);
  assert.deepEqual([...plan.reasons], ['Нет нужной RAM']);
});

test('matches all 24 audited Android SKUs only on the complete normalized SKU', () => {
  const matcher = api.PriceFlowAvitoMatcher, layout = { model:0, sim:1, memory:2, color:3, ram:4, price:5 };
  const sku = [
    ['Galaxy S25 Ultra', '256 ГБ', 'черный', '12 ГБ'], ['Galaxy S25 Ultra', '256 ГБ', 'белый', '12 ГБ'], ['Galaxy S25 Ultra', '256 ГБ', 'серый', '12 ГБ'], ['Galaxy S25 Ultra', '1024 ГБ', 'черный', '12 ГБ'], ['Galaxy S25 Ultra', '1024 ГБ', 'фиолетовый', '12 ГБ'],
    ['Galaxy A56', '128 ГБ', 'зеленый', '8 ГБ'], ['Galaxy A56', '256 ГБ', 'зеленый', '12 ГБ'], ['Galaxy S26', '256 ГБ', 'черный', '12 ГБ'],
    ['Galaxy S26 Ultra', '1024 ГБ', 'черный', '16 ГБ'], ['Galaxy S26 Ultra', '1024 ГБ', 'фиолетовый', '16 ГБ'], ['Galaxy S26 Ultra', '1024 ГБ', 'голубой', '16 ГБ'], ['Galaxy S26 Ultra', '1024 ГБ', 'белый', '16 ГБ'],
    ['Galaxy Z Flip8', '256 ГБ', 'серый', '12 ГБ'], ['Galaxy Z Flip8', '512 ГБ', 'серый', '12 ГБ'],
    ['Galaxy Z Fold8', '256 ГБ', 'серый', '12 ГБ'], ['Galaxy Z Fold8', '512 ГБ', 'серый', '12 ГБ'], ['Galaxy Z Fold8', '1024 ГБ', 'бежевый', '16 ГБ'], ['Galaxy Z Fold8', '1024 ГБ', 'серый', '16 ГБ'], ['Galaxy Z Fold8', '1024 ГБ', 'фиолетовый', '16 ГБ'],
    ['Galaxy Z Fold8 Ultra', '256 ГБ', 'серый', '12 ГБ'], ['Galaxy Z Fold8 Ultra', '512 ГБ', 'серый', '12 ГБ'], ['Galaxy Z Fold8 Ultra', '1024 ГБ', 'бежевый', '16 ГБ'], ['Galaxy Z Fold8 Ultra', '1024 ГБ', 'фиолетовый', '16 ГБ'], ['Pixel 10', '256 ГБ', 'черный', '12 ГБ']
  ];
  const source = sku.map((item, index) => ({ model:item[0], memory:item[1], color:item[2], sim:'', ram:item[3], price:50000 + index, search:item.join(' ') }));
  const targets = sku.map((item) => [item[0], 'Не знаю', item[1], item[2], item[3], '']);
  const plan = matcher.planPhone(source, layout, targets);
  assert.equal(plan.matched, 24);
  assert.equal(plan.updates.length, 24);
  assert.equal(plan.missing.length, 0);
});

test('keeps AirPods 4 ANC separate and prices each AirPods Max 2026 colour independently', () => {
  const matcher = api.PriceFlowAvitoMatcher, layout = matcher.titleLayout(['Title', 'Price']);
  const airpods = matcher.planTitle([{ title:'AirPods 4', price:15000, search:'AirPods 4' }, { title:'AirPods 4 ANC', price:18000, search:'AirPods 4 ANC' }], 'наушники', layout, [['AirPods 4', ''], ['AirPods 4 ANC', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(airpods.updates)), [{ row:0, price:15000 }, { row:1, price:18000 }]);
  const max = matcher.planTitle([
    { title:'AirPods Max 2 2026 Type-C Blue', price:40100, search:'AirPods Max 2 2026 Blue' },
    { title:'AirPods Max 2 2026 Type-C Orange', price:38800, search:'AirPods Max 2 2026 Orange' },
    { title:'AirPods Max 2 2026 Type-C Purple', price:39800, search:'AirPods Max 2 2026 Purple' }
  ], 'наушники', layout, [['AirPods Max 2026 Blue', ''], ['AirPods Max 2026 Orange', ''], ['AirPods Max 2026 Purple', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(max.updates)), [{ row:0, price:40100 }, { row:1, price:38800 }, { row:2, price:39800 }]);
});
