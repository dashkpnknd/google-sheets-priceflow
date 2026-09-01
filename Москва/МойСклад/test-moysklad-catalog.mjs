import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./MoySkladCatalog.gs', import.meta.url), 'utf8') + `\nglobalThis.API={mscPrice_,mscCategory_,mscItem_,mscLayouts_,mscRow_,mscPhone_,mscColor_,mscSummary_,mscProductSort_,mscCharacteristicsText_,mscPlausiblePrice_,mscInStock_,mscLayout_,mscIsIphoneHandset_,mscDisplayModel_,mscHasMemory_,mscCleanName_};`;
const context = { console }; vm.createContext(context); vm.runInContext(source, context); const api = context.API;

test('maps all supported product types to the standard client tabs', () => {
  assert.equal(api.mscCategory_('iPhone 17 Pro'), 'телефоны');
  assert.equal(api.mscCategory_('Galaxy S24 Ultra 12/256 GB'), 'телефоны');
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
  const item = api.mscItem_({name:'256GB Blue SIM + eSIM', article:'A-1', salePrices:[{value:10299000}], stock:1, reserve:0, product:{name:'iPhone 17 Pro'}});
  assert.equal(item.category, 'телефоны'); assert.equal(item.name, 'iPhone 17 Pro 256GB Blue SIM + eSIM'); assert.equal(item.price,102990);
});
test('includes MoySklad variant characteristics in the parsable product text', () => {
  const item = api.mscItem_({name:'iPhone 14', salePrices:[{value:5700000}], stock:1, reserve:0, characteristics:[{name:'Память',value:'512 GB'},{name:'Цвет',value:'Blue'},{name:'Страна',value:'Japan'},{name:'SIM',value:'SIM + eSIM'}]});
  assert.match(item.name,/512 GB/); assert.match(item.name,/Blue/); assert.match(item.name,/Japan/);
  const info = api.mscPhone_(item.name);
  assert.deepEqual({...info}, {model:'iPhone 14',memory:'512 ГБ',ram:'',color:'голубой',sim:'SIM + eSIM',country:'Япония'});
});
test('recognises colours regardless of punctuation, ё and a multi-word manufacturer colour', () => {
  assert.equal(api.mscColor_('iPhone 17 Pro — чёрный, 256GB'), 'черный');
  assert.equal(api.mscColor_('iPhone 16 Pro (Natural Titanium, eSIM)'), 'серый');
  assert.equal(api.mscColor_('Pixel 9 Pro [Obsidian] 12/256GB'), 'черный');
  assert.equal(api.mscColor_('Galaxy S24: Lavender'), 'фиолетовый');
});
test('creates rows for a standard phone header', () => {
  const layout = api.mscLayouts_(['Model','SimConfig','MemorySize','Color','Price'])[0];
  const row = api.mscRow_(layout,{name:'iPhone 17 Pro 256GB Blue SIM + eSIM',price:102990});
  assert.deepEqual([...row], ['iPhone 17 Pro','SIM + eSIM','256 ГБ','синий',102990]);
});
test('splits Android RAM and memory without writing a country column', () => {
  const phone = api.mscPhone_('Pixel 7 8/128GB Lemongrass 🇺🇸');
  assert.deepEqual({...phone}, {model:'Pixel 7',memory:'128 ГБ',ram:'8 ГБ',color:'желтый',sim:'',country:'США 🇺🇸'});
  const layout = api.mscLayouts_(['Model','SimConfig','MemorySize','Color','RamSize','Price'])[0];
  assert.deepEqual([...api.mscRow_(layout,{name:'Pixel 7 8/128GB Lemongrass 🇺🇸',price:23500})], ['Pixel 7','Не знаю','128 ГБ','желтый','8 ГБ',23500]);
});
test('imports only currently available items and re-evaluates availability every run', () => {
  assert.equal(api.mscInStock_({stock:1, reserve:0}), true);
  assert.equal(api.mscInStock_({stock:1, reserve:1}), false);
  assert.equal(api.mscInStock_({stock:0, reserve:0}), false);
  assert.equal(api.mscItem_({name:'iPhone 17 256GB', salePrices:[{value:8000000}], stock:1, reserve:1}), null);
  assert.equal(api.mscItem_({name:'iPhone 17 256GB', salePrices:[{value:8000000}], stock:1, reserve:0}).category, 'телефоны');
});
test('sorts iPhones by generation rather than an old row order', () => {
  const products = [{name:'iPhone 17 Pro 256GB',price:100000},{name:'iPhone 13 128GB',price:40000},{name:'iPhone 16e 256GB',price:60000},{name:'iPhone 14 128GB',price:50000}];
  products.sort(api.mscProductSort_);
  assert.deepEqual(products.map(p=>api.mscPhone_(p.name).model),['iPhone 13','iPhone 14','iPhone 16e','iPhone 17 Pro']);
});
test('clears restrictive dropdowns and removes old country columns before writing', () => {
  assert.match(source, /target\.clearDataValidations\(\)/);
  assert.match(source, /function mscRemoveCountryColumns_\(sheet\)/);
});
test('writes all accessories to their dedicated sheet and keeps supported headphones', () => {
  assert.equal(api.mscCategory_('Чехол для iPhone 17 Pro Max'), 'аксессуары');
  assert.equal(api.mscCategory_('Защитное стекло Galaxy S24'), 'аксессуары');
  assert.equal(api.mscCategory_('Зарядное устройство USB-C 20W'), 'аксессуары');
  assert.equal(api.mscCategory_('Глазурь iPhone Новое голубая глазурь, матовая глазурь, box версия'), 'аксессуары');
  assert.equal(api.mscCategory_('Проводные наушники Apple EarPods (Lightning)'), 'наушники');
  assert.equal(api.mscCategory_('Power Bank Baseus 10000mAh для iPhone'), 'аксессуары');
  assert.equal(api.mscPlausiblePrice_('телефоны', 21), false);
  assert.equal(api.mscPlausiblePrice_('телефоны', 21000), true);
  assert.equal(api.mscPlausiblePrice_('аксессуары', 21), true);
  const layouts = api.mscLayouts_(['Model','Price','','Model','Price']);
  assert.equal(api.mscLayout_(layouts,{category:'телефоны',name:'ASIS iPhone 17 Pro Max 256GB',price:100000}), 0);
  assert.equal(api.mscLayout_(layouts,{category:'телефоны',name:'(Active) iPhone 17 256GB',price:100000}), 0);
  assert.equal(api.mscLayout_(layouts,{category:'телефоны',name:'Galaxy S24 8/256GB',price:50000}), 1);
  assert.equal(api.mscDisplayModel_('(Active) iPhone 17 256GB', 'iPhone 17'), '(Active) iPhone 17');
  assert.equal(api.mscIsIphoneHandset_('Зарядка для iPhone 17 Pro'), false);
  const accessoryRow = api.mscRow_(api.mscLayouts_(['Model','Price'])[0], {name:'Чехол для iPhone 17 Pro Max Black',price:1743});
  assert.deepEqual([...accessoryRow], ['Чехол для iPhone 17 Pro Max Black',1743]);
});
test('routes accessory cases and keeps Samsung wearables out of the Android phone block', () => {
  assert.equal(api.mscCategory_('Чехол для AirPods Pro 2'), 'аксессуары');
  assert.equal(api.mscCategory_('Чехол Case для Galaxy Buds 4'), 'аксессуары');
  assert.equal(api.mscCategory_('Портативная беспроводная колонка Samsung'), 'наушники');
  assert.equal(api.mscCategory_('Galaxy Buds 4'), 'наушники');
  assert.equal(api.mscCategory_('Galaxy Ring'), 'наушники');
  assert.equal(api.mscCategory_('Galaxy Watch 8'), 'часы');
  assert.equal(api.mscCategory_('Samsung Fit Band'), 'наушники');
  assert.equal(api.mscCategory_('Galaxy A36 8/256 GB'), 'телефоны');
  assert.equal(api.mscHasMemory_('Galaxy A36 8/256 GB'), true);
  assert.equal(api.mscCleanName_(' # Galaxy Buds 4'), 'Galaxy Buds 4');
  const item = api.mscItem_({name:'# Galaxy Buds 4', salePrices:[{value:1299000}], stock:1, reserve:0});
  assert.equal(item.name, 'Galaxy Buds 4');
  assert.equal(item.category, 'наушники');
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
