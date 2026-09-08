import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const catalogue = fs.readFileSync(new URL('./TelegramCatalog.gs', import.meta.url), 'utf8');
const src = fs.readFileSync(new URL('./PriceFlowAvitoMatcher.gs', import.meta.url), 'utf8') + '\n' +
  fs.readFileSync(new URL('./PriceFlowTemplateMatcher.gs', import.meta.url), 'utf8') + '\n' + catalogue +
  '\nglobalThis.API={TC,krsParsePost_,krsCategory_,tcPhone_,tcIsAsis_,PriceFlowAvitoMatcher};';
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const api = ctx.API;

test('uses the four-file Ulyanovsk structure with the supplied second-stage workbook', () => {
  assert.equal(api.TC.priceTemplate.spreadsheetId, '1_QdZ0Z4zDKT7vmP-usVXY-yeZ6o6pUZXIALwlU6nSCI');
  assert.match(catalogue, /PriceFlowTemplateMatcher\.sync/);
  assert.match(catalogue, /tcSchedulePriceTemplateSync_/);
  assert.match(catalogue, /RUS_SNAPSHOT_SECRET/);
});

test('reads every post returned by the authorized snapshot without limiting to a category', () => {
  assert.match(catalogue, /payload\.posts\.forEach/);
  assert.match(catalogue, /rows\.push\(row\)/);
  const sourceRows = catalogue.match(/const sourceRows = tcFetchKrasnodarSnapshotRows_\(\)[\s\S]{0,500}/)[0];
  assert.doesNotMatch(sourceRows, /slice\(|filter\([^\n]*category/);
});

test('keeps the exact channel price and applies no Krasnodar markup or 2 SIM mirror', () => {
  const row = api.krsParsePost_('📱 iPhone 15\n🇮🇳15 Pro 128 ГБ Natural (1Sim+eSim) — 71 800 ₽', '1').rows[0];
  assert.equal(row.price, 71800);
  const stage = catalogue.match(/function syncTelegramCatalog_\(\)[\s\S]*?\n}\n\n\/\*\* Stage 2/)[0];
  assert.doesNotMatch(stage, /tcApplyUlyanovskMarkup_|tcAddTwoSimMirror_/);
});

test('parses every country variant as a separate first-stage row', () => {
  const rows = api.krsParsePost_('iPhone 17\n🇯🇵🇪🇺17 128 Black — 70 000', 'countries').rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => row.name), ['iPhone 17 128 Black 🇯🇵', 'iPhone 17 128 Black 🇪🇺']);
});

test('normalizes the real Samsung compact line into separate Android SKU fields', () => {
  const row = api.krsParsePost_('🤖 SAMSUNG •••••••\n🇦🇪S26 12/256 Black-63 990', '15').rows[0];
  assert.equal(row.category, 'телефоны');
  assert.deepEqual(JSON.parse(JSON.stringify(api.tcPhone_(row.name))), {
    model: 'Galaxy S26', memory: '256 ГБ', ram: '12 ГБ', color: 'черный', config: '', country: 'ОАЭ 🇦🇪', technical: ''
  });
});

test('routes Android families and PS accessories without dropping them from their intended tabs', () => {
  assert.equal(api.krsCategory_('Honor 400 8/256 Green'), 'телефоны');
  assert.equal(api.krsCategory_('Google Pixel 10 Pro 12/256 Blue'), 'телефоны');
  assert.equal(api.krsCategory_('Геймпад Sony DualSense PS5 Black'), 'пс');
  assert.equal(api.krsCategory_('Galaxy SmartTag2'), 'прочее');
});

test('does not turn volume prices or unconfirmed prices into products', () => {
  const parsed = api.krsParsePost_('iPhone 15 Pro\n15 Pro 128 ГБ Natural\n1 шт 71 800 ₽ · 3+ 71 700 ₽\n🇯🇵15 Pro 256 Pink — 80 000 ?', 'guard');
  assert.equal(parsed.rows.length, 0);
  assert.ok(parsed.skipped.length >= 1);
});

test('excludes every agreed special-condition item before it can enter either stage', () => {
  ['ASIS', 'CPO', 'Open Box', 'б/у', 'предактив', 'уценка', 'витрина', 'распаковка', 'брак', 'повреждённая коробка'].forEach(function(marker) {
    assert.equal(api.tcIsAsis_('iPhone 17 256 Black ' + marker), true, marker);
  });
});

test('uses the shared exact-SKU regression suite before writing', () => {
  assert.doesNotThrow(() => api.PriceFlowAvitoMatcher.runRegressionTests());
});
