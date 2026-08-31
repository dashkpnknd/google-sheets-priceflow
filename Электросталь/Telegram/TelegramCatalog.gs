/**
 * Telegram supplier → catalogue.
 * A separate product: it treats the public supplier channel as the source of
 * truth and rebuilds rows in the existing client tabs without changing style.
 */
const TC = {
  sheets: ['телефоны', 'макбуки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон', 'аймаки'],
  everyMinutes: 15,
  // @astoredirect is the supplier's showcase. Its linked price feed publishes
  // the actual parsable text catalogue, so this is the default source.
  defaultChannel: 'astoredirectprice',
  // Fixed Elektrostal Avito workbook. Only Price is changed in these existing tabs.
  avito: { spreadsheetId: '19Kj6HeZphLA-AgfpSKrKzn3rT1GwWSLAhd0GxCfpCPs', headerRow: 2, firstDataRow: 3, sheets: {
    'телефоны': { sheetId: 838348454, kind: 'phone' }, 'макбуки': { sheetId: 539164146, kind: 'title' },
    'айпады': { sheetId: 1754463282, kind: 'title' }, 'часы': { sheetId: 1224239507, kind: 'title' },
    'наушники': { sheetId: 1413308519, kind: 'title' }, 'пс': { sheetId: 391955201, kind: 'title' },
    'дайсон': { sheetId: 714982435, kind: 'title' }
  } },
  props: { project: 'ES_TC_PROJECT', channel: 'ES_TC_CHANNEL', last: 'ES_TC_LAST', status: 'ES_TC_STATUS' }
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
    project: p.getProperty(TC.props.project) || '', channel: p.getProperty(TC.props.channel) || TC.defaultChannel,
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { rows: 0, written: 0, skippedSheets: [] };
  try {
    const p = PropertiesService.getScriptProperties(), channel = p.getProperty(TC.props.channel);
    if (!channel) throw new Error('Сначала подключите публичный Telegram-канал.');
    // The complete confirmed current supplier feed is the catalogue.  The
    // sole city-wide product exclusion is iPhone 13/14 in markup below; do
    // not remove current iPhone 15/16/17 based on a supplier label.
    // Special-condition stock is excluded before any city price calculation
    // or catalogue write, not merely before the Avito stage.
    const sourceRows = tcFetchRows_(channel).filter(tcAvitoEligible_);
    // Remember which source sections were actually received before project
    // exclusions. This lets an intentionally empty section clear old prices,
    // while a Telegram/source failure still leaves the existing tab intact.
    const observedCategories = {};
    sourceRows.forEach(function(row) { observedCategories[row.category] = true; });
    // Электросталь: сохраняем все позиции поставщика. Выбор самого дешёвого
    // варианта по странам — локальное правило Ульяновска и здесь не применяется.
    const markup = tcApplyElektrostalMarkup_(sourceRows);
    const rows = markup.rows, book = SpreadsheetApp.getActiveSpreadsheet();
    const byCategory = {};
    rows.forEach(function(row) { (byCategory[row.category] = byCategory[row.category] || []).push(row); });
    let written = 0; const skippedSheets = [];
    TC.sheets.forEach(function(name) {
      const entries = byCategory[name] || [], sheet = book.getSheetByName(name);
      // Never clear a customer tab when the channel did not yield this category:
      // a temporary parsing/source failure must not erase a catalogue.
      if (!entries.length && !observedCategories[name]) { skippedSheets.push(name); return; }
      if (!sheet) throw new Error('Нет листа «' + name + '» в стандартной таблице.');
      written += tcWriteSheet_(sheet, entries);
    });
    // The catalogue tabs are the contract between the two stages.  Flush the
    // just-written, marked-up catalogue and read it back before touching
    // Avito, so a Telegram parsing representation can never diverge from the
    // actual price source used by the client.
    SpreadsheetApp.flush();
    const priceSync = tcSyncAvitoPrices_(tcReadReadyCatalog_(book));
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return {
      rows: rows.length, written: written,
      cheapest: 0, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
      excluded: markup.excluded,
      skippedSheets: skippedSheets, priceSync: priceSync
    };
  } finally { lock.releaseLock(); }
}

/** Reads the ready, marked-up catalogue instead of reparsing Telegram. */
function tcReadReadyCatalog_(book) {
  const ready = { rows: [], available: {} };
  Object.keys(TC.avito.sheets).forEach(function(category) {
    const sheet = book.getSheetByName(category);
    if (!sheet) throw new Error('Нет готового листа «' + category + '» для синхронизации Avito.');
    const width = sheet.getLastColumn(), headers = sheet.getRange(1, 1, 1, width).getValues()[0];
    tcValidateSchema_(sheet, headers);
    const layouts = tcLayouts_(headers);
    const height = Math.max(sheet.getLastRow() - 1, 0), values = height ? sheet.getRange(2, 1, height, width).getValues() : [];
    layouts.forEach(function(layout) {
      values.forEach(function(row) {
        const price = Number(row[layout.priceColumn] || 0);
        if (!price) return;
        if (category === 'телефоны') {
          const phone = { model:row[layout.model], memory:row[layout.memory], color:row[layout.color], sim:row[layout.sim], ram:row[layout.ram] };
          if (tcAvitoPhoneKey_(phone)) ready.rows.push({ category:category, phone:phone, price:price });
        } else {
          const title = String(row[layout.title] || '').trim();
          // ASIS/CPO/active/discount stock is not an alternative price for a
          // normal Avito listing.  It must never participate in the cheapest
          // price calculation for any category, not only telephones.
          if (title && tcAvitoEligible_({ category:category, name:title })) {
            ready.rows.push({ category:category, name:title, price:price });
          }
        }
      });
    });
    // A present but empty source tab is authoritative: all listings in this
    // category must be stopped.  A missing tab aborts above instead of making
    // a destructive guess.
    ready.available[category] = true;
  });
  return ready;
}

function tcAvitoEligible_(row) {
  if (!row) return false;
  // Special-condition stock is never used as a source price for ordinary
  // Avito listings.  This applies to every category: phones, MacBooks,
  // iPads, watches, consoles, accessories and Dyson.
  return !tcHasSpecialCondition_(tcDisplay_(row));
}

function tcHasSpecialCondition_(value) {
  const text = tcNorm_(value).replace(/[\u2010-\u2015]/g, '-');
  // "Актив" means a current sellable offer in this supplier's price list;
  // it is deliberately not a special condition.
  return /(?:(?:^|[^a-zа-я])(?:asis|асис|cpo|цпо|open[-\s]*box|refurb(?:ished)?|витрин(?:а|ный)|демо(?:\s*образец)?|уцен(?:ка|енный)|пред\s*актив)(?=$|[^a-zа-я])|мят(?:ая|ый)\s*(?:коробк|упаковк|📦)|(?:вскрыт|поврежд)[а-яё]*\s*(?:коробк|упаковк))/.test(text);
}

// Backward-compatible name for any external code that called the old helper.
function tcAvitoEligiblePhone_(row) {
  return Boolean(row && row.category === 'телефоны' && tcAvitoEligible_(row));
}

/** Updates only Price in every existing Avito tab. DateEnd is never changed. */
function tcSyncAvitoPrices_(ready) {
  const products = ready.rows, book = SpreadsheetApp.openById(TC.avito.spreadsheetId), report = { at: new Date().toISOString(), sourceRows: products.length, sheets: {} };
  Object.keys(TC.avito.sheets).forEach(function(category) {
    if (!ready.available[category]) { report.sheets[category] = { skipped:'Нет готового листа-источника' }; return; }
    const target = TC.avito.sheets[category], sheet = book.getSheets().find(function(item) { return item.getSheetId() === target.sheetId; });
    if (!sheet) throw new Error('Не найден лист объявлений Электростали для категории «' + category + '».');
    const width = sheet.getLastColumn(), headers = sheet.getRange(TC.avito.headerRow, 1, 1, width).getValues()[0];
    const layout = target.kind === 'phone' ? tcAvitoLayout_(headers) : tcAvitoTitleLayout_(headers);
    if (!layout) throw new Error('Неверная шапка листа объявлений Электростали «' + sheet.getName() + '»: нужны ' + (target.kind === 'phone' ? 'Model, MemorySize, Color, SimConfig, RamSize и Price.' : 'Title и Price.'));
    const height = Math.max(sheet.getLastRow() - TC.avito.headerRow, 0), values = height ? sheet.getRange(TC.avito.firstDataRow, 1, height, width).getValues() : [];
    const plan = target.kind === 'phone' ? tcAvitoPricePlan_(products, layout, values) : tcAvitoTitlePricePlan_(products, category, layout, values);
    tcWriteAvitoPrices_(sheet, layout.price, plan.updates);
    report.sheets[category] = { matched:plan.matched, updated:plan.updates.length, cleared:plan.cleared, missing:plan.missing.slice(0, 200), ambiguous:plan.ambiguous.slice(0, 200) };
  });
  PropertiesService.getScriptProperties().setProperty('ES_TC_LAST_PRICE_REPORT', JSON.stringify({ at:report.at, sourceRows:report.sourceRows, sheets:report.sheets }));
  return report;
}
function tcAvitoLayout_(headers) {
  const index = {}; headers.forEach(function(value, column) { index[tcAvitoHeaderKey_(value)] = column; });
  const required = ['model', 'memorysize', 'color', 'simconfig', 'ramsize', 'price'];
  return required.every(function(name) { return index[name] >= 0; }) ? { model:index.model, memory:index.memorysize, color:index.color, sim:index.simconfig, ram:index.ramsize, price:index.price } : null;
}
function tcAvitoPricePlan_(products, layout, rows) {
  const source = tcAvitoSourceIndex_(products), updates = [], missing = [], ambiguous = []; let matched = 0, cleared = 0;
  rows.forEach(function(row, rowIndex) {
    const phone = { model:row[layout.model], memory:row[layout.memory], color:row[layout.color], sim:row[layout.sim], ram:row[layout.ram] };
    // A technical blank / "Не знаю" is not a restriction.  Only an unknown
    // model is unsafe: no candidate is then selected.
    if (tcAvitoUnknown_(phone.model)) { missing.push(tcAvitoLabel_(row, layout) + ' (неизвестная модель)'); if (row[layout.price] !== '') { updates.push({ row:rowIndex, price:'' }); cleared++; } return; }
    const key = tcAvitoPhoneKey_(phone);
    const fallback = tcAvitoCheapestPhoneFallback_(source.phones, phone);
    const price = (fallback && fallback.price) || (key && source.prices[key]);
    if (!price) { missing.push(tcAvitoLabel_(row, layout)); if (row[layout.price] !== '') { updates.push({ row:rowIndex, price:'' }); cleared++; } return; }
    matched++; if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price });
  });
  return { updates:updates, matched:matched, cleared:cleared, missing:missing, ambiguous:ambiguous };
}
function tcAvitoSourceIndex_(products) {
  const prices = {}, conflicts = {}, phones = [];
  products.filter(function(product) { return product.category === 'телефоны' && Number(product.price) > 0; }).forEach(function(product) {
    const phone = product.phone || tcPhone_(tcDisplay_(product)), key = tcAvitoPhoneKey_(phone);
    const price = Number(product.price);
    if (tcAvitoUnknown_(phone.model)) return;
    phones.push({ model:phone.model, memory:phone.memory, color:phone.color, sim:phone.config || phone.sim || 'Не знаю', ram:phone.ram, price:price });
    if (!key) return;
    prices[key] = prices[key] ? Math.min(prices[key], price) : price;
  }); return { prices:prices, conflicts:conflicts, phones:phones };
}
function tcAvitoSimKey_(value) {
  const text = tcNorm_(value).replace(/[\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === 'не знаю') return 'не знаю';
  if (/\b(?:2\s*sim|2\s*сим|dual\s*sim)\b/.test(text)) return '2 sim';
  if (/\bsim\s*\+\s*e\s*sim\b/.test(text)) return 'sim + esim';
  if (/\b(?:только\s*)?e\s*sim\b/.test(text)) return 'esim';
  return text;
}
function tcAvitoPhoneKey_(phone) {
  const model = tcNorm_(phone.model), memory = tcNorm_(phone.memory), color = tcNorm_(phone.color), sim = tcAvitoSimKey_(phone.config || phone.sim || 'Не знаю'), ram = tcNorm_(phone.ram);
  if (!model || !memory || !color) return '';
  return [model, memory, color, sim, model.indexOf('iphone ') === 0 ? '' : ram].join('|');
}
function tcAvitoUnknown_(value) { const text = tcNorm_(value); return !text || text === 'не знаю' || text === 'n/a' || text === 'unknown'; }
function tcAvitoRelaxedPhoneKey_(phone) {
  const model = tcNorm_(phone.model), memory = tcNorm_(phone.memory), ram = tcNorm_(phone.ram);
  if (!model || !memory) return ''; return [model, memory, /^iphone\b/.test(model) ? '' : ram].join('|');
}
// Fallback is permitted only when the supplier left colour or SIM unknown.
// A declared `2 SIM` must never update an eSIM listing, and vice versa.
function tcAvitoSafePhoneFallback_(phones, target) { return tcAvitoCheapestPhoneFallback_(phones, target); }
function tcAvitoLabel_(row, layout) { return [row[layout.model], row[layout.memory], row[layout.color], row[layout.sim], row[layout.ram]].map(String).join(' | '); }
function tcAvitoHeaderKey_(value) {
  const key = tcNorm_(value).replace(/\s+/g, ' ');
  const aliases = { 'модель':'model', 'встроенная память':'memorysize', 'память':'memorysize', 'цвет':'color', 'sim конфигурация':'simconfig', 'сим конфигурация':'simconfig', 'оперативная память':'ramsize', 'озу':'ramsize', 'цена':'price', 'цена продажи':'price', 'актуальная цена':'price', 'заголовок объявления':'title', 'наименование':'title', 'товар':'title' };
  return aliases[key] || key.replace(/\s+/g, '');
}
function tcAvitoTitleLayout_(headers) { const index = {}; headers.forEach(function(value, column) { index[tcAvitoHeaderKey_(value)] = column; }); return index.title >= 0 && index.price >= 0 ? { title:index.title, price:index.price } : null; }
function tcAvitoCheapestPhoneFallback_(phones, target) {
  const model = tcNorm_(target.model), memory = tcNorm_(target.memory), color = tcNorm_(target.color), sim = tcAvitoSimKey_(target.sim || target.config || 'Не знаю'), ram = tcNorm_(target.ram);
  if (tcAvitoUnknown_(model)) return null;
  const unknown = tcAvitoUnknown_;
  const targetUnknownMemory = unknown(memory), targetUnknownColor = unknown(color), targetUnknownRam = unknown(ram);
  const candidates = phones.filter(function(phone) {
    const iphone = model.indexOf('iphone ') === 0;
    const targetColor = tcNorm_(target.color), sourceColor = tcNorm_(phone.color);
    return tcNorm_(phone.model) === model &&
      (targetUnknownMemory || tcNorm_(phone.memory) === memory) &&
      // A filled iPhone colour is exact. Android uses the approved Avito
      // colour groups; SIM and country deliberately remain irrelevant.
      (targetUnknownColor || (iphone ? sourceColor === targetColor : tcAndroidColorGroup_(sourceColor) === tcAndroidColorGroup_(targetColor))) &&
      (iphone || targetUnknownRam || tcNorm_(phone.ram) === ram);
  });
  const prices = Array.from(new Set(candidates.map(function(item) { return Number(item.price); }).filter(Boolean)));
  // SIM and country are not product identity constraints for this city.
  return prices.length ? { price:Math.min.apply(null, prices), rule:'elektrostal-phone-identity' } : null;
}
function tcAndroidColorGroup_(value) {
  const v = tcNorm_(value).replace(/ё/g, 'е');
  if (/blue|син|голуб|ultramarine|indigo|bay/.test(v)) return 'blue';
  if (/black|черн|graphite|obsidian|charcoal/.test(v)) return 'black';
  if (/white|бел|snow|porcelain|cream/.test(v)) return 'white';
  if (/green|зелен|mint|sage|aloe/.test(v)) return 'green';
  if (/purple|фиолет|lavender|violet/.test(v)) return 'purple';
  if (/pink|розов|peony/.test(v)) return 'pink';
  if (/gray|grey|сер|silver|сереб/.test(v)) return 'gray';
  return v;
}
function tcAvitoTitlePricePlan_(products, category, layout, rows) {
  const source = tcAvitoTitleSourceIndex_(products, category), updates = [], missing = [], ambiguous = []; let matched = 0, cleared = 0;
  rows.forEach(function(row, rowIndex) {
    const title = String(row[layout.title] || ''), key = tcAvitoTitleKey_(title); if (!key) return;
    const strictMacbook = tcAvitoStrictMacbookFallback_(source.items, category, title);
    const fallback = strictMacbook || (source.prices[key] ? null : (tcAvitoUnknownSimTitleFallback_(source.items, category, title) || tcAvitoCheapestTitleFallback_(source.items, category, title)));
    const price = (fallback && fallback.price) || source.prices[key];
    if (!price) { missing.push(title); if (row[layout.price] !== '') { updates.push({ row:rowIndex, price:'' }); cleared++; } return; }
    matched++; if (Number(row[layout.price]) !== price) updates.push({ row:rowIndex, price:price });
  });
  return { updates:updates, matched:matched, cleared:cleared, missing:missing, ambiguous:ambiguous };
}
function tcAvitoTitleSourceIndex_(products, category) { const prices = {}, items = []; products.filter(function(product) { return product.category === category && Number(product.price) > 0 && tcAvitoEligibleTitle_(tcDisplay_(product)); }).forEach(function(product) { const title = tcDisplay_(product), key = tcAvitoTitleKey_(title), price = Number(product.price); if (!key) return; items.push({ title:title, price:price }); prices[key] = prices[key] ? Math.min(prices[key], price) : price; }); return { prices:prices, items:items }; }
function tcAvitoEligibleTitle_(value) {
  return !tcHasSpecialCondition_(value);
}
function tcAvitoStrictMacbookFallback_(items, category, targetTitle) {
  if (category !== 'макбуки') return null;
  const targetKey = tcAvitoMacbookKey_(targetTitle);
  if (!targetKey) return null;
  const prices = items.filter(function(item) { return tcAvitoMacbookKey_(item.title) === targetKey; })
    .map(function(item) { return Number(item.price); }).filter(Boolean);
  return prices.length ? { price:Math.min.apply(null, prices), rule:'strict-macbook-key' } : null;
}
function tcAvitoMacbookKey_(value) {
  const text = String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const family = /macbook\s+(?:\d+\s+)?neo\b/.test(text) ? 'neo' : /macbook\s+air\b/.test(text) ? 'air' : /macbook\s+pro\b/.test(text) ? 'pro' : '';
  const chip = /\bm\s*(\d+)\b/i.exec(text);
  const config = tcAvitoMacbookConfig_(text);
  if (!family || !chip || !config) return '';
  const screen = /\b(13|14|15|16)\s*(?:[″”\"]|inch|дюйм)?\b/.exec(text);
  // Product names for Neo may omit its 13-inch display; do not invent it.
  if (!screen) return '';
  return [family, screen[1], 'm' + chip[1], config].join('|');
}
function tcAvitoMacbookConfig_(value) {
  const compact = String(value || '').replace(/\s+/g, ' ');
  let match = /\b(8|16|24|32|36|48|64)\s*(?:\/|gb\s*\/|гб\s*\/|gb\s+|гб\s+)(256|512|1024|2048|1|2)\s*(gb|гб|tb|тб)?\b/i.exec(compact);
  if (!match) return '';
  const ram = match[1], storage = Number(match[2]), tb = /^(tb|тб)$/i.test(match[3] || '') || storage === 1024 || storage === 2048;
  return ram + 'x' + (storage === 1024 ? '1' : storage === 2048 ? '2' : String(storage)) + (tb ? 'tb' : 'gb');
}
function tcAvitoUnknownSimTitleFallback_(items, category, targetTitle) {
  if (!tcAvitoHasUnknownTitleConfig_(targetTitle)) return null;
  const targetKey = tcAvitoTitleWithoutConnectivityKey_(targetTitle);
  if (!targetKey) return null;
  const prices = items.filter(function(item) {
    return (!item.category || item.category === category) && tcAvitoTitleWithoutConnectivityKey_(item.title) === targetKey;
  }).map(function(item) { return Number(item.price); }).filter(Boolean);
  return prices.length ? { price:Math.min.apply(null, prices), rule:'target-unknown-connectivity' } : null;
}
function tcAvitoTitleWithoutConnectivityKey_(value) {
  return tcAvitoTitleKey_(String(value || '')
    .replace(/\bwi[\s\-\u2010-\u2015\u2011]?fi\b/giu, ' ')
    .replace(/\b(?:lte|cellular)\b/giu, ' ')
    .replace(/(?:^|[^\p{L}\p{N}])(?:не\s+знаю|unknown)(?=$|[^\p{L}\p{N}])/giu, ' '));
}
function tcAvitoHasUnknownTitleConfig_(value) {
  return /(?:^|[^\p{L}\p{N}])(?:не\s+знаю|unknown)(?=$|[^\p{L}\p{N}])/iu.test(String(value || ''));
}
function tcAvitoTitleKey_(value) {
  let text = String(value || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
    .replace(/\((?:актив|уценка|active)\)|\b(?:актив|уценка|active)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b(?!\s*(?:гб|gb|тб|tb))/giu, '')
    .replace(/\bapple\b/gi, '')
    // "Не знаю" is a technical placeholder in existing Avito rows, not a
    // sellable iPad/MacBook/etc. configuration.  Keep real Wi-Fi/LTE terms
    // below: they remain part of the SKU and are checked for conflicts.
    .replace(/(?:^|[^\p{L}\p{N}])(?:не\s+знаю|unknown)(?=$|[^\p{L}\p{N}])/giu, ' ')
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:тб|tb)(?=$|[^\p{L}\p{N}])/giu, function(_, amount) { return String(Math.round(Number(String(amount).replace(',', '.')) * 1024)) + ' gb'; })
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:гб|gb)(?=$|[^\p{L}\p{N}])/giu, '$1 gb')
    .replace(/wi[\s\-\u2010-\u2015\u2011]?fi/gi, 'wifi').replace(/e[\s\-\u2010-\u2015\u2011]?sim/gi, 'esim')
    .replace(/space\s+gray/gi, 'spacegray').replace(/space\s+black/gi, 'black')
    .replace(/[()\[\],.;:/|+]+/g, ' ').toLocaleLowerCase('ru-RU');
  return text.split(/\s+/).filter(Boolean).sort().join('|');
}
function tcAvitoCheapestTitleFallback_(items, category, targetTitle) {
  const candidates = items.map(function(item) { return { title:item.title, price:item.price, score:tcAvitoTitleScore_(category, targetTitle, item.title) }; }).filter(function(item) { return tcAvitoRequiredTitleMatch_(category, targetTitle, item.title); });
  if (!candidates.length) return null;
  return { price:Math.min.apply(null, candidates.map(function(item) { return Number(item.price); }).filter(Boolean)), score:Math.max.apply(null, candidates.map(function(item) { return item.score; })) };
}
function tcAvitoRequiredTitleMatch_(category, targetTitle, candidateTitle) {
  if (category === 'пс') return tcAvitoPlaystationMatches_(targetTitle, candidateTitle);
  if (category === 'дайсон') return tcAvitoDysonMatches_(targetTitle, candidateTitle);
  if (category === 'наушники' && tcAvitoAirPodsIdentity_(targetTitle).family === 'max') return tcAvitoAirPodsIdentity_(candidateTitle).family === 'max' && tcAvitoAirPodsIdentity_(candidateTitle).generation === tcAvitoAirPodsIdentity_(targetTitle).generation;
  const required = tcAvitoRequiredTitleTokens_(category, targetTitle), candidate = tcAvitoTitleWords_(candidateTitle);
  if (!required.every(function(token) { return candidate.indexOf(token) >= 0; })) return false;
  const target = String(targetTitle || ''), source = String(candidateTitle || '');
  if (category === 'наушники') return tcAvitoAirPodsIdentity_(target).key === tcAvitoAirPodsIdentity_(source).key && tcAvitoHasAnc_(target) === tcAvitoHasAnc_(source);
  if (category === 'часы') return tcAvitoWatchMatches_(target, source);
  if (/dualsense/i.test(target)) return /\bedge\b/i.test(target) === /\bedge\b/i.test(source);
  return true;
}
function tcAvitoDysonKey_(value) { const text = tcNorm_(value); if (/on\s*trac/.test(text)) return 'ontrac'; const hit = /\b(hs|hd|ht)\s*(\d{2})\b/i.exec(text); return hit ? hit[1].toLowerCase() + hit[2] : ''; }
function tcAvitoDysonMatches_(left, right) { const a = tcAvitoDysonKey_(left), b = tcAvitoDysonKey_(right); return Boolean(a && b && a === b); }
function tcAvitoAirPodsIdentity_(value) { const text = tcNorm_(value); if (/airpods\s+max/.test(text)) return { family:'max', generation:/\b(?:2\s+)?2026\b/.test(text) ? '2026' : '' , key:'max:' + (/\b(?:2\s+)?2026\b/.test(text) ? '2026' : '') }; const pro = /airpods\s+pro\s*(\d*)/.exec(text); if (pro) return { family:'pro', generation:pro[1] || '1', key:'pro:' + (pro[1] || '1') }; const base = /airpods\s*(\d+)/.exec(text); return { family:base ? 'airpods' : '', generation:base ? base[1] : '', key:base ? 'airpods:' + base[1] : '' }; }
function tcAvitoWatchMatches_(left, right) {
  const pick = function(value, pattern) { const hit = pattern.exec(tcNorm_(value)); return hit ? hit[1] : ''; };
  const optional = [/(?:case|корпус)\s*(?:color)?\s*(black|white|blue|silver|gold|black|черный|белый|синий|серебристый|золотистый)/i, /(?:band|ремешок)\s*(?:type)?\s*(ocean|sport|milanese|trail|loop|rubber|океан|спорт|милан)/i];
  return optional.every(function(pattern) { const a = pick(left, pattern), b = pick(right, pattern); return !a || a === b; });
}
function tcAvitoPlaystationIdentity_(value) {
  const text = tcNorm_(value).replace(/playstation/g, 'ps');
  if (/dual\s*sense/.test(text)) return { family:/charg(?:ing|er)?\b|\bdock\b|\bstand\b|\bstation\b|заряд|док|подстав/.test(text) ? 'dualsense-accessory' : 'dualsense', edge:/\bedge\b/.test(text) };
  const generation = /\bps\s*([345])\b/.exec(text); if (!generation) return null;
  const form = /\bpro\b/.test(text) ? 'pro' : /\bslim\b/.test(text) ? 'slim' : 'standard';
  const media = /\bdigital\b/.test(text) ? 'digital' : /\b(?:disc|disk|diskdrive)\b|диск(?:овод\w*|ов\w*)?/i.test(text) ? 'disc' : '';
  const memory = /\b(825|1000|1024|2000|2048)\s*(?:gb|гб)|\b([12])\s*(?:tb|тб)\b/i.exec(text);
  return { family:'ps' + generation[1], form:form, media:media, memory:memory ? Number(memory[1] || Number(memory[2]) * 1024) : 0 };
}
function tcAvitoPlaystationMatches_(targetTitle, candidateTitle) {
  const target = tcAvitoPlaystationIdentity_(targetTitle), candidate = tcAvitoPlaystationIdentity_(candidateTitle);
  if (!target || !candidate || target.family !== candidate.family) return false;
  if (target.family === 'dualsense') return candidate.family === 'dualsense' && (!target.edge || candidate.edge);
  if ((target.form === 'standard' && !target.media && !target.memory) || (target.form === 'slim' && !target.media && !target.memory)) return false;
  const media = target.media || (target.form === 'slim' && target.memory ? 'disc' : '');
  return target.form === candidate.form && (!media || media === candidate.media) && (!target.memory || target.memory === candidate.memory);
}
function tcAvitoRequiredTitleTokens_(category, value) {
  const words = tcAvitoTitleWords_(value);
  const take = function(pattern) { return words.filter(function(word) { return pattern.test(word); }); };
  if (category === 'айпады') return take(/^(?:ipad|air|pro|mini|(?:m|a)\d+|\d+(?:gb|tb)|11|13|nano|texture)$/);
  if (category === 'макбуки') return take(/^(?:macbook|air|pro|neo|m\d+|\d+x\d+(?:gb|tb)|13|14|15|16)$/);
  if (category === 'часы') return take(/^(?:watch|(?:se|ultra|s)\d+|\d+mm)$/);
  if (category === 'дайсон') return take(/^(?:hs|hd|ht)\d+$/);
  if (category === 'пс') return take(/^(?:ps\d|slim|pro|digital|disc|\d+(?:gb|tb))$/);
  if (category === 'наушники') return take(/^(?:airpods\d+|pro\d+|airpodsmax\d+|max)$/);
  return take(/^(?:dualsense)$/);
}
function tcAvitoHasAnc_(value) { return /\banc\b|шумоподав/i.test(String(value || '')); }
function tcAvitoTitleScore_(category, left, right) {
  const a = tcAvitoTitleWords_(left), b = tcAvitoTitleWords_(right);
  if (!a.length || !b.length || tcAvitoFamilyConflict_(category, left, right) || tcAvitoColorConflict_(left, right) || tcAvitoHardwareConflict_(category, a, b)) return 0;
  const set = {}; a.forEach(function(word) { set[word] = true; });
  const shared = b.filter(function(word) { return set[word]; }).length;
  return shared / Math.max(a.length, b.length);
}
function tcAvitoTitleWords_(value) {
  const ignored = { apple:true, samsung:true, sony:true, стайлер:true, гарантия:true, рассрочка:true, active:true, актив:true, уценка:true, новый:true, оригинал:true, товар:true, sale:true, loop:true, milanese:true, wifi:true, не:true, знаю:true, unknown:true };
  const text = String(value || '').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .replace(/ipad\s+(\d+)\s+mini/g, 'ipad mini $1').replace(/apple\s+watch\s+(?:series\s+)?(se|ultra)\s+(\d+)/g, 'watch $1$2').replace(/apple\s+watch\s+series\s+(\d+)/g, 'watch s$1')
    .replace(/playstation/g, 'ps').replace(/\bps\s+(\d)\b/g, 'ps$1').replace(/airpods\s+pro\s+(\d+)/g, 'airpods pro$1').replace(/airpods\s+(\d+)\b/g, 'airpods$1').replace(/\b([hsdt])\s*(\d{2})\b/g, '$1$2')
    .replace(/(\d+)\s*\/\s*(\d+)(?:\s*(gb|гб|tb|тб))?/g, tcAvitoRamStorageWord_)
    .replace(/\b(8|16|24|32|36|48|64)\s*(?:gb|гб)\s+(256|512|1024|2048|1|2)\s*(gb|гб|tb|тб)\b/gi, tcAvitoRamStorageWord_)
    .replace(/\b1024\s*(?:gb|гб)\b/gi, '1tb').replace(/\b2048\s*(?:gb|гб)\b/gi, '2tb')
    .replace(/(\d+)\s*(?:gb|гб)/g, '$1gb').replace(/(\d+)\s*(?:tb|тб)/g, '$1tb')
    .replace(/(\d+)\s*mm\b/g, '$1mm').replace(/wi[\s\-\u2010-\u2015\u2011]*fi/g, 'wifi').replace(/[()\[\],.;:+/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(new Set(text.split(' ').filter(function(word) { return (word.length > 1 || /^\d{1,2}$/.test(word)) && !ignored[word] && !/^\d{4}$/.test(word) && !/^[a-zа-я]{1,2}\d{3,}[a-zа-я0-9-]*$/i.test(word); })));
}
function tcAvitoRamStorageWord_(all, ram, storage, unit) {
  const amount = Number(storage), isTb = /^(tb|тб)$/i.test(unit || '') || amount === 1024 || amount === 2048;
  return String(ram) + 'x' + (amount === 1024 ? '1' : amount === 2048 ? '2' : storage) + (isTb ? 'tb' : 'gb');
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
  if (category === 'айпады' && (differs(/^m\d+$/) || differs(/^a\d+$/) || differs(/^\d+(?:gb|tb)$/) || onlyOneHas('nano') || onlyOneHas('texture'))) return true;
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
function tcWriteAvitoPrices_(sheet, priceColumn, updates) { updates.sort(function(a, b) { return a.row - b.row; }); for (let start = 0; start < updates.length;) { let end = start + 1; while (end < updates.length && updates[end].row === updates[end - 1].row + 1) end++; sheet.getRange(TC.avito.firstDataRow + updates[start].row, priceColumn + 1, end - start, 1).setValues(updates.slice(start, end).map(function(item) { return [item.price]; })); start = end; } }
function tcWriteAvitoDates_(sheet, dateColumn, updates) { updates.sort(function(a, b) { return a.row - b.row; }); for (let start = 0; start < updates.length;) { let end = start + 1; while (end < updates.length && updates[end].row === updates[end - 1].row + 1) end++; sheet.getRange(TC.avito.firstDataRow + updates[start].row, dateColumn + 1, end - start, 1).setValues(updates.slice(start, end).map(function(item) { return [item.value]; })).setNumberFormat('dd.MM.yyyy'); start = end; } }
function tcAvitoDateIsPast_(value) { if (value instanceof Date && !isNaN(value)) return value.getTime() < new Date().setHours(0, 0, 0, 0); const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(value || '').trim()); return match ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime() < new Date().setHours(0, 0, 0, 0) : false; }
function tcAvitoStopDate_() { const date = new Date(); date.setDate(date.getDate() - 1); date.setHours(0, 0, 0, 0); return date; }
function tcAvitoActiveEndDate_() { const date = new Date(); date.setDate(date.getDate() + 30); date.setHours(0, 0, 0, 0); return date; }

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
  if (product.category === 'телефоны') {
    const name = String(product.name || '').replace(/^\s*[•·▪◦\-]+\s*/, '').replace(/^\s*\((?:актив|уценка|active)\)\s*/i, '');
    return /^iphone\b/i.test(name) ? 0 : layouts.length - 1;
  }
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
  const markedUp = Number(result.markedUp || 0);
  const withoutMarkup = Number(result.withoutMarkup || 0);
  const excluded = Number(result.excluded || 0);
  return 'Каталог получен: ' + result.rows + ' позиций. Записано в листы: ' + result.written +
    '. Наценка Электростали применена к ' + markedUp + ' позициям' +
    (withoutMarkup ? '. Без правила наценки: ' + withoutMarkup : '') +
    (excluded ? '. Исключены iPhone 13/14: ' + excluded : '') +
    '. Далее обновляется автоматически каждые 15 минут.';
}
function tcNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
function tcDisplay_(product) { return [product.name, product.variant].filter(Boolean).join(' ').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim(); }

function tcApplyElektrostalMarkup_(rows) {
  let applied = 0, withoutRule = 0, excluded = 0;
  const priced = rows.filter(function(row) {
    if (!tcExcludedElektrostalSku_(row)) return true;
    excluded++;
    return false;
  }).map(function(row) {
    const amount = tcElektrostalMarkupAmount_(row);
    // A supplier cost is never a sell price. Without an explicit city rule
    // the item stays out of the prepared catalogue and therefore Avito.
    if (amount === null) { withoutRule++; return null; }
    applied++;
    const price = Math.ceil((Number(row.price) + amount) / 500) * 500;
    return Object.assign({}, row, { supplierPrice: row.price, markup: amount, price: price });
  }).filter(Boolean);
  return { rows: priced, applied: applied, withoutRule: withoutRule, excluded: excluded };
}

/** Project rule: no iPhone 13/14, including Mini/Plus/Pro/Pro Max, anywhere. */
function tcExcludedElektrostalSku_(row) {
  if (!row || row.category !== 'телефоны') return false;
  return /^iphone\s+(?:13|14)(?:\s|$)/i.test(tcDisplay_(row));
}

function tcElektrostalMarkupAmount_(row) {
  if (!row) return null;
  const price = Number(row.price || 0), name = tcNorm_(tcDisplay_(row));
  if (price < 5000) return null;
  // Only the explicitly approved phone groups have a city markup.  Other
  // product families need their own rule before they can receive a price.
  const apple = /\b(?:iphone|ipad|macbook|imac|apple\s+watch|airpods|apple\s+tv|apple\s+pencil)\b/.test(name);
  const android = /\b(?:samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo)\b/.test(name);
  if (!apple && !(row.category === 'телефоны' && android)) return null;
  // Apple retains its final approved band at every higher price.
  if (apple && price > 225999) return 13000;
  if (!apple && price > 225999) return 15000;
  const bands = apple ? [[15999,3000],[35999,4000],[69999,5000],[89999,6000],[110999,7500],[150999,9000],[225999,13000]] : [[15999,3000],[35999,5000],[69999,7000],[89999,8000],[110999,8500],[150999,10000],[225999,15000]];
  const band = bands.find(function(rule) { return price <= rule[0]; });
  return band ? band[1] : null;
}

function tcFetchRows_(channel) {
  // The current navigation is the supplier's authoritative assortment.  Old
  // historical posts must never revive a SKU after it disappears there.
  const navigationResponse = UrlFetchApp.fetch('https://t.me/s/' + channel, { muteHttpExceptions:true });
  if (navigationResponse.getResponseCode() !== 200) throw new Error('Telegram не открыл навигацию прайса: HTTP ' + navigationResponse.getResponseCode());
  const navigationHtml = navigationResponse.getContentText();
  const postIds = tcNavigationPostIds_(navigationHtml, channel);
  if (!postIds.length) throw new Error('В текущей навигации Telegram не найдены ссылки на прайс. Каталог не изменён.');
  const rows = [];
  postIds.forEach(function(postId) {
    const response = UrlFetchApp.fetch('https://t.me/s/' + channel + '/' + postId, { muteHttpExceptions:true });
    if (response.getResponseCode() !== 200) throw new Error('Telegram не открыл прайс-сообщение ' + postId + ': HTTP ' + response.getResponseCode());
    const postRows = tcParseDirectPost_(response.getContentText(), channel, postId);
    // Navigation also contains section headers and information messages
    // (for example 9561). They are valid current navigation entries but not
    // price sources. A real HTTP/read failure remains fatal; only a cleanly
    // read message with no confirmed price is skipped.
    if (!postRows.length) return;
    rows.push.apply(rows, postRows);
  });
  if (!rows.length) throw new Error('В актуальном прайсе Telegram не найдено ни одной подтверждённой цены. Каталог не изменён.');
  return rows;
}

/** Extracts the permanent price-post IDs from the current pinned navigation. */
function tcNavigationPostIds_(html, channel) {
  const source = String(html || ''), chunks = source.split(/<div class="tgme_widget_message_wrap[^>]*">/i), ids = {}, escaped = String(channel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let index = 1; index < chunks.length; index++) {
    const body = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i.exec(chunks[index]);
    if (!body || !/навигация\s+по\s+прайсу/i.test(tcHtml_(body[1]))) continue;
    const link = new RegExp('(?:https?:)?//t\\.me/' + escaped + '/(\\d+)|/s/' + escaped + '/(\\d+)', 'gi'); let match;
    while ((match = link.exec(chunks[index]))) ids[match[1] || match[2]] = true;
  }
  return Object.keys(ids).map(Number).filter(function(id) { return id > 0; }).sort(function(a, b) { return a - b; });
}

/** A direct Telegram post URL also contains neighbours; parse only its target. */
function tcParseDirectPost_(html, channel, targetPost) {
  const rows = [], chunks = String(html || '').split(/<div class="tgme_widget_message_wrap[^>]*">/i);
  for (let index = 1; index < chunks.length; index++) {
    const post = /data-post="[^/]+\/(\d+)"/i.exec(chunks[index]), body = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i.exec(chunks[index]);
    if (!post || !body || String(post[1]) !== String(targetPost)) continue;
    rows.push.apply(rows, tcParsePost_(tcHtml_(body[1]), channel, post[1]));
  }
  return rows;
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
  // @astoredirectprice publishes whole catalogues as three lines per item:
  // title, configuration, then "1 шт <price> ₽ · 3+ ...". This must be
  // parsed separately from the older one-line "name — price" template.
  // Электросталь использует основную стоимость за одну единицу.
  if (/цена\s+за\s+объём/i.test(text) && lines.some(function(line) { return /^1\s*шт\s+/i.test(line); })) return tcParseVolumePost_(lines, channel, post);
  const rawHeader = lines[0].replace(/^📦\s*/, '');
  const header = rawHeader.replace(/\s*\(часть\s*\d+\/\d+\)\s*$/i, '');
  const section = tcNorm_(rawHeader);
  // Supplier sections may be named just "Google" or "Honor". The models in
  // their rows still identify the correct destination sheet.
  return lines.slice(1).map(function(line) {
    const row = tcLine_(header, line, channel, post);
    return row && Object.assign(row, { section: section });
  })
    .filter(function(row) { return row && TC.sheets.indexOf(row.category) >= 0; });
}

function tcParseVolumePost_(lines, channel, post) {
  const rows = [], header = String(lines[0] || '').replace(/^[^\p{L}\d]*/u, '').trim();
  let previous = '', brand = '', section = tcNorm_(header);
  lines.forEach(function(raw) {
    const line = String(raw).replace(/^[\[\]•·▪◦.\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!line || /^(?:цена\s+за\s+объём|\d+\s*шт\s*[—-]\s*основная|нашли\s+дешевле|актуальные\s+позиции)/i.test(line)) return;
    const price = /^1\s*шт\s+([\d\s.]+)\s*₽/i.exec(line);
    if (price) {
      const name = tcVolumeName_(brand, previous);
      const amount = Number(price[1].replace(/[.\s]/g, ''));
      if (name && amount > 0) rows.push({ category: tcCategory_(name), name: name, variant: '', price: amount, post: post, section: section, url: 'https://t.me/' + channel + '/' + post });
      return;
    }
    previous = line;
    // A title with an explicit Apple brand is a context only; the following
    // configuration line is the actual SKU.
    if (/^Apple\s*[·.]\s*iPhone\s+\d/i.test(line)) { brand = 'iPhone'; section = tcNorm_(line); previous = ''; }
    else if (/^Apple\s*[·.]\s*iPad\b/i.test(line)) { brand = 'iPad'; section = tcNorm_(line); previous = ''; }
    else if (/^Apple\s*[·.]\s*MacBook\b/i.test(line)) { brand = 'MacBook'; section = tcNorm_(line); previous = ''; }
    else if (/^Apple\s*[·.]\s*Apple\s+Watch\b/i.test(line)) { brand = 'Apple Watch'; section = tcNorm_(line); previous = ''; }
    else if (/^iPhone\s+\d/i.test(line)) { brand = 'iPhone'; section = tcNorm_(line); }
    else if (/^iPad\b/i.test(line)) { brand = 'iPad'; section = tcNorm_(line); }
    else if (/^MacBook\b/i.test(line)) { brand = 'MacBook'; section = tcNorm_(line); }
    else if (/^Apple\s+Watch\b/i.test(line)) { brand = 'Apple Watch'; section = tcNorm_(line); }
    // A new non-Apple product begins a new context. Without this reset a
    // later Dyson/Garmin line in one Telegram post inherited "MacBook".
    else if (/^(?:Dyson|Garmin|PlayStation|PS[345]\b|Xbox|Samsung|Galaxy|Pixel|Xiaomi|Redmi|Honor|Huawei|OnePlus|Realme|Oppo|Vivo)\b/i.test(line)) { brand = ''; section = tcNorm_(line); }
  });
  return rows.filter(function(row) { return TC.sheets.indexOf(row.category) >= 0; });
}

function tcVolumeName_(brand, value) {
  const parsed = tcStatus_(String(value || '').replace(/^[\[\]•·▪◦.\s]+/, '').replace(/\s+/g, ' ').trim()), item = parsed.text;
  if (!item) return '';
  if (brand === 'iPhone' && /^\d/.test(item)) return tcWithStatus_(parsed.marks, 'iPhone ' + item);
  // iPad/MacBook/Watch rows already contain their own model family. Do not
  // prepend a stale previous heading to an unrelated line.
  return tcWithStatus_(parsed.marks, item);
}

function tcLine_(header, line, channel, post) {
  const match = /^(.*?)\s*(?:-|—|–)\s*([\d\s.]{3,})\s*(?:₽|руб\.?|rub)?\s*$/i.exec(line);
  if (!match) return null;
  let core = match[1].replace(/^[•·▪◦]\s*/, '').replace(/\s+/g, ' ').trim(), variant = '';
  const suffix = /(\([^)]*\))\s*$/u.exec(core); if (suffix) { variant = suffix[1]; core = core.slice(0, suffix.index).trim(); }
  const flag = /([\u{1F1E6}-\u{1F1FF}]{2})\s*$/u.exec(core); if (flag) { variant = (flag[1] + (variant ? ' ' + variant : '')).trim(); core = core.slice(0, flag.index).trim(); }
  const name = tcExpand_(header, core), price = Number(match[2].replace(/[.\s]/g, ''));
  return name && price > 0 ? { category: tcCategory_(header + ' ' + name), name: name, variant: variant, price: price, post: post, url: 'https://t.me/' + channel + '/' + post } : null;
}

function tcStatus_(value) {
  const source = String(value || ''), marks = [];
  const text = source.replace(/\((active|актив|уценка)\)|(^|\s)(active|актив|уценка)(?=\s|$)/gi, function(_, wrapped, prefix, bare) {
    const key = String(wrapped || bare).toLowerCase();
    marks.push(/active|актив/.test(key) ? '(Актив)' : '(Уценка)');
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  return { marks: marks.join(' '), text: text };
}
function tcWithStatus_(status, text) { return [String(status || '').trim(), String(text || '').trim()].filter(Boolean).join(' ').trim(); }
function tcExpand_(header, item) {
  const hs = tcStatus_(String(header).replace(/\\/g, ' ').trim()), is = tcStatus_(item), h = hs.text, i = is.text, mark = is.marks || hs.marks;
  let expanded = i;
  if (/^iphone\s/i.test(h) && !/^iphone\s/i.test(i)) {
    const model = h.replace(/^iphone\s+/i, '').trim(), repeated = new RegExp('^' + model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)', 'i');
    expanded = h + ' ' + (repeated.test(i) ? i.slice(model.length).trim() : i);
  }
  else if (/^macbook\b/i.test(h) && !/^macbook\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^dyson\b/i.test(h) && !/^dyson\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^airpods\b/i.test(h) && !/^airpods\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^imac\b/i.test(h) && !/^imac\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^watch\b/i.test(h) && /^watch\b/i.test(i)) expanded = 'Apple ' + i;
  return tcWithStatus_(mark, expanded);
}
function tcCategory_(value) {
  const v = tcNorm_(value);
  // Check accessory families before the generic Galaxy/Samsung phone rule.
  // Otherwise Galaxy Buds, Watch and Tab were incorrectly written to phones.
  if (/airpods|galaxy\s*buds|buds\b|наушники|headphones?|гарнитур|колонки/.test(v)) return 'наушники';
  if (/apple\s*watch|galaxy\s*(?:watch|fit|ring)|\bwatch\b|\bfit\b|\bring\b/.test(v)) return 'часы';
  if (/ipad|galaxy\s*tab|(?:xiaomi|redmi|huawei|honor)\s*pad|\btablet\b/.test(v)) return 'айпады';
  if (/galaxy\s+book\b|macbook/.test(v)) return 'макбуки';
  if (/playstation|\bps[345]\b|xbox/.test(v)) return 'пс';
  if (/dyson/.test(v)) return 'дайсон';
  if (/imac/.test(v)) return 'аймаки';
  if (/iphone|galaxy|pixel|xiaomi|samsung|honor|huawei|oneplus|realme|redmi/.test(v)) return 'телефоны';
  return 'прочее';
}
function tcPhone_(value) {
  const text = String(value || ''), specs = /(\d{1,2})\s*\/\s*(\d{2,4})\s*(гб|gb|тб|tb)/i.exec(text);
  const memory = specs ? null : /(?:^|\s)(\d{1,4})\s?(гб|gb|тб|tb)(?=\s|$)/i.exec(text);
  const unit = function(amount, suffix) { return amount + ' ' + suffix.toUpperCase().replace('GB', 'ГБ').replace('TB', 'ТБ'); };
  const sim = /\b(?:2\s*(?:sim|сим)|dual\s*-?\s*sim)\b/i.test(text) ? '2 SIM' : /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : '';
  return { model: tcModel_(text), memory: specs ? unit(specs[2], specs[3]) : memory ? unit(memory[1], memory[2]) : '', ram: specs ? unit(specs[1], 'GB') : '', color: tcColor_(text), config: sim, country: tcCountry_(text) };
}
function tcModel_(value) {
  const text = String(value || '').replace(/\(\s*asis\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  const iphone = /\biphone\s+(\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?)/i.exec(text);
  if (iphone) return 'iPhone ' + iphone[1].replace(/\s+/g, ' ').trim();
  return tcAndroidIdentity_(text);
}
/** Full Android identity: brand/model/modifier and declared radio version. */
function tcAndroidIdentity_(value) {
  let text = tcNorm_(value).replace(/\b\d{1,2}\s*\/\s*\d{2,4}\s*(?:гб|gb|тб|tb)?\b/g, ' ').replace(/\b\d+\s*(?:гб|gb|тб|tb)\b/g, ' ').replace(/\b(?:sim|esim|dual\s*sim)\b/g, ' ');
  text = text.replace(/\b(?:black|white|blue|green|pink|yellow|purple|gray|grey|silver|gold|черный|белый|синий|голубой|зеленый|розовый|фиолетовый|серый|серебристый|золотистый|ultramarine|lavender|graphite|mint|obsidian|lemongrass)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const match = /\b(?:samsung\s+)?galaxy\s+(?:z\s*(?:fold|flip)\s*\d+(?:\s*(?:fe|pro|plus))?|(?:s|a|m)\s*\d+(?:\s*(?:ultra|fe|pro\+?|plus))?)\b|\b(?:xiaomi|redmi|oneplus|pixel|honor|huawei|oppo|realme)\s+[a-z0-9][a-z0-9+\- ]*/i.exec(text);
  if (!match) return '';
  const base = match[0].replace(/\s+/g, ' ').trim();
  const tech = Array.from(new Set((text.match(/\b(?:4g|5g|nfc|lte)\b/g) || []))).sort().join(' ');
  const display = base.replace(/\b(galaxy|pixel|xiaomi|redmi|oneplus|honor|huawei|oppo|realme)\b/g, function(word) { return word.charAt(0).toUpperCase() + word.slice(1); });
  return (display + (tech ? ' ' + tech : '')).trim();
}
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
