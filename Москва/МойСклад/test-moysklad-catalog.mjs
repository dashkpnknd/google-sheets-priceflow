import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./MoySkladCatalog.gs', import.meta.url), 'utf8') + `\nglobalThis.API={mscPrice_,mscCategory_,mscItem_,mscLayouts_,mscRow_,mscPhone_,mscColor_,mscSummary_,mscProductSort_,mscCharacteristicsText_,mscPlausiblePrice_,mscLayout_,mscIsIphoneHandset_};`;
const context = { console }; vm.createContext(context); vm.runInContext(source, context); const api = context.API;

test('maps all supported product types to the standard client tabs', () => {
  assert.equal(api.mscCategory_('iPhone 17 Pro'), 'телефоны');
  assert.equal(api.mscCategory_('Galaxy S24 Ultra'), 'телефоны');
  assert.equal(api.mscCategory_('iPad Air'), 'айпады');
  assert.equal(api.mscCategory_('MacBook Air'), 'макбуки');
  assert.equal(api.mscCategory_('Apple Watch'), 'часы');
  assert.equal(api.mscCategory_('AirPods Pro'), 'наушники');
  assert.equal(api.mscCategory_('PlayStation 5 Slim'), 'пс');
  assert.equal(api.mscCategory_('Dyson HD16'), 'дайсон');
  assert.equal(api.mscCategory_('iMac M4'), 'аймаки');
});
test('converts MoySklad kopecks to rubles and keeps a blank missing price blank', () => {
  assert.equal(api.mscPrice_([{value:10299000}]), 102990);
  assert.equal(api.mscPrice_([]), '');
});
test('uses product and variant data without relying on an existing sheet row', () => {
  const item = api.mscItem_({name:'256GB Blue SIM + eSIM', article:'A-1', salePrices:[{value:10299000}], product:{name:'iPhone 17 Pro'}});
  assert.equal(item.category, 'телефоны'); assert.equal(item.name, 'iPhone 17 Pro 256GB Blue SIM + eSIM'); assert.equal(item.price,102990);
});
test('includes MoySklad variant characteristics in the parsable product text', () => {
  const item = api.mscItem_({name:'iPhone 14', salePrices:[{value:5700000}], characteristics:[{name:'Память',value:'512 GB'},{name:'Цвет',value:'Blue'},{name:'Страна',value:'Japan'},{name:'SIM',value:'SIM + eSIM'}]});
  assert.match(item.name,/512 GB/); assert.match(item.name,/Blue/); assert.match(item.name,/Japan/);
  const info = api.mscPhone_(item.name);
  assert.deepEqual({...info}, {model:'iPhone 14',memory:'512 ГБ',ram:'',color:'синий',sim:'SIM + eSIM',country:'Япония'});
});
test('recognises colours regardless of punctuation, ё and a multi-word manufacturer colour', () => {
  assert.equal(api.mscColor_('iPhone 17 Pro — чёрный, 256GB'), 'черный');
  assert.equal(api.mscColor_('iPhone 16 Pro (Natural Titanium, eSIM)'), 'натуральный');
  assert.equal(api.mscColor_('Pixel 9 Pro [Obsidian] 12/256GB'), 'обсидиан');
  assert.equal(api.mscColor_('Galaxy S24: Lavender'), 'лавандовый');
});
test('creates rows for a standard phone header', () => {
  const layout = api.mscLayouts_(['Model','SimConfig','MemorySize','Color','Price'])[0];
  const row = api.mscRow_(layout,{name:'iPhone 17 Pro 256GB Blue SIM + eSIM',price:102990});
  assert.deepEqual([...row], ['iPhone 17 Pro','SIM + eSIM','256 ГБ','синий',102990]);
});
test('splits Android RAM and memory and keeps country in its own column', () => {
  const phone = api.mscPhone_('Pixel 7 8/128GB Lemongrass 🇺🇸');
  assert.deepEqual({...phone}, {model:'Pixel 7',memory:'128 ГБ',ram:'8 ГБ',color:'лимонный',sim:'',country:'США 🇺🇸'});
  const layout = api.mscLayouts_(['Model','SimConfig','Country','MemorySize','Color','RamSize','Price'])[0];
  assert.deepEqual([...api.mscRow_(layout,{name:'Pixel 7 8/128GB Lemongrass 🇺🇸',price:23500})], ['Pixel 7','','США 🇺🇸','128 ГБ','лимонный','8 ГБ',23500]);
});
test('sorts iPhones by generation rather than an old row order', () => {
  const products = [{name:'iPhone 17 Pro 256GB',price:100000},{name:'iPhone 13 128GB',price:40000},{name:'iPhone 16e 256GB',price:60000},{name:'iPhone 14 128GB',price:50000}];
  products.sort(api.mscProductSort_);
  assert.deepEqual(products.map(p=>api.mscPhone_(p.name).model),['iPhone 13','iPhone 14','iPhone 16e','iPhone 17 Pro']);
});
test('clears restrictive dropdowns and creates a Country column before writing', () => {
  assert.match(source, /target\.clearDataValidations\(\)/);
  assert.match(source, /function mscEnsureCountryColumns_\(sheet\)/);
});
test('routes accessories to phones and headphones to their own tab', () => {
  assert.equal(api.mscCategory_('Чехол для iPhone 17 Pro Max'), 'телефоны');
  assert.equal(api.mscCategory_('Защитное стекло Galaxy S24'), 'телефоны');
  assert.equal(api.mscCategory_('Проводные наушники Apple EarPods (Lightning)'), 'наушники');
  assert.equal(api.mscCategory_('Power Bank Baseus 10000mAh для iPhone'), 'телефоны');
  assert.equal(api.mscPlausiblePrice_('телефоны', 21), false);
  assert.equal(api.mscPlausiblePrice_('телефоны', 21000), true);
  const layouts = api.mscLayouts_(['Model','Price','','Model','Price']);
  assert.equal(api.mscLayout_(layouts,{category:'телефоны',name:'ASIS iPhone 17 Pro Max 256GB',price:100000}), 0);
  assert.equal(api.mscLayout_(layouts,{category:'телефоны',name:'Galaxy S24 8/256GB',price:50000}), 1);
  assert.equal(api.mscIsIphoneHandset_('Зарядка для iPhone 17 Pro'), false);
  const accessoryRow = api.mscRow_(api.mscLayouts_(['Model','Price'])[0], {name:'Чехол для iPhone 17 Pro Max Black',price:1743});
  assert.deepEqual([...accessoryRow], ['Чехол для iPhone 17 Pro Max Black',1743]);
});
test('keeps the unnumbered iPhone Air family in the Apple block', () => {
  const layouts = api.mscLayouts_(['Model','Price','','Model','Price']);
  const product = { category: 'телефоны', name: 'iPhone Air (Black, 1 TB, eSIM) Black 1 TB', price: 85800 };
  assert.equal(api.mscPhone_(product.name).model, 'iPhone Air');
  assert.equal(api.mscLayout_(layouts, product), 0);
});
test('creates rows for a simple Title/Price template and reports outcome', () => {
  const layout = api.mscLayouts_(['Title','Price'])[0];
  assert.deepEqual([...api.mscRow_(layout,{name:'Dyson HD16 Ceramic Pink',price:27890})],['Dyson HD16 Ceramic Pink',27890]);
  assert.match(api.mscSummary_({rows:50,written:48}),/50 позиций/);
});
test('uses the same two-button wiring as the working Telegram catalogue panel', () => {
  const html = fs.readFileSync(new URL('./MoySkladCatalogSidebar.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="setup">/);
  assert.match(html, /byId\('setup'\)\.addEventListener\('submit'/);
  assert.match(html, /saveMoySkladCatalogSetup\(\{project:byId\('project'\)\.value,token:byId\('token'\)\.value\}\)/);
  assert.match(html, /syncButton\.addEventListener\('click'/);
  assert.match(html, /runMoySkladCatalogNow\(\)/);
  assert.match(html, /getMoySkladCatalogSetup\(\)/);
});
