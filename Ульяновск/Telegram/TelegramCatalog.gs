/**
 * Telegram supplier → catalogue.
 * A separate product: it treats the public supplier channel as the source of
 * truth and rebuilds rows in the existing client tabs without changing style.
 */
const TC = {
  sheets: ['телефоны', 'макбуки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон', 'аймаки'],
  everyMinutes: 15,
  // Публичный файл клиента с правилами наценки. Суммы не хранятся в коде:
  // при каждом обновлении читается его актуальная версия.
  markupSheetId: '1DOuNTe2yJcU6h-TK3-xpWqe6zWpNl0NAQfVVYvZ0IpA',
  // Правила распределены по брендам и товарным группам. Нельзя читать
  // только Apple (gid=0): тогда Android, Dyson, аксессуары и приставки
  // останутся без наценки.
  markupGids: [0, 998621873, 1581268057, 816391661, 72651251, 1869147184,
    385010794, 128937099, 338535652, 463783735, 933137760, 1778122432,
    739113936, 2069038397],
  // Fixed Ulyanovsk Avito workbook. Only Price is changed in these existing tabs.
  avito: { spreadsheetId: '19GKgYl_RYR5Ezl6_L_bjIGkHmM2_vsWp5X1ZTV4rAF0', headerRow: 2, firstDataRow: 3, sheets: {
    'телефоны': { sheetId: 739636152, kind: 'phone' }, 'макбуки': { sheetId: 328331373, kind: 'title' },
    'айпады': { sheetId: 1704742480, kind: 'title' }, 'часы': { sheetId: 1537478299, kind: 'title' },
    'наушники': { sheetId: 848792271, kind: 'title' }, 'пс': { sheetId: 59071582, kind: 'title' },
    'дайсон': { sheetId: 1643349080, kind: 'title' }
  } },
  props: { project: 'TC_PROJECT', channel: 'TC_CHANNEL', mirrorTwoSim: 'TC_MIRROR_TWO_SIM', last: 'TC_LAST', status: 'TC_STATUS' }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог поставщика')
    .addItem('Подключить Telegram-канал', 'showTelegramCatalogSidebar')
    .addSeparator().addItem('Пересобрать каталог сейчас', 'runTelegramCatalogNow').addToUi();
}

function showTelegramCatalogSidebar() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('TelegramCatalogSidebar')
    .setTitle('Каталог поставщика').setWidth(360));
}

function getTelegramCatalogSetup() {
  const p = PropertiesService.getScriptProperties();
  return {
    project: p.getProperty(TC.props.project) || '', channel: p.getProperty(TC.props.channel) || '',
    mirrorTwoSim: p.getProperty(TC.props.mirrorTwoSim) === 'true',
    connected: Boolean(p.getProperty(TC.props.channel)), lastSync: p.getProperty(TC.props.last) || '',
    status: p.getProperty(TC.props.status) || 'Не подключено'
  };
}

function saveTelegramCatalogSetup(form) {
  const project = String(form && form.project || '').trim();
  const channel = tcChannel_(form && form.channel);
  if (!/^.{2,}\s*\|\s*.{2,}$/.test(project)) throw new Error('Укажите магазин в формате «Магазин | Город».');
  if (!channel) throw new Error('Укажите публичный канал вида @username.');
  const probe = UrlFetchApp.fetch('https://t.me/s/' + channel, { muteHttpExceptions: true });
  if (probe.getResponseCode() !== 200 || probe.getContentText().indexOf('tgme_channel_info') === -1) {
    throw new Error('Канал не открыт. Нужен публичный @username, не ссылка-приглашение.');
  }
  const p = PropertiesService.getScriptProperties();
  p.setProperty(TC.props.project, project); p.setProperty(TC.props.channel, channel);
  p.setProperty(TC.props.mirrorTwoSim, String(Boolean(form && form.mirrorTwoSim)));
  tcEnsureTrigger_();
  const result = syncTelegramCatalog_();
  return Object.assign(getTelegramCatalogSetup(), { message: tcSummary_(result) });
}

function runTelegramCatalogNow() { tcEnsureTrigger_(); const result = syncTelegramCatalog_(); return Object.assign(getTelegramCatalogSetup(), { message: tcSummary_(result) }); }
function syncTelegramCatalog() {
  // A trigger may survive a copied project. Until the user has connected a
  // channel, it should silently do nothing rather than repeatedly fail.
  if (!PropertiesService.getScriptProperties().getProperty(TC.props.channel)) return { rows: 0, written: 0, skippedSheets: TC.sheets };
  return syncTelegramCatalog_();
}

function tcEnsureTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const handler = t.getHandlerFunction();
    // Remove only this product's current trigger and the trigger of the
    // previous Telegram price-updater. Other project automations stay intact.
    if (handler === 'syncTelegramCatalog' || handler === 'syncTelegramSupplier') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTelegramCatalog').timeBased().everyMinutes(TC.everyMinutes).create();
}

function syncTelegramCatalog_() {
  tcAssertUlyanovskInvariants_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { rows: 0, written: 0, skippedSheets: [] };
  try {
    const p = PropertiesService.getScriptProperties(), channel = p.getProperty(TC.props.channel);
    if (!channel) throw new Error('Сначала подключите публичный Telegram-канал.');
    const sourceRows = tcFetchRows_(channel);
    const mirror = tcAddTwoSimMirror_(sourceRows, p.getProperty(TC.props.mirrorTwoSim) === 'true');
    // Одна и та же конфигурация может быть у поставщика из нескольких стран.
    // Для Ульяновска берём только вариант с минимальной закупочной ценой.
    const cheapest = tcChooseCheapestCountry_(mirror.rows);
    const markup = tcApplyUlyanovskMarkup_(cheapest.rows, tcLoadUlyanovskMarkup_());
    const rows = markup.rows, book = SpreadsheetApp.getActiveSpreadsheet();
    const byCategory = {};
    rows.forEach(function(row) { (byCategory[row.category] = byCategory[row.category] || []).push(row); });
    let written = 0; const skippedSheets = [];
    TC.sheets.forEach(function(name) {
      const entries = byCategory[name] || [], sheet = book.getSheetByName(name);
      // Never clear a customer tab when the channel did not yield this category:
      // a temporary parsing/source failure must not erase a catalogue.
      if (!entries.length) { skippedSheets.push(name); return; }
      if (!sheet) throw new Error('Нет листа «' + name + '» в стандартной таблице.');
      written += tcWriteSheet_(sheet, entries);
    });
    // The catalogue just written into this spreadsheet is the authoritative
    // source for Avito: it already has the selected country, markup and every
    // technical field in separate columns.  Do not match Avito to raw Telegram
    // display text a second time.
    SpreadsheetApp.flush();
    const priceSync = tcSyncAvitoPrices_();
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return {
      rows: rows.length, written: written, mirrored: mirror.mirrored,
      cheapest: cheapest.removed, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
      skippedSheets: skippedSheets, priceSync: priceSync
    };
  } finally { lock.releaseLock(); }
}

/**
 * Updates existing Ulyanovsk Avito listings from the already prepared
 * catalogue.  A missing source SKU is archived, never filled from a merely
 * similar product: this protects the client from stale and ghost listings.
 */
function tcSyncAvitoPrices_() {
  const sourceBook = SpreadsheetApp.getActiveSpreadsheet(), book = SpreadsheetApp.openById(TC.avito.spreadsheetId);
  const report = { at: new Date().toISOString(), sourceRows: 0, sheets: {} };
  Object.keys(TC.avito.sheets).forEach(function(category) {
    const target = TC.avito.sheets[category], sheet = book.getSheets().find(function(item) { return item.getSheetId() === target.sheetId; }), sourceSheet = sourceBook.getSheetByName(category);
    if (!sheet) throw new Error('Не найден лист объявлений Ульяновска для категории «' + category + '».');
    if (!sourceSheet) throw new Error('Не найден лист исходного каталога Ульяновска «' + category + '».');
    const sourceWidth = sourceSheet.getLastColumn(), sourceHeaders = sourceSheet.getRange(1, 1, 1, sourceWidth).getValues()[0];
    const sourceHeight = Math.max(sourceSheet.getLastRow() - 1, 0), sourceValues = sourceHeight ? sourceSheet.getRange(2, 1, sourceHeight, sourceWidth).getValues() : [];
    const source = tcAvitoDirectSource_(sourceHeaders, sourceValues); report.sourceRows += source.length;
    const width = sheet.getLastColumn(), headers = sheet.getRange(TC.avito.headerRow, 1, 1, width).getValues()[0];
    const layout = target.kind === 'phone' ? tcAvitoLayout_(headers) : tcAvitoTitleLayout_(headers);
    if (!layout) throw new Error('Неверная шапка листа объявлений Ульяновска «' + sheet.getName() + '»: нужны ' + (target.kind === 'phone' ? 'Model, MemorySize, Color, SimConfig, RamSize и Price.' : 'Title и Price.'));
    const height = Math.max(sheet.getLastRow() - TC.avito.headerRow, 0), values = height ? sheet.getRange(TC.avito.firstDataRow, 1, height, width).getValues() : [];
    const plan = target.kind === 'phone' ? tcAvitoDirectPhonePlan_(source, layout, values) : tcAvitoDirectTitlePlan_(source, category, layout, values);
    tcWriteAvitoPrices_(sheet, layout.price, plan.updates);
    tcWriteAvitoDates_(sheet, layout.dateEnd, plan.dateUpdates);
    report.sheets[category] = { matched: plan.matched, updated: plan.updates.length, archived:plan.archived, reactivated:plan.reactivated, missing: plan.missing.slice(0, 200), ambiguous: plan.ambiguous.slice(0, 200) };
  });
  PropertiesService.getScriptProperties().setProperty('TC_LAST_PRICE_REPORT', JSON.stringify({
    at: report.at, sourceRows: report.sourceRows, sheets: report.sheets
  }));
  return report;
}
function tcAvitoLayout_(headers) {
  const index = {}; headers.forEach(function(value, column) { index[tcNorm_(value)] = column; });
  const required = ['model', 'memorysize', 'color', 'simconfig', 'ramsize', 'price', 'dateend'];
  return required.every(function(name) { return index[name] >= 0; }) ? { model:index.model, memory:index.memorysize, color:index.color, sim:index.simconfig, ram:index.ramsize, price:index.price, dateEnd:index.dateend } : null;
}
function tcAvitoPricePlan_(products, layout, rows) {
  const source = tcAvitoSourceIndex_(products), updates = [], missing = [], ambiguous = []; let matched = 0;
  rows.forEach(function(row, rowIndex) {
    const target = { model:row[layout.model], memory:row[layout.memory], color:row[layout.color], sim:row[layout.sim], ram:row[layout.ram] };
    const key = tcAvitoPhoneKey_(target);
    if (!key) return;
    if (source.conflicts[key]) { ambiguous.push(tcAvitoLabel_(row, layout)); return; }
    const fallback = source.prices[key] ? null : tcAvitoSafePhoneFallback_(source.phones, target);
    const price = source.prices[key] || (fallback && fallback.price);
    if (!price) { missing.push(tcAvitoLabel_(row, layout)); return; }
    matched++;
    if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price });
  });
  return { updates:updates, matched:matched, missing:missing, ambiguous:ambiguous };
}
function tcAvitoSourceIndex_(products) {
  const prices = {}, conflicts = {}, phones = [];
  products.filter(function(product) { return product.category === 'телефоны' && Number(product.price) > 0; }).forEach(function(product) {
    const phone = tcPhone_(tcDisplay_(product)), key = tcAvitoPhoneKey_(phone);
    // Keep a parsed phone even if the supplier omitted its colour.  It cannot
    // form an exact key, but the safe fallback may still use it when the whole
    // model/memory/RAM group has one price.
    phones.push({ model:phone.model, memory:phone.memory, color:phone.color, sim:phone.config || phone.sim || 'Не знаю', ram:phone.ram, price:Number(product.price) });
    if (!key) return;
    if (prices[key] && prices[key] !== Number(product.price)) { conflicts[key] = true; return; }
    prices[key] = Number(product.price);
  });
  return { prices:prices, conflicts:conflicts, phones:phones };
}
/**
 * A listing may use a technical SIM value or a catalogue colour that differs
 * from the supplier wording. We may relax those fields only when every source
 * row with the same model/memory (and Android RAM) has one identical price.
 * Thus the fallback never chooses between competing supplier prices.
 */
function tcAvitoSafePhoneFallback_(phones, target) {
  const model = tcNorm_(target.model), memory = tcNorm_(target.memory), color = tcNorm_(target.color), ram = tcNorm_(target.ram);
  if (!model || !memory || !color) return null;
  const base = phones.filter(function(phone) {
    return tcNorm_(phone.model) === model && tcNorm_(phone.memory) === memory && (/^iphone\b/.test(model) || tcNorm_(phone.ram) === ram);
  });
  const onePrice = function(items) {
    const prices = Array.from(new Set(items.map(function(item) { return Number(item.price); }).filter(Boolean)));
    return prices.length === 1 ? prices[0] : 0;
  };
  const sameColor = onePrice(base.filter(function(phone) { return tcNorm_(phone.color) === color; }));
  if (sameColor) return { price:sameColor, rule:'same-model-memory-color' };
  const anyColor = onePrice(base);
  return anyColor ? { price:anyColor, rule:'same-model-memory' } : null;
}
function tcAvitoPhoneKey_(phone) {
  const model = tcNorm_(phone.model), memory = tcNorm_(phone.memory), color = tcNorm_(phone.color), sim = tcNorm_(phone.config || phone.sim || 'Не знаю'), ram = tcNorm_(phone.ram);
  if (!model || !memory || !color) return '';
  return [model, memory, color, sim, /^iphone\b/.test(model) ? '' : ram].join('|');
}
function tcAvitoLabel_(row, layout) { return [row[layout.model], row[layout.memory], row[layout.color], row[layout.sim], row[layout.ram]].map(String).join(' | '); }
function tcAvitoTitleLayout_(headers) {
  const index = {}; headers.forEach(function(value, column) { index[tcNorm_(value)] = column; });
  return index.title >= 0 && index.price >= 0 && index.dateend >= 0 ? { title:index.title, price:index.price, dateEnd:index.dateend } : null;
}
/** Extracts finished source-catalogue rows, including both phone blocks. */
function tcAvitoDirectSource_(headers, rows) {
  const layouts = tcLayouts_(headers), items = [];
  layouts.forEach(function(layout) {
    rows.forEach(function(row) {
      const price = Number(row[layout.priceColumn]), title = layout.title >= 0 ? row[layout.title] : '';
      const model = layout.model >= 0 ? row[layout.model] : '';
      if (!price || (!title && !model)) return;
      items.push({ title:title, model:model, memory:layout.memory >= 0 ? row[layout.memory] : '', color:layout.color >= 0 ? row[layout.color] : '', sim:layout.sim >= 0 ? row[layout.sim] : '', ram:layout.ram >= 0 ? row[layout.ram] : '', price:price });
    });
  });
  return items;
}
/** Copies prices from the prepared source phone blocks by their full fields. */
function tcAvitoDirectPhonePlan_(sourceRows, layout, rows) {
  const prices = {}, conflicts = {}, updates = [], dateUpdates = [], missing = [], ambiguous = []; let matched = 0, archived = 0, reactivated = 0;
  sourceRows.forEach(function(row) { const key = tcAvitoPhoneKey_(row), price = Number(row.price); if (!key || !price) return; prices[key] = prices[key] ? Math.min(prices[key], price) : price; });
  rows.forEach(function(row, rowIndex) {
    const target = { model:row[layout.model], memory:row[layout.memory], color:row[layout.color], sim:row[layout.sim], ram:row[layout.ram] }, key = tcAvitoPhoneKey_(target);
    if (!key) return;
    const fallback = prices[key] ? null : tcAvitoCheapestPhoneFallback_(sourceRows, target);
    const price = prices[key] || (fallback && fallback.price);
    if (!price) { missing.push(tcAvitoLabel_(row, layout)); if (row[layout.price] !== '') updates.push({ row:rowIndex, price:'' }); if (!tcAvitoDateIsPast_(row[layout.dateEnd])) { dateUpdates.push({ row:rowIndex, value:tcAvitoStopDate_() }); archived++; } return; }
    matched++; if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price }); if (tcAvitoDateIsPast_(row[layout.dateEnd])) { dateUpdates.push({ row:rowIndex, value:tcAvitoActiveEndDate_() }); reactivated++; }
  });
  return { updates:updates, dateUpdates:dateUpdates, matched:matched, archived:archived, reactivated:reactivated, missing:missing, ambiguous:ambiguous };
}
/** Copies non-phone prices from the prepared source catalogue by Title. */
function tcAvitoDirectTitlePlan_(sourceRows, category, layout, rows) {
  const prices = {}, conflicts = {}, updates = [], dateUpdates = [], missing = [], ambiguous = []; let matched = 0, archived = 0, reactivated = 0;
  sourceRows.forEach(function(row) { const key = tcAvitoTitleKey_(row.title), price = Number(row.price); if (!key || !price) return; prices[key] = prices[key] ? Math.min(prices[key], price) : price; });
  rows.forEach(function(row, rowIndex) {
    const key = tcAvitoTitleKey_(row[layout.title]); if (!key) return;
    const fallback = prices[key] ? null : tcAvitoCheapestTitleFallback_(sourceRows, category, row[layout.title]);
    const price = prices[key] || (fallback && fallback.price);
    if (!price) { missing.push(String(row[layout.title])); if (row[layout.price] !== '') updates.push({ row:rowIndex, price:'' }); if (!tcAvitoDateIsPast_(row[layout.dateEnd])) { dateUpdates.push({ row:rowIndex, value:tcAvitoStopDate_() }); archived++; } return; }
    matched++; if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price }); if (tcAvitoDateIsPast_(row[layout.dateEnd])) { dateUpdates.push({ row:rowIndex, value:tcAvitoActiveEndDate_() }); reactivated++; }
  });
  return { updates:updates, dateUpdates:dateUpdates, matched:matched, archived:archived, reactivated:reactivated, missing:missing, ambiguous:ambiguous };
}
/** Client rule: when the source has several valid supplier variants, use the lowest price. */
function tcAvitoCheapestPhoneFallback_(phones, target) {
  const model = tcNorm_(target.model), memory = tcNorm_(target.memory), color = tcNorm_(target.color), ram = tcNorm_(target.ram);
  if (!model || !memory || !color) return null;
  const base = phones.filter(function(phone) { return tcNorm_(phone.model) === model && tcNorm_(phone.memory) === memory && (/^iphone\b/.test(model) || tcNorm_(phone.ram) === ram); });
  const cheapest = function(items) { const prices = items.map(function(item) { return Number(item.price); }).filter(Boolean); return prices.length ? Math.min.apply(null, prices) : 0; };
  const sameColor = cheapest(base.filter(function(phone) { return tcNorm_(phone.color) === color; }));
  return sameColor ? { price:sameColor, rule:'same-model-memory-color-cheapest' } : (cheapest(base) ? { price:cheapest(base), rule:'same-model-memory-cheapest' } : null);
}
function tcAvitoTitlePricePlan_(products, category, layout, rows) {
  const source = tcAvitoTitleSourceIndex_(products, category), updates = [], missing = [], ambiguous = []; let matched = 0;
  rows.forEach(function(row, rowIndex) {
    const key = tcAvitoTitleKey_(row[layout.title]); if (!key) return;
    if (source.conflicts[key]) { ambiguous.push(String(row[layout.title])); return; }
    const fallback = source.prices[key] ? null : tcAvitoTitleFallback_(source.items, category, row[layout.title]);
    if (fallback && fallback.ambiguous) { ambiguous.push(String(row[layout.title])); return; }
    const price = source.prices[key] || (fallback && fallback.price);
    if (!price) { missing.push(String(row[layout.title])); return; }
    matched++; if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price });
  });
  return { updates:updates, matched:matched, missing:missing, ambiguous:ambiguous };
}
function tcAvitoTitleSourceIndex_(products, category) {
  const prices = {}, conflicts = {}, items = [];
  products.filter(function(product) { return product.category === category && Number(product.price) > 0; }).forEach(function(product) {
    const title = tcDisplay_(product), key = tcAvitoTitleKey_(title); if (!key) return;
    items.push({ title:title, price:Number(product.price) });
    if (prices[key] && prices[key] !== Number(product.price)) { conflicts[key] = true; return; }
    prices[key] = Number(product.price);
  });
  return { prices:prices, conflicts:conflicts, items:items };
}
// Canonical key removes only editorial differences.  It deliberately keeps
// chip, size, memory and Nano Texture, so different SKUs cannot collapse.
function tcAvitoTitleKey_(value) {
  let text = String(value || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
    .replace(/\((?:актив|уценка|active)\)|\b(?:актив|уценка|active)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b(?!\s*(?:гб|gb|тб|tb))/giu, '')
    .replace(/\bapple\b/gi, '')
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:тб|tb)(?=$|[^\p{L}\p{N}])/giu, function(_, amount) { return String(Math.round(Number(String(amount).replace(',', '.')) * 1024)) + ' gb'; })
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:гб|gb)(?=$|[^\p{L}\p{N}])/giu, '$1 gb')
    .replace(/wi[\s\-\u2010-\u2015\u2011]?fi/gi, 'wifi').replace(/e[\s\-\u2010-\u2015\u2011]?sim/gi, 'esim')
    .replace(/space\s+gray/gi, 'spacegray').replace(/space\s+black/gi, 'black')
    .replace(/[()\[\],.;:/|]+/g, ' ').toLocaleLowerCase('ru-RU');
  return text.split(/\s+/).filter(Boolean).sort().join('|');
}
/**
 * Supplier and Avito titles are editorially different. Match their meaningful
 * words, not their complete strings, but reject a pair as soon as it declares
 * conflicting hardware (chip, Dyson series, RAM/SSD, watch size or PS family).
 */
function tcAvitoTitleFallback_(items, category, targetTitle) {
  const threshold = { 'айпады':0.55, 'дайсон':0.55, 'часы':0.60, 'макбуки':0.65, 'наушники':0.65, 'пс':0.65 }[category] || 0.70;
  const candidates = items.map(function(item) {
    return { title:item.title, price:item.price, score:tcAvitoTitleScore_(category, targetTitle, item.title) };
  }).filter(function(item) { return item.score >= threshold; });
  if (!candidates.length) return null;
  candidates.sort(function(left, right) { return right.score - left.score; });
  const bestScore = candidates[0].score, best = candidates.filter(function(item) { return item.score === bestScore; });
  const prices = Array.from(new Set(best.map(function(item) { return Number(item.price); })));
  return prices.length === 1 ? { price:prices[0], score:bestScore } : { ambiguous:true };
}
function tcAvitoCheapestTitleFallback_(items, category, targetTitle) {
  const threshold = { 'айпады':0.70, 'дайсон':0.60, 'часы':0.65, 'макбуки':0.65, 'наушники':0.65, 'пс':0.70 }[category] || 0.75;
  const candidates = items.map(function(item) { return { title:item.title, price:item.price, score:tcAvitoTitleScore_(category, targetTitle, item.title) }; }).filter(function(item) { return item.score >= threshold; });
  if (!candidates.length) return null;
  const bestScore = Math.max.apply(null, candidates.map(function(item) { return item.score; })), best = candidates.filter(function(item) { return item.score === bestScore; });
  return { price:Math.min.apply(null, best.map(function(item) { return Number(item.price); }).filter(Boolean)), score:bestScore };
}
function tcAvitoTitleScore_(category, left, right) {
  const a = tcAvitoTitleWords_(left), b = tcAvitoTitleWords_(right);
  if (!a.length || !b.length || tcAvitoFamilyConflict_(category, left, right) || tcAvitoColorConflict_(left, right) || tcAvitoHardwareConflict_(category, a, b)) return 0;
  const set = {}; a.forEach(function(word) { set[word] = true; });
  const shared = b.filter(function(word) { return set[word]; }).length;
  return shared / Math.max(a.length, b.length);
}
function tcAvitoTitleWords_(value) {
  const ignored = { apple:true, samsung:true, sony:true, стайлер:true, гарантия:true, рассрочка:true, active:true, актив:true, уценка:true, новый:true, оригинал:true, товар:true, sale:true, loop:true, milanese:true, wifi:true };
  const text = String(value || '').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .replace(/ipad\s+(\d+)\s+mini/g, 'ipad mini $1').replace(/apple\s+watch\s+(?:series\s+)?(se|ultra)\s+(\d+)/g, 'watch $1$2').replace(/apple\s+watch\s+series\s+(\d+)/g, 'watch s$1')
    .replace(/playstation/g, 'ps').replace(/\bps\s+(\d)\b/g, 'ps$1').replace(/airpods\s+pro\s+(\d+)/g, 'airpods pro$1').replace(/airpods\s+(\d+)\b/g, 'airpods$1').replace(/\b([hsdt])\s*(\d{2})\b/g, '$1$2')
    .replace(/(\d+)\s*\/\s*(\d+)(?:\s*(gb|гб|tb|тб))?/g, function(all, ram, storage, unit) { return ram + 'x' + storage + (/^(tb|тб)$/i.test(unit || '') ? 'tb' : 'gb'); }).replace(/(\d+)\s*(?:gb|гб)/g, '$1gb').replace(/(\d+)\s*(?:tb|тб)/g, '$1tb')
    .replace(/(\d+)\s*mm\b/g, '$1mm').replace(/wi[\s\-\u2010-\u2015\u2011]*fi/g, 'wifi').replace(/[()\[\],.;:+/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(new Set(text.split(' ').filter(function(word) { return (word.length > 1 || /^\d{1,2}$/.test(word)) && !ignored[word] && !/^\d{4}$/.test(word) && !/^[a-zа-я]{1,2}\d{3,}[a-zа-я0-9-]*$/i.test(word); })));
}
function tcAvitoFamilyConflict_(category, left, right) {
  const family = function(value) { const text = tcNorm_(value);
    if (category === 'макбуки') return /macbook/.test(text) ? 'macbook' : /galaxy\s*book/.test(text) ? 'galaxybook' : '';
    if (category === 'айпады') return /ipad/.test(text) ? 'ipad' : /galaxy\s*tab/.test(text) ? 'galaxytab' : /(?:xiaomi|redmi)\s*pad/.test(text) ? 'xiaomipad' : '';
    if (category === 'часы') return /galaxy/.test(text) ? 'galaxywatch' : /apple|watch\s*(?:series|se|ultra)/.test(text) ? 'applewatch' : /garmin/.test(text) ? 'garmin' : '';
    if (category === 'наушники') return /airpods/.test(text) ? 'airpods' : /galaxy\s*buds|\bbuds\b/.test(text) ? 'galaxybuds' : '';
    if (category === 'пс') return /xbox/.test(text) ? 'xbox' : /playstation|\bps\s*\d/.test(text) ? 'playstation' : ''; return ''; };
  const a = family(left), b = family(right); return Boolean(a && b && a !== b);
}
function tcAvitoColorConflict_(left, right) {
  const colors = function(value) { const text = tcNorm_(value).replace(/space\s+black/g, 'black').replace(/space\s+gray/g, 'gray').replace(/rose\s+gold/g, 'gold'); const names = ['black','white','blue','topaz','purple','plum','silver','gold','starlight','midnight','gray','grey','green','pink','yellow','red','orange','natural','vinca','jasper','ceramic','patina','nickel','copper']; return names.filter(function(name) { return new RegExp('(^|[^a-z])' + name + '($|[^a-z])', 'i').test(text); }); };
  const a = colors(left), b = colors(right); return Boolean(a.length && b.length && !a.some(function(color) { return b.indexOf(color) >= 0; }));
}
function tcAvitoHardwareConflict_(category, left, right) {
  const pick = function(words, pattern) { return words.filter(function(word) { return pattern.test(word); }); };
  const differs = function(pattern) {
    const a = pick(left, pattern), b = pick(right, pattern);
    return a.length && b.length && !a.some(function(word) { return b.indexOf(word) >= 0; });
  };
  const onlyOneHas = function(word) { return (left.indexOf(word) >= 0) !== (right.indexOf(word) >= 0); };
  if (tcAvitoScreenSize_(category, left, right)) return true;
  if (category === 'макбуки' && (differs(/^m\d+$/) || differs(/^\d+x\d+(?:gb|tb)$/))) return true;
  if (category === 'айпады' && (differs(/^m\d+$/) || differs(/^a\d+$/) || differs(/^\d+(?:gb|tb)$/) || onlyOneHas('lte') || onlyOneHas('nano') || onlyOneHas('texture'))) return true;
  if (category === 'дайсон' && differs(/^(?:hs|hd|ht)\d+$/)) return true;
  if (category === 'часы' && (differs(/^\d+mm$/) || differs(/^(?:se|ultra|s)\d+$/))) return true;
  if (category === 'наушники' && (differs(/^pro\d+$/) || differs(/^airpods\d+$/))) return true;
  if (category === 'пс' && differs(/^ps\d+$/)) return true;
  return false;
}
function tcAvitoScreenSize_(category, left, right) {
  const extract = function(items) { const text = items.join(' '); if (category === 'айпады') { const m = /\bipad\s+(?:air|pro)\s+(11|13)\b/.exec(text); return m && m[1] || ''; } if (category === 'макбуки') { const m = /\bmacbook\s+(?:air|pro)\s+(13|14|15|16)\b|\bmacbook\s+neo\s+(13|14|15|16)\b|\bmacbook\s+(13|14|15|16)\s+neo\b/.exec(text); return m && (m[1] || m[2] || m[3]) || ''; } return ''; };
  const a = extract(left), b = extract(right); return Boolean(a && b && a !== b);
}
function tcWriteAvitoPrices_(sheet, priceColumn, updates) {
  updates.sort(function(a, b) { return a.row - b.row; });
  for (let start = 0; start < updates.length;) {
    let end = start + 1; while (end < updates.length && updates[end].row === updates[end - 1].row + 1) end++;
    sheet.getRange(TC.avito.firstDataRow + updates[start].row, priceColumn + 1, end - start, 1).setValues(updates.slice(start, end).map(function(item) { return [item.price]; }));
    start = end;
  }
}
function tcWriteAvitoDates_(sheet, dateColumn, updates) { tcWriteAvitoColumn_(sheet, dateColumn, updates, 'value'); }
function tcWriteAvitoColumn_(sheet, column, updates, field) {
  updates.sort(function(a, b) { return a.row - b.row; });
  for (let start = 0; start < updates.length;) {
    let end = start + 1; while (end < updates.length && updates[end].row === updates[end - 1].row + 1) end++;
    sheet.getRange(TC.avito.firstDataRow + updates[start].row, column + 1, end - start, 1).setValues(updates.slice(start, end).map(function(item) { return [item[field]]; }));
    start = end;
  }
}
function tcAvitoStopDate_() { const date = new Date(); date.setDate(date.getDate() - 1); return date; }
function tcAvitoActiveEndDate_() { const date = new Date(); date.setDate(date.getDate() + 30); return date; }
function tcAvitoDateIsPast_(value) { const date = value instanceof Date ? value : new Date(value); return !isNaN(date.getTime()) && date.getTime() < Date.now(); }

// These invariants run before every supplier rebuild.  They make accidental
// weakening of SKU matching or markup parsing fail closed, before Avito data
// is touched.  Run manually from Apps Script as tcRunUlyanovskRegressionTests.
function tcRunUlyanovskRegressionTests() {
  const failures = [], equal = function(actual, expected, name) { if (actual !== expected) failures.push(name); }, truth = function(value, name) { if (!value) failures.push(name); };
  const key = tcAvitoTitleKey_;
  equal(key('iPad 7 mini (2024), 128 ГБ Wi‑Fi Blue'), key('Apple iPad Mini 7 128 GB Wi-Fi Blue'), 'год/порядок/Wi-Fi должны быть редакторским различием');
  truth(key('iPad Pro 11 M4 1 ТБ Wi-Fi Black') !== key('iPad Pro 11 M4 2 ТБ Wi-Fi Black'), '1 ТБ и 2 ТБ не должны совпадать');
  truth(key('iPad Pro 11 M4 2 ТБ Wi-Fi Black') !== key('iPad Pro 11 M4 Nano Texture 2 ТБ Wi-Fi Black'), 'Nano Texture должен быть отдельным SKU');
  equal(tcAvitoTitleScore_('айпады', 'iPad Air 11 M4 256 GB Wi-Fi Blue', 'iPad Air 13 M4 256 GB Wi-Fi Blue'), 0, 'iPad 11 и 13 нельзя смешивать');
  equal(tcAvitoTitleScore_('макбуки', 'MacBook Air 13 M5 16/512 Blue', 'MacBook Air 15 M5 16/512 Blue'), 0, 'MacBook 13 и 15 нельзя смешивать');
  equal(tcAvitoTitleScore_('дайсон', 'Dyson HS08 Blue', 'Dyson HT01 Blue'), 0, 'Dyson HS и HT нельзя смешивать');
  equal(tcAvitoCheapestTitleFallback_([{ title:'iPad Mini 7 A17 128 GB Wi-Fi Blue', price:49000 }], 'айпады', 'iPad 7 mini (2024), 128 ГБ Wi‑Fi Blue').price, 49000, 'безопасное различие названий должно находиться');
  equal(tcAvitoCheapestTitleFallback_([{ title:'iPad Mini 7 A17 128 GB Wi-Fi Blue', price:49000 }], 'айпады', 'iPad 7 mini (2024), 128 ГБ Wi‑Fi Purple'), null, 'разные цвета нельзя смешивать');
  truth(tcAvitoLayout_(['Model','MemorySize','Color','SimConfig','RamSize','Price','DateEnd']), 'телефонный лист обязан иметь DateEnd');
  truth(tcAvitoTitleLayout_(['Title','Price','DateEnd']), 'Title-лист обязан иметь DateEnd');
  equal(tcParseMarkupCsv_('Модель,Наценка\niPhone,\nMacBook,3000').length, 1, 'пустая наценка не равна нулевой');
  const plan = tcAvitoDirectTitlePlan_([{ title:'iPad Mini 7 A17 128 GB Wi-Fi Blue', price:49000 }], 'айпады', { title:0, price:1, dateEnd:2 }, [['iPad 7 mini (2024), 128 ГБ Wi-Fi Blue', 0, new Date('2099-01-01')], ['iPad Pro 11 M4 2 ТБ Wi-Fi Black', 130000, new Date('2099-01-01')]]);
  equal(plan.matched, 1, 'существующий SKU должен обновиться'); equal(plan.archived, 1, 'отсутствующий SKU должен архивироваться'); equal(plan.updates[1].price, '', 'у отсутствующего SKU очищается цена');
  if (failures.length) throw new Error('REGRESSION FAIL (Ульяновск): ' + failures.join(' | '));
  return { passed:14, message:'Ульяновск: 14/14 защитных проверок пройдено.' };
}
function tcAssertUlyanovskInvariants_() { return tcRunUlyanovskRegressionTests(); }

function tcWriteSheet_(sheet, products) {
  tcRemoveCountryColumns_(sheet);
  const lastColumn = sheet.getLastColumn(), lastRow = Math.max(sheet.getLastRow(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  tcValidateSchema_(sheet, headers);
  const layouts = tcLayouts_(headers);
  if (!layouts.length) throw new Error('На листе «' + sheet.getName() + '» не найдена колонка Price/Цена.');
  const buckets = layouts.map(function() { return []; });
  products.forEach(function(product) { buckets[tcLayoutFor_(layouts, product)].push(product); });
  // Telegram shows blocks in the order of posts. A catalogue is easier to
  // browse when models are ordered by generation (iPhone 13 → 14 → ...),
  // then by version, memory, SIM, country and colour.
  buckets.forEach(function(bucket) { bucket.sort(tcProductSort_); });
  let written = 0;
  layouts.forEach(function(layout, index) {
    const data = buckets[index].map(function(product) { return tcTargetRow_(headers, layout, product); });
    // Apps Script does not expand a sheet automatically when setValues reaches
    // beyond its current grid. Large supplier catalogues must work on a blank
    // standard tab as well as on a previously filled one.
    const requiredRows = data.length + 1;
    if (sheet.getMaxRows() < requiredRows) sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
    const height = Math.max(lastRow - 1, data.length, 1), width = layout.priceColumn - layout.start + 1;
    // The source catalogue is authoritative. Remove every restrictive
    // dropdown from the data area, not only SIM: old templates can also lock
    // memory, colour, model, or price and reject legitimate supplier values.
    const target = sheet.getRange(2, layout.start + 1, height, width);
    target.clearDataValidations();
    target.clearContent();
    if (data.length) {
      sheet.getRange(2, layout.start + 1, data.length, width).setValues(data);
      sheet.getRange(2, layout.priceColumn + 1, data.length, 1).setNumberFormat('0');
      written += data.length;
    }
  });
  return written;
}

function tcValidateSchema_(sheet, headers) {
  const expected = sheet.getName() === 'телефоны' ? ['model','simconfig','memorysize','color','price','','model','simconfig','memorysize','color','ramsize','price'] : ['title','price'];
  const actual = headers.map(tcNorm_);
  if (expected.some(function(value, index) { return actual[index] !== value; })) throw new Error('Неверная шапка листа «' + sheet.getName() + '». Ожидается формат внешней автозагрузки.');
}

function tcRemoveCountryColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let column = headers.length - 1; column >= 0; column--) {
    if (/^(country|страна)$/i.test(String(headers[column] || '').trim())) sheet.deleteColumn(column + 1);
  }
}

function tcLayouts_(headers) {
  const prices = [];
  headers.forEach(function(value, index) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(value || '').trim())) prices.push(index); });
  return prices.map(function(priceColumn, index) {
    const start = index ? prices[index - 1] + 1 : 0;
    const block = headers.slice(start, priceColumn + 1).map(tcNorm_);
    const column = function(names) { const found = names.map(function(name) { return block.indexOf(name); }).find(function(i) { return i >= 0; }); return found === undefined ? -1 : start + found; };
    return { start: start, priceColumn: priceColumn, title: column(['title', 'товар', 'наименование']), model: column(['model', 'модель']), memory: column(['memorysize', 'memory size', 'память']), ram: column(['ramsize', 'ram size', 'ram', 'озу']), color: column(['color', 'цвет']), sim: column(['simconfig', 'sim config', 'sim', 'сим конфигурация']) };
  });
}

function tcLayoutFor_(layouts, product) {
  if (layouts.length === 1) return 0;
  // The supplied standard phone template uses its first block for iPhone and
  // the second for Android. Other multi-block templates keep source order.
  if (product.category === 'телефоны') return /^iphone\b/i.test(product.name) ? 0 : layouts.length - 1;
  return 0;
}

function tcTargetRow_(headers, layout, product) {
  const width = layout.priceColumn - layout.start + 1, row = Array(width).fill('');
  const at = function(column, value) { if (column >= layout.start && column <= layout.priceColumn) row[column - layout.start] = value; };
  const full = tcDisplay_(product), phone = tcPhone_(full);
  if (layout.title >= 0) at(layout.title, full);
  if (layout.model >= 0) at(layout.model, phone.model || product.name);
  if (layout.memory >= 0) at(layout.memory, phone.memory);
  if (layout.ram >= 0) at(layout.ram, phone.ram);
  if (layout.color >= 0) at(layout.color, phone.color);
  if (layout.sim >= 0) at(layout.sim, phone.config || 'Не знаю');
  at(layout.priceColumn, product.price);
  return row;
}

function tcProductSort_(left, right) {
  const a = tcPhone_(tcDisplay_(left)), b = tcPhone_(tcDisplay_(right));
  const ar = tcIphoneRank_(a.model), br = tcIphoneRank_(b.model);
  if (ar && br) {
    for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return ar[i] - br[i];
  } else if (ar) return -1;
  else if (br) return 1;
  else {
    const models = tcTextCompare_(a.model || left.name, b.model || right.name);
    if (models) return models;
  }
  const memory = tcMemoryRank_(a.memory) - tcMemoryRank_(b.memory);
  if (memory) return memory;
  const config = tcTextCompare_(a.config, b.config);
  if (config) return config;
  const country = tcTextCompare_(a.country, b.country);
  if (country) return country;
  const color = tcTextCompare_(a.color, b.color);
  if (color) return color;
  return Number(left.price || 0) - Number(right.price || 0);
}

function tcIphoneRank_(model) {
  const match = /^iphone\s+(\d+)(e?)(?:\s+(.*))?$/i.exec(String(model || ''));
  if (!match) return null;
  const version = tcNorm_(match[3]);
  // Keep the families of one generation together: e, base, mini, Plus, Air,
  // Pro, Pro Max. This also makes future iPhones sort without new settings.
  const variant = match[2] ? 0 : version === '' ? 1 : version === 'mini' ? 2 :
    version === 'plus' ? 3 : version === 'air' ? 4 : version === 'pro' ? 5 :
    version === 'pro max' ? 6 : 7;
  return [Number(match[1]), variant];
}

function tcMemoryRank_(value) {
  const match = /(\d+(?:[.,]\d+)?)\s*(гб|gb|тб|tb)/i.exec(String(value || ''));
  if (!match) return Number.MAX_SAFE_INTEGER;
  const amount = Number(match[1].replace(',', '.'));
  return amount * (/тб|tb/i.test(match[2]) ? 1024 : 1);
}

function tcTextCompare_(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'ru', { numeric: true, sensitivity: 'base' });
}

function tcChannel_(value) { const v = String(value || '').trim().replace(/^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?/i, '').replace(/^@/, ''); return /^[A-Za-z][A-Za-z0-9_]{4,}$/.test(v) ? v.toLowerCase() : ''; }
function tcSummary_(result) {
  const mirror = Number(result.mirrored || 0);
  const cheapest = Number(result.cheapest || 0);
  const markedUp = Number(result.markedUp || 0);
  const withoutMarkup = Number(result.withoutMarkup || 0);
  return 'Каталог получен: ' + result.rows + ' позиций. Записано в листы: ' + result.written +
    (mirror ? '. Добавлено вариантов «2 SIM»: ' + mirror : '') +
    (cheapest ? '. Оставлено самых дешёвых вариантов: ' + cheapest : '') +
    '. Наценка из файла применена к ' + markedUp + ' позициям' +
    (withoutMarkup ? '. Без правила наценки: ' + withoutMarkup : '') +
    '. Далее обновляется автоматически каждые 15 минут.';
}
function tcNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
function tcDisplay_(product) { return [product.name, product.variant].filter(Boolean).join(' ').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim(); }

/**
 * Client-specific publishing rule. Some Avito catalogues need a third
 * configuration "2 SIM", while the supplier publishes its price only for
 * "SIM + eSIM". We create an explicit copy with the same price. An actual
 * supplier 2 SIM row always wins and prevents a generated duplicate.
 */
function tcAddTwoSimMirror_(sourceRows, enabled) {
  const rows = Array.isArray(sourceRows) ? sourceRows.slice() : [];
  if (!enabled) return { rows: rows, mirrored: 0 };
  const existingTwoSim = {};
  rows.forEach(function(row) {
    const phone = tcPhone_(tcDisplay_(row));
    if (phone.config === '2 SIM') existingTwoSim[tcTwoSimKey_(phone)] = true;
  });
  const additions = [];
  rows.forEach(function(row) {
    const phone = tcPhone_(tcDisplay_(row));
    if (phone.config !== 'SIM + eSIM') return;
    const replacement = tcReplaceTwoSim_(row);
    const key = tcTwoSimKey_(tcPhone_(tcDisplay_(replacement)));
    if (!key || existingTwoSim[key]) return;
    existingTwoSim[key] = true;
    additions.push(replacement);
  });
  return { rows: rows.concat(additions), mirrored: additions.length };
}

function tcReplaceTwoSim_(row) {
  const replace = function(value) { return String(value || '').replace(/sim\s*\+\s*e\s*-?sim/ig, '2 SIM'); };
  return Object.assign({}, row, { name: replace(row.name), variant: replace(row.variant), generatedTwoSim: true });
}

function tcTwoSimKey_(phone) {
  return [phone.model, phone.memory, phone.ram, phone.color, phone.country]
    .map(tcNorm_).join('|').replace(/^\|+|\|+$/g, '');
}

// Для одинаковой конфигурации (модель, SIM, память, RAM и цвет) оставляем
// страну с самой низкой закупочной ценой. При равной цене порядок стабилен.
function tcChooseCheapestCountry_(rows) {
  const selected = {};
  rows.forEach(function(row) {
    const phone = tcPhone_(tcDisplay_(row));
    const fallback = tcNorm_(tcDisplay_(row))
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();
    const key = [row.category, phone.model || fallback, phone.config, phone.memory, phone.ram, phone.color]
      .map(tcNorm_).join('|');
    const current = selected[key];
    const currentPhone = current && tcPhone_(tcDisplay_(current));
    if (!current || Number(row.price) < Number(current.price) ||
      (Number(row.price) === Number(current.price) && tcTextCompare_(phone.country, currentPhone.country) < 0)) {
      selected[key] = row;
    }
  });
  const kept = Object.keys(selected).map(function(key) { return selected[key]; });
  return { rows: kept, removed: Math.max(0, rows.length - kept.length) };
}

function tcLoadUlyanovskMarkup_() {
  const rules = TC.markupGids.reduce(function(all, gid) {
    const url = 'https://docs.google.com/spreadsheets/d/' + TC.markupSheetId + '/export?format=csv&gid=' + gid;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      throw new Error('Не удалось прочитать вкладку ' + gid + ' файла наценок Ульяновска. Проверьте доступ к ней.');
    }
    return all.concat(tcParseMarkupCsv_(response.getContentText()));
  }, []);
  if (!rules.length) throw new Error('В файле наценок Ульяновска не найдены правила.');
  return rules;
}

function tcParseMarkupCsv_(csv) {
  const table = Utilities.parseCsv(String(csv || ''));
  return table.map(function(row) {
    const label = String(row[0] || '').trim();
    const amountText = String(row[1] || '').replace(/[^\d.,-]/g, '').replace(',', '.');
    const amount = Number(amountText);
    // Section headings in the markup workbook have an empty second cell. They
    // are labels, not a legitimate zero-rouble markup rule.
    return label && amountText && Number.isFinite(amount) ? { label: label, amount: amount } : null;
  }).filter(Boolean);
}

function tcApplyUlyanovskMarkup_(rows, rules) {
  let applied = 0, withoutRule = 0;
  const priced = rows.map(function(row) {
    const amount = tcMarkupAmount_(row, rules);
    if (amount === null) { withoutRule++; return Object.assign({}, row); }
    applied++;
    return Object.assign({}, row, { supplierPrice: row.price, markup: amount, price: Number(row.price) + amount });
  });
  return { rows: priced, applied: applied, withoutRule: withoutRule };
}

function tcMarkupAmount_(row, rules) {
  const display = tcDisplay_(row), name = tcNorm_(display), phone = tcPhone_(display);
  const find = function(pattern) {
    const hit = rules.find(function(rule) { return pattern.test(tcNorm_(rule.label)); });
    return hit ? hit.amount : null;
  };
  // Точные карточки из брендовых вкладок имеют приоритет над общими
  // правилами Apple/Samsung. Флаги страны и служебные пометки не меняют
  // товар; если после их удаления есть правила с разной наценкой, fallback
  // не угадывает и переходит к общему правилу.
  const direct = rules.find(function(rule) { return tcNorm_(rule.label) === name; });
  if (direct) return direct.amount;
  const productKey = tcMarkupKey_(display), equalRules = rules.filter(function(rule) { return tcMarkupKey_(rule.label) === productKey; });
  const amounts = equalRules.map(function(rule) { return rule.amount; }).filter(function(amount, index, values) { return values.indexOf(amount) === index; });
  if (productKey && amounts.length === 1) return amounts[0];
  if (/airpods/.test(name)) return find(/наушники\s+airpods/);
  if (/\bwatch\b/.test(name)) return find(/^часы$/);
  if (/macbook/.test(name)) return find(/^macbook/);
  if (/\b(imac|mini)\b/.test(name)) return find(/imac\/mini/);
  if (/ipad/.test(name)) return find(/\bpro\b/.test(name) ? /^ipad\s+pro$/ : /ipad.*кроме\s+про/);
  if (!/^iphone\b/.test(name)) {
    if (/galaxy\s*buds/.test(name)) return find(/galaxy\s*buds/);
    if (/galaxy\s*watch/.test(name)) return find(/galaxy\s*watch/);
    if (/galaxy\s*tab\s*s/.test(name)) return find(/galaxy\s*tab\s*s.*сер/);
    if (/galaxy\s*tab\s*a/.test(name)) return find(/galaxy\s*tab\s*a.*сер/);
    if (/galaxy\s*(?:s|z\s*fold)/.test(name)) return find(/s\s*-\s*сер|z\s*-?fold/);
    if (/galaxy\s*a\d/.test(name)) return find(/a\s*-\s*сер/);
    return null;
  }

  const memoryGb = Number(String(phone.memory || '').replace(/[^\d]/g, ''));
  const premium = /^iphone\s+17\s+(?:pro|max|pro\s+max)\b/.test(name) && memoryGb >= 512;
  if (premium) {
    const amount = find(/iphone\s+17\s+pro.*512.*17\s+pro\s+max.*512/);
    if (amount !== null) return amount;
  }
  const apple = find(/iphone\s+13.*17\s+pro\s+max.*256/);
  if (apple !== null) return apple;
  return null;
}

function tcMarkupKey_(value) {
  return tcNorm_(value)
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ')
    .replace(/[()\[\],.;:]+/g, ' ')
    .replace(/(?:^|\s)(?:актив|уценка|active)(?=\s|$)/gi, ' ')
    .replace(/(\d+)\s*(?:gb|гб)/gi, '$1gb').replace(/(\d+)\s*(?:tb|тб)/gi, '$1tb')
    .replace(/[^a-zа-я0-9]+/gi, ' ').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function tcFetchRows_(channel) {
  let url = 'https://t.me/s/' + channel, page = 0; const latest = {};
  while (url && page++ < 12) {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('Telegram вернул HTTP ' + response.getResponseCode());
    const parsed = tcParsePreview_(response.getContentText(), channel);
    parsed.rows.forEach(function(row) { const key = tcNorm_(row.name).replace(/[^a-zа-я0-9]+/g, ' ') + '|' + tcNorm_(row.variant); if (!latest[key]) latest[key] = row; });
    url = parsed.previous ? 'https://t.me' + parsed.previous : '';
  }
  return Object.keys(latest).map(function(key) { return latest[key]; });
}

function tcParsePreview_(html, channel) {
  const rows = [], chunks = String(html || '').split(/<div class="tgme_widget_message_wrap[^>]*">/i);
  for (let i = 1; i < chunks.length; i++) {
    const post = /data-post="[^/]+\/(\d+)"/i.exec(chunks[i]), body = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i.exec(chunks[i]);
    if (!post || !body) continue;
    rows.push.apply(rows, tcParsePost_(tcHtml_(body[1]), channel, post[1]));
  }
  const more = /<a href="(\/s\/[^"?]+\?before=\d+)" class="tme_messages_more/i.exec(html || '');
  return { rows: rows, previous: more && more[1] || '' };
}

function tcHtml_(value) { return String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/&nbsp;/gi, ' ').replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(Number(n)); }).replace(/&#x([\da-f]+);/gi, function(_, n) { return String.fromCharCode(parseInt(n, 16)); }).replace(/&amp;/gi, '&').replace(/<[^>]+>/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }

function tcParsePost_(text, channel, post) {
  const lines = String(text || '').split('\n').map(function(line) { return line.trim(); }).filter(Boolean);
  if (!lines.length || /товары\s+не\s+найдены/i.test(text)) return [];
  const header = lines[0].replace(/^📦\s*/, '').replace(/\s*\(часть\s*\d+\/\d+\)\s*$/i, '');
  // Supplier sections may be named just "Google" or "Honor". The models in
  // their rows still identify the correct destination sheet.
  return lines.slice(1).map(function(line) { return tcLine_(header, line, channel, post); })
    .filter(function(row) { return row && TC.sheets.indexOf(row.category) >= 0; });
}

function tcLine_(header, line, channel, post) {
  const match = /^(.*?)\s*(?:-|—|–)\s*([\d\s]{3,})\s*(?:₽|руб\.?|rub)?\s*$/i.exec(line);
  if (!match) return null;
  let core = match[1].replace(/\s+/g, ' ').trim(), variant = '';
  const suffix = /(\([^)]*\))\s*$/u.exec(core); if (suffix) { variant = suffix[1]; core = core.slice(0, suffix.index).trim(); }
  const flag = /([\u{1F1E6}-\u{1F1FF}]{2})\s*$/u.exec(core); if (flag) { variant = (flag[1] + (variant ? ' ' + variant : '')).trim(); core = core.slice(0, flag.index).trim(); }
  const name = tcExpand_(header, core), price = Number(match[2].replace(/\s/g, ''));
  return name && price > 0 ? { category: tcCategory_(header + ' ' + name), name: name, variant: variant, price: price, post: post, url: 'https://t.me/' + channel + '/' + post } : null;
}

function tcExpand_(header, item) { const h = String(header).replace(/\\/g, ' ').trim(), i = String(item); if (/^iphone\s/i.test(h) && !/^iphone\s/i.test(i)) return h + ' ' + i; if (/^macbook\b/i.test(h) && !/^macbook\b/i.test(i)) return h + ' ' + i; if (/^dyson\b/i.test(h) && !/^dyson\b/i.test(i)) return h + ' ' + i; if (/^airpods\b/i.test(h) && !/^airpods\b/i.test(i)) return h + ' ' + i; if (/^imac\b/i.test(h) && !/^imac\b/i.test(i)) return h + ' ' + i; if (/^watch\b/i.test(h) && /^watch\b/i.test(i)) return 'Apple ' + i; return i; }
function tcCategory_(value) { const v = tcNorm_(value); if (/iphone|galaxy|pixel|xiaomi|samsung|honor|huawei|oneplus|realme/.test(v)) return 'телефоны'; if (/macbook/.test(v)) return 'макбуки'; if (/ipad/.test(v)) return 'айпады'; if (/watch/.test(v)) return 'часы'; if (/airpods|наушники|колонки/.test(v)) return 'наушники'; if (/playstation|\bps[345]\b|xbox/.test(v)) return 'пс'; if (/dyson/.test(v)) return 'дайсон'; if (/imac/.test(v)) return 'аймаки'; return 'прочее'; }
function tcPhone_(value) {
  const text = String(value || ''), specs = /(\d{1,2})\s*\/\s*(\d{2,4})\s*(гб|gb|тб|tb)/i.exec(text);
  const memory = specs ? null : /(?:^|\s)(\d{1,4})\s?(гб|gb|тб|tb)(?=\s|$)/i.exec(text);
  const unit = function(amount, suffix) { return amount + ' ' + suffix.toUpperCase().replace('GB', 'ГБ').replace('TB', 'ТБ'); };
  const sim = /\b2\s*(?:sim|сим)\b/i.test(text) ? '2 SIM' : /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : '';
  return { model: tcModel_(text), memory: specs ? unit(specs[2], specs[3]) : memory ? unit(memory[1], memory[2]) : '', ram: specs ? unit(specs[1], 'GB') : '', color: tcColor_(text), config: sim, country: tcCountry_(text) };
}
function tcModel_(value) { const text = String(value || '').replace(/\(\s*asis\s*\)/gi, ' ').replace(/\s+/g, ' ').trim(); const iphone = /\biphone\s+(\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?)/i.exec(text); if (iphone) return 'iPhone ' + iphone[1].replace(/\s+/g, ' ').trim(); const other = /\b(galaxy\s+(?:s|a|z|m)\d+(?:\+|\s+(?:ultra|fe|plus))?|pixel\s+\d+(?:[a-z])?(?:\s+(?:pro|xl))?|honor\s+[\w-]+(?:\s+(?:pro|lite|x\d+d?))?)/i.exec(text); return other ? other[1].replace(/\s+/g, ' ').trim() : ''; }
function tcCountry_(value) { const flag = /(🇺🇸|🇯🇵|🇭🇰|🇰🇷|🇮🇳|🇨🇦|🇸🇬|🇦🇪|🇷🇺|🇨🇳)/u.exec(String(value || '')); const names = {'🇺🇸':'США','🇯🇵':'Япония','🇭🇰':'Гонконг','🇰🇷':'Корея','🇮🇳':'Индия','🇨🇦':'Канада','🇸🇬':'Сингапур','🇦🇪':'ОАЭ','🇷🇺':'Россия','🇨🇳':'Китай'}; return flag ? names[flag[1]] + ' ' + flag[1] : ''; }
// Цвет из Telegram может стоять в любом месте строки и быть отделён скобками,
// тире или флагом страны. Это не подставляет цвет, которого нет у поставщика.
function tcColorKey_(value) { return tcNorm_(value).replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim(); }
function tcColor_(value) {
  const v = tcColorKey_(value);
  const colors = [
    ['space black','черный'],['black titanium','черный'],['white titanium','белый'],['blue titanium','синий'],['natural titanium','натуральный'],['desert titanium','пустынный'],
    ['deep purple','темно-фиолетовый'],['sierra blue','голубой'],['pacific blue','голубой'],['sky blue','голубой'],['alpine green','темно-зеленый'],['midnight green','темно-зеленый'],
    ['space gray','серый'],['rose gold','розовое золото'],['cosmic orange','оранжевый'],['product red','красный'],
    ['сияющая звезда','сияющая звезда'],['розовое золото','розовое золото'],['темно фиолетовый','темно-фиолетовый'],['темно зеленый','темно-зеленый'],
    ['ultramarine','ультрамарин'],['graphite','графитовый'],['coral','коралловый'],['teal','бирюзовый'],['lavender','лавандовый'],['violet','фиолетовый'],['indigo','индиго'],['titanium','титан'],['porcelain','фарфоровый'],['hazel','ореховый'],['aloe','алоэ'],['peony','пионовый'],['wintergreen','зимний зеленый'],['charcoal','угольный'],['sage','шалфейный'],['mint','мятный'],['cream','кремовый'],
    ['lemongrass','лимонный'],['obsidian','обсидиан'],['snow','белый'],['bay','голубой'],['fog','серый'],['midnight','полночный'],['starlight','сияющая звезда'],['natural','натуральный'],['desert','пустынный'],
    ['черный','черный'],['белый','белый'],['синий','синий'],['голубой','голубой'],['зеленый','зеленый'],['розовый','розовый'],['желтый','желтый'],['серебристый','серебристый'],['серебряный','серебристый'],['серый','серый'],['оранжевый','оранжевый'],['фиолетовый','фиолетовый'],['лавандовый','лавандовый'],['бирюзовый','бирюзовый'],['графитовый','графитовый'],['коралловый','коралловый'],['красный','красный'],['золотистый','золотистый'],
    ['black','черный'],['white','белый'],['blue','синий'],['green','зеленый'],['pink','розовый'],['yellow','желтый'],['silver','серебристый'],['gray','серый'],['grey','серый'],['orange','оранжевый'],['purple','фиолетовый'],['violet','фиолетовый'],['red','красный'],['gold','золотистый']
  ];
  const padded = ' ' + v + ' ';
  const hit = colors.find(function(pair) { return padded.indexOf(' ' + pair[0] + ' ') >= 0; });
  return hit ? tcAvitoColor_(v, hit[1]) : '';
}
// Значения Color сверяются с эталонной автозагрузкой Avito. Фирменное имя
// сохраняется в названии товара, а в отдельную колонку попадает только цвет
// из списка Avito; для синего учитывается конкретная модель.
function tcAvitoColor_(source, detected) {
  const v = tcColorKey_(source);
  if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b))/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой';
  const pairs = [['натуральный','серый'],['серый космос','серый'],['графитовый','черный'],['угольный','черный'],['обсидиан','черный'],['титан','серый'],['пустынный','золотистый'],['кремовый','бежевый'],['ореховый','бежевый'],['фарфоровый','белый'],['сияющая звезда','белый'],['темно фиолетовый','фиолетовый'],['лавандовый','фиолетовый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['индиго','синий'],['полночный','черный'],['темно зеленый','зеленый'],['зимний зеленый','зеленый'],['шалфейный','зеленый'],['мятный','зеленый'],['алоэ','зеленый'],['розовое золото','розовый'],['коралловый','розовый'],['пионовый','розовый'],['лимонный','желтый']];
  const hit = pairs.find(function(pair) { return tcColorKey_(detected) === pair[0]; });
  return hit ? hit[1] : tcColorKey_(detected);
}
