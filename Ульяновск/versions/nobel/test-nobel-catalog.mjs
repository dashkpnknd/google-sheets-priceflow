import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./PriceFlowNobelCatalog.gs', import.meta.url), 'utf8') + '\nglobalThis.Nobel = PriceFlowNobelCatalog;';
const context = { PriceFlowAvitoMatcher: {
  eligible: (value) => !/open box/i.test(value),
  phoneCandidates: (items, target) => items.filter((item) => item.model === target.model && item.memory === target.memory && item.color === target.color && item.sim === target.sim),
  titleMatches: (_category, target, value) => target === value
} };
vm.createContext(context); vm.runInContext(source, context);
const Nobel = context.Nobel;

const PHONE_HTML = `<div id="tree1"><div class="item__prop-name">Память</div><div data-treevalue="88_801"></div><div class="item__prop-name">Цвет</div><div data-treevalue="109_101"></div><div class="item__prop-name">Связь</div><div data-treevalue="99_1158"></div></div><script>new JCCatalogItem({'VISUAL':{'TREE_ID':'tree1'},'PRODUCT':{'NAME':'Apple iPhone 17 Pro','DETAIL_PAGE_URL':'/catalog/smartfony/apple/iphone-17-pro/'},'OFFERS':[{'NAME':'iPhone 17 Pro 256GB','TREE':{'PROP_88':'801','PROP_109':'101','PROP_99':'1158'},'ITEM_ALL_PRICES':{'1':{'CODE':'BASE','UNROUND_PRICE':'99990'},'6':{'CODE':'CARD','UNROUND_PRICE':'120000'}},'CAN_BUY':true}],'TREE_PROPS':[{'ID':'88','VALUES':{'801':{'NAME':'256 ГБ'}}},{'ID':'109','VALUES':{'101':{'NAME':'Deep Blue'}}},{'ID':'99','VALUES':{'1158':{'NAME':'SIM + eSIM'}}}]});</script>`;

test('reads BASE only and normalises a phone offer without eval', () => {
  const result = Nobel.parsePage('телефоны', PHONE_HTML, '2026-09-04T00:00:00.000Z');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 99990);
  assert.equal(result.items[0].color, 'синий');
  assert.equal(result.items[0].sim, 'SIM + eSIM');
});

test('rejects executable configuration and non-buyable/price-less offers', () => {
  assert.throws(() => Nobel.configurations('<script>new JCCatalogItem({x:window.location})</script>'), /Недопустимое/);
  const html = PHONE_HTML.replace("'CAN_BUY':true", "'CAN_BUY':false");
  assert.equal(Nobel.parsePage('телефоны', html, 't').items.length, 0);
});

test('keeps primary price even if Nobel is lower, otherwise marks fallback', () => {
  const layout = { model:0, memory:1, color:2, sim:3, ram:-1, price:4 };
  const rows = [['iPhone 17 Pro','256 ГБ','синий','SIM + eSIM',''], ['iPhone 17 Pro','512 ГБ','синий','SIM + eSIM','']];
  const primary = [{model:'iPhone 17 Pro',memory:'256 ГБ',color:'синий',sim:'SIM + eSIM',price:110000,search:'ok'}];
  const nobel = [{model:'iPhone 17 Pro',memory:'256 ГБ',color:'синий',sim:'SIM + eSIM',price:99990,search:'ok'}, {model:'iPhone 17 Pro',memory:'512 ГБ',color:'синий',sim:'SIM + eSIM',price:115000,search:'ok'}];
  const plan = Nobel.planRows('телефоны','phone',rows,layout,primary,nobel,{});
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [{row:0,price:110000},{row:1,price:115000}]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.origins)), ['primary','nobel']);
  assert.match(plan.diagnostics[1], /НОБЕЛЬ/);
});
