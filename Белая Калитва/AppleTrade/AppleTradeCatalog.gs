/** Белая Калитва / AppleTrade — raw supplier catalog, no margin rules here. */
const BK = {
  endpoint: 'https://api.pricemasterapp.ru/belaya-kalitva/catalog',
  secret: '3e58984d71cf9847b67abd21d559126b38167a4e6c993d9ab4e710507a412e90',
  maxCatalogAgeMinutes: 30,
  tabs: ['телефоны', 'аксессуары', 'макбуки', 'аймак', 'айпады', 'камеры', 'часы', 'наушники', 'пс', 'дайсон'],
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AppleTrade')
    .addItem('Открыть каталог', 'bkShowSidebar')
    .addItem('Пересобрать каталог', 'bkInstallAndRefresh')
    .addItem('Включить автообновление 15 мин', 'bkInstallAndRefresh')
    .addToUi();
}
function bkShowSidebar() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('AppleTradeCatalogSidebar').setTitle('Каталог AppleTrade')); }

function bkRefreshCatalog() {
  const response = UrlFetchApp.fetch(BK.endpoint, {headers: {'X-PriceFlow-Secret': BK.secret}, muteHttpExceptions: true});
  if (response.getResponseCode() !== 200) throw new Error('Каталог поставщиков недоступен: HTTP ' + response.getResponseCode());
  const payload = JSON.parse(response.getContentText());
  if (!payload || !payload.categories || !payload.refreshedAt) throw new Error('Неверный формат каталога.');
  const refreshed = new Date(payload.refreshedAt);
  if (isNaN(refreshed.getTime()) || Date.now() - refreshed.getTime() > BK.maxCatalogAgeMinutes * 60 * 1000) throw new Error('Каталог поставщиков устарел; старые цены не записаны.');
  const book = SpreadsheetApp.getActive();
  BK.tabs.forEach(name => {
    const sheet = book.getSheetByName(name); if (!sheet) throw new Error('Нет обязательной вкладки: ' + name);
    bkValidateSheet_(sheet, name);
    const rows = payload.categories[name] || [];
    if (name === 'телефоны') bkWritePhones_(sheet, rows); else bkWriteTitlePrice_(sheet, rows);
  });
  PropertiesService.getScriptProperties().setProperty('BK_LAST_REFRESH', JSON.stringify({
    at: new Date().toISOString(), catalogRefreshedAt: payload.refreshedAt,
    total: Number(payload.total || 0), sources: payload.sources || []
  }));
  book.toast('Загружено позиций: ' + payload.total + '. Источники: ' + payload.sources.join(', '), 'AppleTrade', 8);
  return { total: Number(payload.total || 0), sources: payload.sources || [], catalogRefreshedAt: payload.refreshedAt };
}

function bkGetSetup() {
  const p = PropertiesService.getScriptProperties();
  const hasTrigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'bkRefreshCatalog');
  let last = null;
  try { last = JSON.parse(p.getProperty('BK_LAST_REFRESH') || 'null'); } catch (error) { last = null; }
  return { hasTrigger: hasTrigger, last: last };
}

function bkInstallAndRefresh() {
  bkInstallTrigger();
  return bkRefreshCatalog();
}

function bkValidateSheet_(sheet, name) {
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), name === 'телефоны' ? 12 : 2)).getValues()[0]
    .map(value => String(value || '').trim().toLowerCase().replace(/\s+/g, ''));
  const expected = name === 'телефоны'
    ? ['model', 'simconfig', 'memorysize', 'color', 'price', '', 'model', 'simconfig', 'memorysize', 'color', 'ramsize', 'price']
    : ['title', 'price'];
  if (expected.some((value, index) => headers[index] !== value)) {
    throw new Error('Неверная шапка вкладки «' + name + '». Каталог не очищен.');
  }
}

function bkWriteTitlePrice_(sheet, rows) {
  const last = Math.max(sheet.getLastRow(), 2); sheet.getRange(2, 1, last - 1, Math.max(sheet.getLastColumn(), 2)).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows.map(r => [r.title, Number(r.price)]));
}

function bkWritePhones_(sheet, rows) {
  const last = Math.max(sheet.getLastRow(), 2); sheet.getRange(2, 1, last - 1, Math.max(sheet.getLastColumn(), 12)).clearContent();
  const apple = [], android = [];
  rows.forEach(r => {
    const parsed = bkPhone_(r.title);
    // SIM is a material iPhone attribute for every downstream channel.  The
    // source can contain old menu rows without a SIM label; do not invent
    // "Не знаю" and make such an offer look like either eSIM or SIM+eSIM.
    // It remains absent until Top re:sale confirms the exact SIM version.
    if (parsed.apple && parsed.sim === 'Не знаю') return;
    (parsed.apple ? apple : android).push(bkPhoneValues_(parsed, Number(r.price)));
  });
  if (apple.length) sheet.getRange(2, 1, apple.length, 5).setValues(apple);
  if (android.length) sheet.getRange(2, 7, android.length, 6).setValues(android);
}

function bkPhoneRow_(title, price) {
  const parsed = bkPhone_(title);
  return bkPhoneValues_(parsed, price);
}
function bkPhoneValues_(parsed, price) { return parsed.apple ? [parsed.model, parsed.sim, parsed.memory, parsed.color, price] : [parsed.model, parsed.sim, parsed.memory, parsed.color, parsed.ram, price]; }

/**
 * Supplier-catalog parser only. It preserves a status such as `(Asis+)` or
 * `(Asis запак)`, accepts iPhone Air, and never guesses a missing technical
 * characteristic. It is not Avito matching or a markup rule.
 */
function bkPhone_(value) {
  const source = String(value || '').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ').replace(/\s+/g, ' ').trim();
  const conditionMatch = source.match(/\(\s*(asis\b[^)]*)\)/i);
  const condition = conditionMatch ? '(' + conditionMatch[1].trim().replace(/^a/i, 'A') + ') ' : '';
  const text = source.replace(/\(\s*asis\b[^)]*\)/ig, ' ').replace(/\s+/g, ' ').trim();
  const specs = text.match(/\b(\d{1,2})\s*\/\s*(64|128|256|512|1024|2048|1|2)\s*(гб|gb|тб|tb)?\b/i);
  const memoryMatch = specs ? null : text.match(/\b(1|2|64|128|256|512|1024|2048)\s*(гб|gb|тб|tb)\b/i);
  const unit = (number, suffix) => String(number) + ' ' + String(suffix || 'GB').toUpperCase().replace('GB', 'ГБ').replace('TB', 'ТБ');
  const memory = specs ? unit(specs[2], specs[3]) : memoryMatch ? unit(memoryMatch[1], memoryMatch[2]) : '';
  const ram = specs ? unit(specs[1], 'GB') : '';
  const sim = /\b(?:2\s*(?:sim|сим)|dual\s*-?\s*sim)\b/i.test(text) ? '2 SIM' : /(?:1\s*)?sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : 'Не знаю';
  const colors = /\b(black|white|blue|green|pink|purple|yellow|silver|gray|grey|gold|orange|red|sage|teal|ultramarine|natural|desert|lavander|lavender|cloud\s+white|sky\s+blue|черный|белый|синий|голубой|зеленый|розовый|фиолетовый|желтый|серебристый|серый|золотистый)\b/i;
  const color = (text.match(colors) || [''])[0];
  const apple = /\biphone\b/i.test(text);
  const appleModel = text.match(/\biPhone\s+(?:Air|\d+(?:e)?(?:\s+(?:Pro\s+Max|Pro|Plus|Mini|Air))?)\b/i);
  const androidModel = text.match(/\b(?:(?:Samsung\s+)?Galaxy\s+(?:S|A|Z|M)\d+(?:\s+(?:Ultra|FE|Plus))?|(?:Samsung|Xiaomi|Redmi|Poco|Honor|Huawei|OnePlus|Realme|Oppo|Vivo|Asus)\s+[A-Za-z0-9][A-Za-z0-9+\-]*(?:\s+(?:Pro|Ultra|Plus|FE|Lite|Max|Note))?)/i);
  // A source may use an unfamiliar Android model name. Keep it verbatim
  // rather than drop the actual supplier item.
  const model = condition + (apple ? (appleModel ? appleModel[0] : text) : (androidModel ? androidModel[0] : text));
  return { apple:apple, model:model.replace(/\s+/g, ' ').trim(), sim:sim, memory:memory, color:color, ram:ram };
}

function bkInstallTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'bkRefreshCatalog').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('bkRefreshCatalog').timeBased().everyMinutes(15).create();
}
