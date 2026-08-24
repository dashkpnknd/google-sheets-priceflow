import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('./RMGroupCatalog.gs', import.meta.url), 'utf8') + '\nglobalThis.API={rmgItem_,rmgCategory_,rmgCountry_,rmgInfo_,rmgName_,rmgItems_,rmgLayouts_,rmgRow_,rmgLayout_};'; const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx); const api = ctx.API;
test('maps the documented RM Group pricelist item without markup', () => { const r = api.rmgItem_({brand:'Apple',category:'iPhone',subcategory:'iPhone 16 Pro Max',id:'P-99887799',name:'16 Pro Max 256 Black',country:'US',cost:100000}); assert.equal(r.category,'телефоны'); assert.equal(r.name,'iPhone 16 Pro Max 256 Black'); assert.equal(r.country,'США 🇺🇸'); assert.equal(r.price,100000); const i=api.rmgInfo_(r.name); assert.equal(i.memory,'256 ГБ'); assert.equal(i.color,'черный'); });
test('keeps supported API categories and skips unsupported accessory families', () => { assert.equal(api.rmgCategory_('Apple MacBook'), 'макбуки'); assert.equal(api.rmgCategory_('Apple Watch'), 'часы'); assert.equal(api.rmgCategory_('Sony PlayStation'), 'пс'); assert.equal(api.rmgCategory_('GamePad PS5'), 'прочее'); assert.equal(api.rmgCountry_('XX'), 'XX'); assert.equal(api.rmgInfo_('iPhone 16 Pro 256 Desert Titanium').color, 'золотистый'); assert.equal(api.rmgInfo_('Galaxy S24 256 Lavender').color, 'фиолетовый'); assert.equal(api.rmgInfo_('iPhone 14 512 Red').color, 'красный'); });
test('skips cameras, speakers and accessory-only families', () => { assert.equal(api.rmgCategory_('DJI Osmo Pocket 4'), 'прочее'); assert.equal(api.rmgCategory_('Fujifilm Instax Mini 13'), 'прочее'); assert.equal(api.rmgCategory_('Яндекс Станция Макс'), 'прочее'); assert.equal(api.rmgCategory_('Ray-Ban Wayfarer'), 'прочее'); assert.equal(api.rmgCategory_('Medicube Booster Pro'), 'прочее'); });
test('rejects rows without a confirmed positive API cost', () => { assert.equal(api.rmgItem_({name:'iPhone 17',cost:0}), null); assert.equal(api.rmgItem_({name:'iPhone 17'}), null); });
test('accepts both current direct and legacy nested RM Group pricelist formats', () => {
  const item = {brand:'Apple',category:'iPhone',name:'17 256 Black',country:'US',cost:80000};
  assert.deepEqual([...api.rmgItems_([item])], [item]);
  assert.deepEqual([...api.rmgItems_([{items:[item]}])], [item]);
});
test('restores the Samsung model prefix and parses 1/2 TB memory', () => {
  const samsung = api.rmgItem_({brand:'Samsung',category:'Galaxy A',subcategory:'Galaxy A57',name:'A57 8/256 Gray',country:'EU',cost:25000});
  assert.equal(samsung.name, 'Galaxy A57 8/256 Gray');
  assert.equal(api.rmgInfo_(samsung.name).model, 'Galaxy A57');
  assert.equal(api.rmgInfo_('iPhone 17 Pro Max 2TB Blue').memory, '2 ТБ');
  assert.equal(api.rmgInfo_('iPhone 17 Pro 1TB Silver').memory, '1 ТБ');
});
test('writes an iMac to the simple Title/Price header', () => {
  const layout = api.rmgLayouts_(['Title','Price'])[0];
  assert.deepEqual([...api.rmgRow_(layout, {name:'iMac M4 16/512 Blue',country:'США 🇺🇸',price:120000})], ['iMac M4 16/512 Blue',120000]);
});
test('keeps a status iPhone in the Apple block and prefixes iMac titles', () => {
  assert.equal(api.rmgName_({category:'iPhone',name:'(Active) 17 256 Black'}), '(Active) iPhone 17 256 Black');
  assert.equal(api.rmgName_({category:'iMac',name:'MD2Q4 - 24/512 Green'}), 'iMac MD2Q4 - 24/512 Green');
  const layouts = api.rmgLayouts_(['Model','Price','','Model','Price']);
  assert.equal(api.rmgLayout_(layouts, {category:'телефоны',name:'(Active) iPhone 17 256 Black'}), 0);
});
