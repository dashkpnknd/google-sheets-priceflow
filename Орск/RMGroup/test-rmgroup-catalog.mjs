import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('./RMGroupCatalog.gs', import.meta.url), 'utf8') + '\nglobalThis.API={rmgItem_,rmgCategory_,rmgCountry_,rmgInfo_,rmgName_,rmgItems_};'; const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx); const api = ctx.API;
test('maps the documented RM Group pricelist item without markup', () => { const r = api.rmgItem_({brand:'Apple',category:'iPhone',subcategory:'iPhone 16 Pro Max',id:'P-99887799',name:'16 Pro Max 256 Black',country:'US',cost:100000}); assert.equal(r.category,'телефоны'); assert.equal(r.name,'iPhone 16 Pro Max 256 Black'); assert.equal(r.country,'США 🇺🇸'); assert.equal(r.price,100000); const i=api.rmgInfo_(r.name); assert.equal(i.memory,'256 ГБ'); assert.equal(i.color,'черный'); });
test('routes API categories and preserves unknown country code', () => { assert.equal(api.rmgCategory_('Apple MacBook'), 'макбуки'); assert.equal(api.rmgCategory_('Apple Watch'), 'часы'); assert.equal(api.rmgCategory_('Sony PlayStation'), 'пс'); assert.equal(api.rmgCategory_('GamePad PS5'), 'аксессуары'); assert.equal(api.rmgCountry_('XX'), 'XX'); assert.equal(api.rmgInfo_('iPhone 16 Pro 256 Desert Titanium').color, 'золотистый'); assert.equal(api.rmgInfo_('Galaxy S24 256 Lavender').color, 'фиолетовый'); });
test('rejects rows without a confirmed positive API cost', () => { assert.equal(api.rmgItem_({name:'iPhone 17',cost:0}), null); assert.equal(api.rmgItem_({name:'iPhone 17'}), null); });
test('accepts both current direct and legacy nested RM Group pricelist formats', () => {
  const item = {brand:'Apple',category:'iPhone',name:'17 256 Black',country:'US',cost:80000};
  assert.deepEqual([...api.rmgItems_([item])], [item]);
  assert.deepEqual([...api.rmgItems_([{items:[item]}])], [item]);
});
