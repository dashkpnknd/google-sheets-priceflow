/**
 * Telegram supplier → catalogue.
 * A separate product: it treats the public supplier channel as the source of
 * truth and rebuilds rows in the existing client tabs without changing style.
 */
const TC = {
  version: 'ES-AIRPODS-SET-2026-11-03.8',
  sheets: ['телефоны', 'макбуки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон', 'аймаки'],
  // Five evenly spaced daily runs keep the feed current without exhausting
  // Apps Script UrlFetch (midnight, 05:00, 10:00, 15:00 and 20:00).
  scheduleHours: [0, 5, 10, 15, 20],
  // A complete channel contains hundreds of history pages. Read the newest
  // posts on every run and crawl two older pages in the background instead
  // of spending the daily UrlFetch quota in one run.
  history: { recentPages: 2, backgroundPages: 2, quotaPauseMs: 60 * 60 * 1000 },
  // @astoredirect is the supplier's showcase. Its linked price feed publishes
  // the actual parsable text catalogue, so this is the default source.
  defaultChannel: 'astoredirectprice',
  catalogSpreadsheetId: '1aCROiDUeMYgLInNHTe6zakg01rGCo9CMLpCo5TJ7zZg',
  // The client price template is the sole stage-2 destination. Its layout
  // stays intact: only existing Price columns and adjacent diagnostics change.
  priceTemplate: { spreadsheetId: '1m5URqsUhyT164JjNFNTZFlZ1AucbXh9qNjCFTG120jQ', headerRow: 1, firstDataRow: 2, sheets: {
    'телефоны': { sheetName: 'телефоны', kind: 'phone' }, 'макбуки': { sheetName: 'макбуки', kind: 'title' },
    'айпады': { sheetName: 'айпады', kind: 'title' }, 'часы': { sheetName: 'часы', kind: 'title' },
    'наушники': { sheetName: 'наушники', kind: 'title' }, 'пс': { sheetName: 'пс', kind: 'title' },
    'дайсон': { sheetName: 'дайсон', kind: 'title' }
  } },
  props: { project: 'ES_TC_PROJECT', channel: 'ES_TC_CHANNEL', last: 'ES_TC_LAST', status: 'ES_TC_STATUS', templateLastReport: 'ES_TC_TEMPLATE_LAST_REPORT', supplierModels: 'ES_TC_READY_SUPPLIER_MODELS', historyCursor: 'ES_TC_HISTORY_CURSOR', historyComplete: 'ES_TC_HISTORY_COMPLETE', fetchPausedUntil: 'ES_TC_FETCH_PAUSED_UNTIL', quotaPolicy: 'ES_TC_QUOTA_POLICY' }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог поставщика')
    .addItem('Подключить Telegram-канал', 'showTelegramCatalogSidebar')
    .addSeparator().addItem('Пересобрать каталог сейчас', 'runTelegramCatalogNow')
    .addItem('Синхронизировать шаблон цен', 'runPriceTemplateSyncNow').addToUi();
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
  const p = PropertiesService.getScriptProperties(), previousChannel = p.getProperty(TC.props.channel);
  if (previousChannel && previousChannel !== channel) {
    p.deleteProperty(TC.props.historyCursor);
    p.deleteProperty(TC.props.historyComplete);
    p.deleteProperty(TC.props.fetchPausedUntil);
  }
  p.setProperty(TC.props.project, project); p.setProperty(TC.props.channel, channel);
  tcEnsureTrigger_();
  const result = syncTelegramCatalog_();
  return Object.assign(getTelegramCatalogSetup(), { message: tcSummary_(result) });
}

function runTelegramCatalogNow() { tcEnsureTrigger_(); const result = syncTelegramCatalog_({ forceFetch:true }); return Object.assign(getTelegramCatalogSetup(), { message: '[' + TC.version + '] ' + tcSummary_(result) }); }
function runPriceTemplateSyncNow() {
  const report = syncTelegramPriceTemplate();
  return Object.assign(report, { message: report.skipped ? 'Шаблон цен ожидает завершения сборки каталога.' : tcPriceTemplateSummary_(report) });
}
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
    if (handler === 'syncTelegramCatalog' || handler === 'syncTelegramSupplier' || handler === 'syncTelegramPriceTemplate') ScriptApp.deleteTrigger(t);
  });
  TC.scheduleHours.forEach(function(hour) {
    ScriptApp.newTrigger('syncTelegramCatalog').timeBased().atHour(hour).everyDays(1).create();
  });
}

function tcSchedulePriceTemplateSync_(delayMs) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncTelegramPriceTemplate') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTelegramPriceTemplate').timeBased().after(Number(delayMs || 60000)).create();
}

function syncTelegramPriceTemplate() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    tcSchedulePriceTemplateSync_(2 * 60 * 1000);
    return { skipped: true, updated: 0, sheets: {} };
  }
  try {
    tcAssertCommonInvariants_();
    const report = tcSyncPriceTemplate_();
    console.log('[' + TC.version + '] Этап 2: ' + tcPriceTemplateSummary_(report));
    return report;
  } finally { lock.releaseLock(); }
}

function syncTelegramCatalog_(options) {
  tcAssertCommonInvariants_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('[' + TC.version + '] Каталог не обновлён: уже выполняется другая синхронизация.'); return { rows: 0, written: 0, skippedSheets: [], busy: true }; }
  try {
    const p = PropertiesService.getScriptProperties(), channel = p.getProperty(TC.props.channel);
    if (!channel) throw new Error('Сначала подключите публичный Telegram-канал.');
    // Migrate the former fixed 24-hour application pause once. A new attempt
    // still checks the real Google quota; subsequent rapid runs stay bounded.
    if (p.getProperty(TC.props.quotaPolicy) !== 'scheduled-retry-v1') {
      p.deleteProperty(TC.props.fetchPausedUntil);
      p.setProperty(TC.props.quotaPolicy, 'scheduled-retry-v1');
    }
    const pausedUntil = Number(p.getProperty(TC.props.fetchPausedUntil) || 0);
    if (pausedUntil > Date.now() && !(options && options.forceFetch)) {
      const result = { rows: 0, written: 0, skippedSheets: TC.sheets, deferred: true, reason:'pause', retryAfter:pausedUntil };
      console.log('[' + TC.version + '] ' + tcSummary_(result));
      return result;
    }
    console.log('[' + TC.version + '] Этап 1: выполняется запрос к Telegram @' + channel + '. Каталог: ' + TC.catalogSpreadsheetId + '.');
    // The complete confirmed current supplier feed is the catalogue.  The
    // sole city-wide product exclusion is iPhone 13/14 in markup below; do
    // not remove current iPhone 15/16/17 based on a supplier label.
    // Special-condition stock is excluded before any city price calculation
    // or catalogue write, not merely before the client-template stage.
    let fetched;
    try {
      fetched = tcFetchRows_(channel, { cursor:p.getProperty(TC.props.historyCursor), complete:p.getProperty(TC.props.historyComplete) === '1' });
    } catch (error) {
      if (!tcUrlFetchQuotaError_(error)) throw error;
      const retryAfter = Date.now() + TC.history.quotaPauseMs;
      p.setProperty(TC.props.fetchPausedUntil, String(retryAfter));
      const result = { rows:0, written:0, skippedSheets:TC.sheets, deferred:true, reason:'quota', retryAfter:retryAfter };
      p.setProperty(TC.props.status, tcSummary_(result));
      console.log('[' + TC.version + '] ' + tcSummary_(result) + ' Ошибка Google: ' + String(error.message || error));
      return result;
    }
    p.deleteProperty(TC.props.fetchPausedUntil);
    if (fetched.historyComplete) {
      p.setProperty(TC.props.historyComplete, '1');
      p.deleteProperty(TC.props.historyCursor);
    } else if (fetched.historyCursor) {
      p.setProperty(TC.props.historyCursor, fetched.historyCursor);
      p.deleteProperty(TC.props.historyComplete);
    }
    const sourceRows = fetched.filter(tcEligibleForCatalogue_);
    // Remember which source sections were actually received before project
    // exclusions. This lets an intentionally empty section clear old prices,
    // while a Telegram/source failure still leaves the existing tab intact.
    const observedCategories = {};
    sourceRows.forEach(function(row) { observedCategories[row.category] = true; });
    // Электросталь: сохраняем все позиции поставщика. Выбор самого дешёвого
    // варианта по странам — локальное правило Ульяновска и здесь не применяется.
    const markup = tcApplyElektrostalMarkup_(sourceRows);
    const book = SpreadsheetApp.openById(TC.catalogSpreadsheetId);
    // The ready tabs are the durable cache for rows already discovered in
    // older Telegram pages. A small incremental fetch may replace a SKU, but
    // never erases a different previously-confirmed supplier position.
    const existingRows = fetched.currentComplete ? [] : tcReadReadyRows_(book).filter(tcIncludeParsedElektrostalRow_);
    const rows = fetched.currentComplete ? markup.rows : tcMergePreparedRows_(existingRows, markup.rows);
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
    // The catalogue tabs are the contract between the two stages. Flush the
    // completed, marked-up catalogue before scheduling the template matcher.
    SpreadsheetApp.flush();
    p.setProperty(TC.props.supplierModels, JSON.stringify(tcSupplierModels_(sourceRows.concat(existingRows))));
    tcSchedulePriceTemplateSync_();
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    const result = {
      rows: rows.length, written: written,
      cheapest: 0, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
      excluded: markup.excluded,
      fetched: fetched.length,
      skippedSheets: skippedSheets, templateSync: { queued: true }
    };
    console.log('[' + TC.version + '] ' + tcSummary_(result));
    return result;
  } finally { lock.releaseLock(); }
}

/** Shared stage 2 reads only the completed catalogue and writes Price only. */
function tcSyncPriceTemplate_() {
  const report = PriceFlowTemplateMatcher.sync({ city:'elektrostal', sourceSpreadsheet:SpreadsheetApp.openById(TC.catalogSpreadsheetId), templateSpreadsheetId:TC.priceTemplate.spreadsheetId, headerRow:TC.priceTemplate.headerRow, firstDataRow:TC.priceTemplate.firstDataRow, sheets:TC.priceTemplate.sheets, allowIphoneAirAlias:true, priceOnly:true, supplierModels:tcReadySupplierModels_() });
  PropertiesService.getScriptProperties().setProperty(TC.props.templateLastReport, JSON.stringify({ at:report.at, updated:report.updated, skippedByReason:report.skippedByReason, ambiguous:Object.keys(report.sheets).reduce(function(all, name) { return all.concat((report.sheets[name].ambiguous || []).map(function(item) { return { sheet:name, title:item.title, prices:item.prices }; })); }, []).slice(0, 50) }));
  return report;
}
function tcPriceTemplateSummary_(report) {
  const reasons = Object.keys(report.skippedByReason || {}).map(function(reason) { return reason + ': ' + report.skippedByReason[reason]; });
  return 'Шаблон цен: обновлено ' + Number(report.updated || 0) + '. ' + (reasons.length ? 'Пропуски — ' + reasons.join(', ') + '.' : 'Пропусков нет.');
}
function tcRunCommonRegressionTests() { return PriceFlowAvitoMatcher.runRegressionTests(); }
function tcAssertCommonInvariants_() { return tcRunCommonRegressionTests(); }
function tcSupplierModels_(rows) { return Array.from(new Set((rows || []).map(function(row) { return tcPhone_(tcDisplay_(row)).model; }).filter(Boolean).map(tcNorm_))); }
function tcReadySupplierModels_() { try { const stored = JSON.parse(PropertiesService.getScriptProperties().getProperty(TC.props.supplierModels) || '[]'); return Array.isArray(stored) ? stored : []; } catch (error) { return []; } }
function tcEligibleForCatalogue_(row) { return Boolean(row) && !tcHasSpecialCondition_(tcDisplay_(row)); }
function tcHasSpecialCondition_(value) { return /(?:\b(?:asis|асис|cpo|цпо|open\s*box|refurb(?:ished)?|defect(?:ive)?|faulty|damaged|used|active)\b|(?:^|[^a-zа-я])(?:б\/?у|бу)(?=$|[^a-zа-я])|уцен|витрин|демо|(?:пред\s*)?актив(?:ир)?|распак|брак|вскрыт[а-я]*\s*(?:короб|упаков)|поврежд[а-я]*\s*(?:короб|упаков)|мят(?:ая|ый|ой|ую|ые|ых))/iu.test(String(value || '')); }

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

/** Rebuild product objects from the ready tabs without reapplying markup. */
function tcReadReadyRows_(book) {
  const rows = [];
  TC.sheets.forEach(function(category) {
    const sheet = book.getSheetByName(category);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    tcLayouts_(headers).forEach(function(layout) {
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      data.forEach(function(row) {
        const price = Number(row[layout.priceColumn]);
        if (!(price > 0)) return;
        const name = layout.title >= 0 ? String(row[layout.title] || '').trim() : tcReadyPhoneName_(row, layout);
        if (!name) return;
        // The ready phone block is already structured. Re-parsing a display
        // string on every incremental run used to append memory/colour again
        // and again to Android Model, eventually destroying the SKU key.
        const phone = category === 'телефоны' && layout.model >= 0 ? {
          model:tcModel_(row[layout.model]), memory:String(row[layout.memory] || '').trim(),
          config:String(row[layout.sim] || '').trim(), color:String(row[layout.color] || '').trim(),
          ram:layout.ram >= 0 ? String(row[layout.ram] || '').trim() : '',
          technical:tcAndroidTechnicalModifiers_(row[layout.model])
        } : null;
        rows.push({ category:category, name:name, variant:'', price:price, phone:phone });
      });
    });
  });
  return rows;
}

function tcReadyPhoneName_(row, layout) {
  const fields = [row[layout.model], row[layout.memory], row[layout.sim], row[layout.color], row[layout.ram]]
    .map(function(value) { return String(value || '').trim(); })
    .filter(function(value) { return value && !/^не знаю$/i.test(value); });
  return fields.join(' ');
}

function tcPreparedProductKey_(row) {
  const category = String(row && row.category || ''), title = tcDisplay_(row);
  if (category !== 'телефоны') return category + '|' + tcNorm_(title);
  const phone = row.phone || tcPhone_(title);
  return [category, phone.model, phone.technical, phone.memory, phone.config, phone.color, phone.ram].map(tcNorm_).join('|');
}

/** Fresh source rows replace the same SKU, while prior history remains.
 * The supplier publishes consoles as one complete current price post, so a
 * received PS section supersedes stale historical PS/accessory rows. */
function tcMergePreparedRows_(existingRows, freshRows) {
  const freshKeys = {}, refreshPs5Hardware = (freshRows || []).some(tcPs5HardwareRow_), refreshAirpods = (freshRows || []).some(tcAirpodsRow_);
  (freshRows || []).forEach(function(row) {
    freshKeys[tcPreparedProductKey_(row)] = true;
  });
  return (existingRows || []).filter(function(row) {
    return !freshKeys[tcPreparedProductKey_(row)] && !(refreshPs5Hardware && tcPs5HardwareRow_(row)) && !(refreshAirpods && tcAirpodsRow_(row));
  }).concat(freshRows || []);
}

function tcAirpodsRow_(row) { return Boolean(row) && row.category === 'наушники' && /^(?:apple\s+)?airpods\b/i.test(tcDisplay_(row)); }

/** True only for PS5 consoles and Portal, excluding separate accessories. */
function tcPs5HardwareRow_(row) {
  if (!row || row.category !== 'пс') return false;
  const name = tcNorm_(tcDisplay_(row));
  if (/\b(?:drive|controller|gamepad|stand|dock|charging|vr)\b|геймпад|джойстик|контроллер/.test(name)) return false;
  return /(?:\b(?:ps\s*5|playstation\s*5)\s+(?:slim\s+)?(?:digital|disc|pro)\b|\bplaystation\s+portal\b|\bsony\s+playstation\s+5\b)/i.test(name);
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
  const full = tcDisplay_(product), phone = product.phone || tcPhone_(full);
  if (layout.title >= 0) at(layout.title, full);
  if (layout.model >= 0) at(layout.model, (phone.model + (phone.technical ? ' ' + phone.technical : '')).trim() || product.name);
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
  if (result && result.busy) return 'Каталог не обновлён: уже выполняется другая синхронизация.';
  if (result && result.deferred) return (result.reason === 'quota' ? 'Google отклонил запрос: исчерпана квота UrlFetch.' : 'Действует короткая пауза после ошибки квоты; нового запроса к Google не было.') + ' Каталог и цены не обновлены. Следующая попытка — плановым триггером; разрешена после ' + new Date(result.retryAfter).toISOString() + ' (UTC).';
  const markedUp = Number(result.markedUp || 0);
  const withoutMarkup = Number(result.withoutMarkup || 0);
  const excluded = Number(result.excluded || 0);
  return 'Каталог получен: ' + result.rows + ' позиций. Записано в листы: ' + result.written +
    (result.fetched !== undefined ? '. В этом запуске прочитано из Telegram: ' + result.fetched : '') +
    '. Наценка Электростали применена к ' + markedUp + ' позициям' +
    (withoutMarkup ? '. Без правила наценки: ' + withoutMarkup : '') +
    (excluded ? '. Исключены iPhone 13/14: ' + excluded : '') +
    '. Автообновление — 5 раз в день; синхронизация шаблона запланирована.';
}
function tcNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
function tcDisplay_(product) { return [product.name, product.variant].filter(Boolean).join(' ').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim(); }

/** iPhone 13 and 14 are not offered in the prepared Elektrtostal catalogue. */
function tcIncludeParsedElektrostalRow_(row) { return Boolean(row) && !tcExcludedElektrostalSku_(row); }

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

function tcExcludedElektrostalSku_(row) {
  if (!row || row.category !== 'телефоны') return false;
  return /^iphone\s+(?:13|14)(?:\s|$)/i.test(tcDisplay_(row));
}

function tcElektrostalMarkupAmount_(row) {
  if (!row) return null;
  const price = Number(row.price || 0), name = tcNorm_(tcDisplay_(row));
  if (price < 5000) return null;
  // The new high-price bands are approved for iPhone Duo only.
  if (/^iphone\s+duo(?:\s|$)/i.test(name) && price >= 225000) {
    if (price < 301000) return 15000;
    if (price < 501000) return 20000;
    return null;
  }
  // Электросталь: Apple has its own scale; every other product family uses
  // the Android scale, including watches, headphones, PlayStation and Dyson.
  const apple = /\b(?:iphone|ipad|macbook|imac|apple\s+watch|airpods|apple\s+tv|apple\s+pencil)\b/.test(name);
  // Apple retains its final approved band at every higher price.
  if (apple && price > 225999) return 13000;
  if (!apple && price > 225999) return 15000;
  const bands = apple ? [[15999,3000],[35999,4000],[69999,5000],[89999,6000],[110999,7500],[150999,9000],[225999,13000]] : [[15999,3000],[35999,5000],[69999,7000],[89999,8000],[110999,8500],[150999,10000],[225999,15000]];
  const band = bands.find(function(rule) { return price <= rule[0]; });
  return band ? band[1] : null;
}

function tcFetchRows_(channel, state) {
  // Every product post remains part of the supplier feed. The crawl is split
  // across launches so that a long public history cannot exhaust UrlFetch.
  const initialUrl = 'https://t.me/s/' + channel;
  const initialResponse = UrlFetchApp.fetch(initialUrl, { muteHttpExceptions:true });
  if (initialResponse.getResponseCode() !== 200) throw new Error('Telegram не открыл страницу прайса: HTTP ' + initialResponse.getResponseCode());
  const initialHtml = initialResponse.getContentText(), initial = tcParsePreview_(initialHtml, channel), rows = initial.rows;
  if (channel === 'astoredirectprice') {
    // The supplier edits permanent price posts. Recent-history paging alone
    // never sees those edits, so read every linked current section on each run.
    const ids = tcNavigationPostIds_(initialHtml, channel);
    if (ids.length < 20) throw new Error('Навигация поставщика неполная: найдено ' + ids.length + ' разделов. Каталог не изменён.');
    const current = tcTelegramNavigationRows_(channel, ids);
    const unique = tcUniqueRows_(current.concat(rows)).filter(tcIncludeParsedElektrostalRow_);
    if (unique.length < 50 || unique.filter(function(row) { return row.category === 'телефоны'; }).length < 20) {
      throw new Error('Текущий прайс поставщика разобран неполно: ' + unique.length + ' позиций. Каталог не изменён.');
    }
    unique.currentComplete = true;
    unique.historyComplete = true;
    unique.historyCursor = '';
    return unique;
  }
  // Navigation links name the current catalogue sections.  Read the current
  // consoles post directly every run: otherwise a high-volume channel can
  // leave the latest PS5 Digital/Disc/Pro post behind the history cursor.
  const psIds = tcNavigationSectionPostIds_(initialHtml, channel, /^(?:playstation|консоли)$/i);
  let currentPsRows = null;
  if (psIds.length) {
    currentPsRows = tcTelegramDirectPost_(channel, psIds[0]).filter(tcPs5HardwareRow_);
    if (!currentPsRows.length) throw new Error('Актуальный раздел PlayStation пуст или недоступен. Каталог не изменён.');
    console.log('[' + TC.version + '] Актуальный PlayStation: https://t.me/' + channel + '/' + psIds[0] + '; позиций: ' + currentPsRows.length + '.');
  } else if (channel === 'astoredirectprice') {
    throw new Error('Не найдена ссылка PlayStation в навигации поставщика. Каталог не изменён.');
  }
  // New supplier families may live in an edited permanent iPhone post outside
  // the recent history pages. Read Duo from its current navigation link.
  const iphoneIds = tcNavigationSectionPostIds_(initialHtml, channel, /^iphone$/i);
  const duoRows = iphoneIds.length ? tcTelegramDirectPost_(channel, iphoneIds[0]).filter(function(row) { return tcModel_(tcDisplay_(row)) === 'iPhone Duo'; }) : [];
  if (iphoneIds.length) console.log('[' + TC.version + '] Актуальный iPhone Duo: https://t.me/' + channel + '/' + iphoneIds[0] + '; позиций: ' + duoRows.length + '.');
  const audioIds = tcNavigationSectionPostIds_(initialHtml, channel, /^airpods(?:\s+и\s+аудио)?$/i);
  let audioRows = null;
  if (audioIds.length) {
    audioRows = tcTelegramDirectPost_(channel, audioIds[0]).filter(tcAirpodsRow_);
    if (!audioRows.length) throw new Error('Актуальный раздел AirPods пуст или недоступен. Каталог не изменён.');
    console.log('[' + TC.version + '] Актуальные AirPods: https://t.me/' + channel + '/' + audioIds[0] + '; позиций: ' + audioRows.length + '.');
  }
  let recentCursor = tcTelegramBefore_(initial.previous);
  for (let page = 0; page < TC.history.recentPages && recentCursor; page++) {
    const preview = tcTelegramPage_('https://t.me/s/' + channel + '?before=' + recentCursor, channel);
    rows.push.apply(rows, preview.rows);
    recentCursor = tcTelegramBefore_(preview.previous);
  }
  let historyComplete = Boolean(state && state.complete), historyCursor = Number(state && state.cursor || 0);
  if (!historyComplete) {
    // Start after the newest pages; subsequent runs resume at their own
    // cursor and eventually reach the first post without refetching all pages.
    if (!historyCursor || historyCursor > recentCursor) historyCursor = recentCursor;
    for (let page = 0; page < TC.history.backgroundPages && historyCursor; page++) {
      const preview = tcTelegramPage_('https://t.me/s/' + channel + '?before=' + historyCursor, channel);
      rows.push.apply(rows, preview.rows);
      historyCursor = tcTelegramBefore_(preview.previous);
    }
    if (!historyCursor) historyComplete = true;
  }
  const currentRows = currentPsRows ? rows.filter(function(row) { return !tcPs5HardwareRow_(row); }).concat(currentPsRows) : rows;
  const liveRows = currentRows.filter(function(row) { return (!duoRows.length || tcModel_(tcDisplay_(row)) !== 'iPhone Duo') && (!audioRows || !tcAirpodsRow_(row)); }).concat(duoRows, audioRows || []);
  const unique = tcUniqueRows_(liveRows).filter(tcIncludeParsedElektrostalRow_);
  if (!unique.length) throw new Error('В актуальном прайсе Telegram не найдено ни одной подтверждённой цены. Каталог не изменён.');
  unique.historyCursor = historyCursor ? String(historyCursor) : '';
  unique.historyComplete = historyComplete;
  return unique;
}

function tcTelegramNavigationRows_(channel, ids) {
  const rows = [], firstCurrentPost = ids[0];
  for (let start = 0; start < ids.length; start += 10) {
    const batch = ids.slice(start, start + 10);
    const requests = batch.map(function(id) { return {url:'https://t.me/s/' + channel + '/' + id, muteHttpExceptions:true}; });
    const responses = UrlFetchApp.fetchAll ? UrlFetchApp.fetchAll(requests) : requests.map(function(request) { return UrlFetchApp.fetch(request.url, request); });
    responses.forEach(function(response, index) {
      const id = batch[index];
      if (response.getResponseCode() !== 200) throw new Error('Раздел поставщика #' + id + ' недоступен: HTTP ' + response.getResponseCode() + '. Каталог не изменён.');
      const text = tcDirectPostText_(response.getContentText(), id);
      if (!text) throw new Error('Раздел поставщика #' + id + ' пуст или не прочитан. Каталог не изменён.');
      // Each navigation link points to the first post of a section. The same
      // page also contains its continuation posts (e.g. HONOR 600 after Magic
      // 8 Pro); parsing only the linked post silently omitted whole models.
      tcParsePreview_(response.getContentText(), channel).rows.forEach(function(row) {
        if (Number(row.post) >= firstCurrentPost) rows.push(row);
      });
    });
  }
  return rows;
}

function tcTelegramPage_(url, channel) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions:true });
  if (response.getResponseCode() !== 200) throw new Error('Telegram не открыл страницу прайса: HTTP ' + response.getResponseCode());
  return tcParsePreview_(response.getContentText(), channel);
}

/** Reads one explicitly linked current catalogue post, without its neighbours. */
function tcTelegramDirectPost_(channel, post) {
  const request = { url:'https://t.me/s/' + channel + '/' + post, muteHttpExceptions:true };
  let response;
  try { response = UrlFetchApp.fetch(request.url, request); }
  catch (error) { if (tcUrlFetchQuotaError_(error)) throw error; response = tcTelegramRetryFetch_(request); }
  if (response.getResponseCode() !== 200) response = tcTelegramRetryFetch_(request);
  if (response.getResponseCode() !== 200) throw new Error('Telegram не открыл актуальный раздел прайса #' + post + ': HTTP ' + response.getResponseCode());
  return tcParseDirectPost_(response.getContentText(), channel, post);
}

function tcTelegramPages_(urls, channel) {
  const requests = urls.map(function(url) { return { url:url, muteHttpExceptions:true }; });
  let responses;
  try {
    responses = UrlFetchApp.fetchAll ? UrlFetchApp.fetchAll(requests) : requests.map(function(request) { return UrlFetchApp.fetch(request.url, request); });
  } catch (error) {
    // A single unavailable Telegram address must not stop the complete scan:
    // retry the same five history URLs one by one.
    responses = requests.map(tcTelegramRetryFetch_);
  }
  return responses.map(function(response, index) {
    if (response.getResponseCode() !== 200) response = tcTelegramRetryFetch_(requests[index]);
    if (response.getResponseCode() !== 200) throw new Error('Telegram не открыл страницу прайса: HTTP ' + response.getResponseCode());
    return tcParsePreview_(response.getContentText(), channel);
  });
}

function tcTelegramRetryFetch_(request) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(request.url, request);
      if (response.getResponseCode() === 200) return response;
      lastError = new Error('HTTP ' + response.getResponseCode());
    } catch (error) {
      if (tcUrlFetchQuotaError_(error)) throw error;
      lastError = error;
    }
    if (attempt < 2 && typeof Utilities !== 'undefined' && Utilities.sleep) Utilities.sleep(1000 * (attempt + 1));
  }
  throw new Error('Telegram не открыл раздел актуального прайса. Каталог не изменён: ' + (lastError && lastError.message || 'неизвестная ошибка'));
}

function tcUrlFetchQuotaError_(error) {
  const message = String(error && error.message || error || '');
  return /url\s*fetch/i.test(message) && /слишком\s+много\s+раз|too many times|quota.*exceed|limit.*exceed/i.test(message);
}

function tcTelegramBefore_(path) {
  const match = /[?&]before=(\d+)/.exec(String(path || ''));
  return match ? Number(match[1]) : 0;
}

/** Telegram repeats the edge post while paging; keep each parsed row once. */
function tcUniqueRows_(rows) {
  const seen = {};
  return rows.filter(function(row) {
    const key = [row.post, row.category, row.name, row.variant, row.price].join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
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

/** Finds current navigation links whose visible label belongs to a category. */
function tcNavigationSectionPostIds_(html, channel, labelPattern) {
  const source = String(html || ''), chunks = source.split(/<div class="tgme_widget_message_wrap[^>]*">/i), ids = {}, escaped = String(channel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let index = 1; index < chunks.length; index++) {
    const body = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i.exec(chunks[index]);
    if (!body || !/навигация\s+по\s+прайсу/i.test(tcHtml_(body[1]))) continue;
    const link = new RegExp('<a[^>]+href="((?:https?:)?//t\\.me/' + escaped + '/(\\d+)|/s/' + escaped + '/(\\d+))"[^>]*>([\\s\\S]*?)<\\/a>', 'gi'); let match;
    while ((match = link.exec(chunks[index]))) if (labelPattern.test(tcHtml_(match[4]))) ids[match[2] || match[3]] = true;
  }
  return Object.keys(ids).map(Number).filter(function(id) { return id > 0; }).sort(function(a, b) { return a - b; });
}

/** A direct Telegram post URL also contains neighbours; parse only its target. */
function tcParseDirectPost_(html, channel, targetPost) {
  const text = tcDirectPostText_(html, targetPost);
  return text ? tcParsePost_(text, channel, targetPost) : [];
}

function tcDirectPostText_(html, targetPost) {
  const chunks = String(html || '').split(/<div class="tgme_widget_message_wrap[^>]*">/i);
  for (let index = 1; index < chunks.length; index++) {
    const post = /data-post="[^/]+\/(\d+)"/i.exec(chunks[index]), body = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i.exec(chunks[index]);
    if (post && body && String(post[1]) === String(targetPost)) return tcHtml_(body[1]);
  }
  // Fallback for a direct OpenGraph page when preview-message markup is not
  // available. The normal `/s/<channel>/<post>` request above is preferred,
  // because OpenGraph descriptions can truncate long catalogues.
  const description = /<meta\s+(?:property|name)="(?:og:description|twitter:description)"\s+content="([\s\S]*?)"\s*\/?>/i.exec(String(html || ''));
  return description ? tcHtml_(description[1]) : '';
}

function tcContinuationInfo_(text) {
  const first = String(text || '').split('\n').map(function(line) { return line.trim(); }).filter(Boolean)[0] || '';
  const match = /^(.*?)\s*\(часть\s*(\d+)\s*\/\s*(\d+)\)\s*$/i.exec(first);
  if (!match) return null;
  const part = Number(match[2]), total = Number(match[3]), label = match[1].trim();
  return part > 0 && total >= part && label ? { section:tcNorm_(label), label:label, part:part, total:total } : null;
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
    .filter(function(row) { return row && TC.sheets.indexOf(row.category) >= 0 && tcIncludeParsedElektrostalRow_(row); });
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
    else if (/^iPhone\s+(?:\d|duo\b)/i.test(line)) { brand = 'iPhone'; section = tcNorm_(line); }
    else if (/^iPad\b/i.test(line)) { brand = 'iPad'; section = tcNorm_(line); }
    else if (/^MacBook\b/i.test(line)) { brand = 'MacBook'; section = tcNorm_(line); }
    else if (/^Apple\s+Watch\b/i.test(line)) { brand = 'Apple Watch'; section = tcNorm_(line); }
    // A new non-Apple product begins a new context. Without this reset a
    // later Dyson/Garmin line in one Telegram post inherited "MacBook".
    else if (/^(?:Dyson|Garmin|PlayStation|PS[345]\b|Xbox|Samsung|Galaxy|Pixel|Xiaomi|Redmi|Honor|Huawei|OnePlus|Realme|Oppo|Vivo)\b/i.test(line)) { brand = ''; section = tcNorm_(line); }
  });
  return rows.filter(function(row) { return TC.sheets.indexOf(row.category) >= 0 && tcIncludeParsedElektrostalRow_(row); });
}

function tcVolumeName_(brand, value) {
  const parsed = tcStatus_(String(value || '').replace(/^[\[\]•·▪◦.\s]+/, '').replace(/\s+/g, ' ').trim()), item = parsed.text;
  if (!item) return '';
  if (brand === 'iPhone' && /^duo(?=\s|$)/i.test(item)) return tcWithStatus_(parsed.marks, 'iPhone ' + item);
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
  if (/iphone/i.test(h) && /^(?:iphone\s+)?(?:duo|дуо)(?=\s|$)/i.test(i)) return tcWithStatus_(mark, i.replace(/^(?:iphone\s+)?(?:duo|дуо)(?=\s|$)/i, 'iPhone Duo'));
  const bareIphoneSku = /^\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?\b/i.test(i);
  if (/\biphone\b/i.test(h) && bareIphoneSku) {
    // The public price uses headers such as “📱 Apple · iPhone”. The leading
    // icon is not stable, so find the family anywhere in the header rather
    // than requiring it to be its first character.
    const known = /\biphone\s+(\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?)/i.exec(h);
    if (!known) expanded = 'iPhone ' + i;
    else {
      const model = known[1].replace(/\s+/g, ' ').trim(), repeated = new RegExp('^' + model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)', 'i');
      expanded = 'iPhone ' + model + ' ' + (repeated.test(i) ? i.slice(model.length).trim() : i);
    }
  }
  else if (/^iphone\s/i.test(h) && !/^iphone\s/i.test(i)) {
    const model = h.replace(/^iphone\s+/i, '').trim(), repeated = new RegExp('^' + model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)', 'i');
    expanded = h + ' ' + (repeated.test(i) ? i.slice(model.length).trim() : i);
  }
  else if (/^macbook\b/i.test(h) && !/^macbook\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^dyson\b/i.test(h) && !/^dyson\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^airpods\b/i.test(h) && !/^airpods\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^apple\s+airpods\b/i.test(h) && !/^(?:apple\s+)?airpods\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^imac\b/i.test(h) && !/^imac\b/i.test(i)) expanded = h + ' ' + i;
  else if (/^watch\b/i.test(h) && /^watch\b/i.test(i)) expanded = 'Apple ' + i;
  else if (/^apple\s+watch\b/i.test(h) && !/^apple\s+watch\b/i.test(i)) expanded = h + ' ' + i;
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
  if (/iphone|galaxy|pixel|xiaomi|redmi|poco|samsung|honor|huawei|oneplus|realme|oppo|vivo|nothing|tecno/.test(v)) return 'телефоны';
  return 'прочее';
}
function tcPhone_(value) {
  const text = String(value || ''), specs = /(\d{1,2})\s*\/\s*(\d{1,4})\s*(гб|gb|тб|tb)?(?=\s|$|[),;])/i.exec(text);
  const memory = specs ? null : /(?:^|\s)(\d{1,4})\s?(гб|gb|тб|tb)(?=\s|$)/i.exec(text);
  const unit = function(amount, suffix) { return amount + ' ' + suffix.toUpperCase().replace('GB', 'ГБ').replace('TB', 'ТБ'); };
  const sim = /\b(?:2\s*(?:sim|сим)|dual\s*-?\s*sim)\b/i.test(text) ? '2 SIM' : /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : '';
  const modelName = tcModel_(text), memorySize = specs ? unit(specs[2], specs[3] || 'GB') : memory ? unit(memory[1], memory[2]) : '';
  return { model: modelName, memory: memorySize, ram: specs ? unit(specs[1], 'GB') : tcKnownPixelRam_(modelName, memorySize), color: tcColor_(text), config: sim, country: tcCountry_(text), technical: tcAndroidTechnicalModifiers_(text) };
}
/** The supplier omits RAM in these exact Pixel 11 SKUs. Their RAM is
 * confirmed by the 06.11.2026 supplier spreadsheet; other Pixel SKUs stay
 * unknown rather than borrowing a configuration from another variant. */
function tcKnownPixelRam_(model, memory) {
  const key = tcNorm_(model), storage = tcNorm_(memory);
  if (key === 'pixel 11 pro' && storage === '1 тб') return '16 ГБ';
  if (key === 'pixel 11 pro xl' && /^(?:512 гб|1 тб)$/.test(storage)) return '16 ГБ';
  if (key === 'pixel 11 pro fold' && /^(?:256 гб|512 гб|1 тб)$/.test(storage)) return '16 ГБ';
  return '';
}
function tcModel_(value) {
  const text = String(value || '').replace(/\(\s*asis\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (/\biphone\s+(?:duo|дуо)(?=\s|$)/i.test(text)) return 'iPhone Duo';
  const iphone = /\biphone\s+(\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?)/i.exec(text);
  if (iphone) return 'iPhone ' + iphone[1].replace(/\s+/g, ' ').trim();
  return tcAndroidIdentity_(text);
}
/** Android model only; technical network attributes are kept separately. */
function tcAndroidIdentity_(value) {
  const text = tcNorm_(value);
  // Match only the model token sequence. The former catch-all tail for these
  // brands swallowed storage, RAM and repeated fields from the ready sheet.
  const match = /\b(?:samsung\s+)?(galaxy\s+(?:z\s*(?:fold|flip)\s*\d+(?:\s*(?:ultra|fe|pro|plus))?|[sam]\s*\d+[a-z]?\+?(?:\s*(?:ultra|fe|pro\+?|plus))?))(?=$|[^a-z0-9])|\b(pixel\s+\d+[a-z]?(?:\s+pro(?:\s+(?:xl|fold))?|\s+xl)?)\b|\b(xiaomi\s+\d+[a-z]?(?:\s+(?:pro(?:\s+max)?|ultra))?)\b|\b(redmi\s+(?:note\s+)?\d+[a-z]?(?:\s+(?:pro(?:\s+max)?\+?|plus|ultra))?)(?=$|[^a-z0-9])|\b(poco\s+[a-z]\d+[a-z]?(?:\s+(?:pro(?:\s+max)?|ultra|plus))?)\b|\b(honor\s+(?:magic\s+\d+[a-z]?|[x]?\d+[a-z]?)(?:\s+(?:pro|lite|smart|turbo|plus))?)\b|\b((?:oneplus|huawei|oppo|vivo|realme|nothing|tecno)\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/i.exec(text);
  if (!match) return '';
  const base = match.slice(1).find(Boolean).replace(/\s+/g, ' ').trim();
  const display = base.replace(/\b(galaxy|pixel|xiaomi|redmi|poco|oneplus|honor|huawei|oppo|vivo|realme|nothing|tecno)\b/g, function(word) { return word.charAt(0).toUpperCase() + word.slice(1); });
  return display.trim();
}
function tcAndroidTechnicalModifiers_(value) {
  const text = tcNorm_(value), modifiers = [];
  if (/\b4\s*g\b/.test(text)) modifiers.push('4G');
  if (/\b5\s*g\b/.test(text)) modifiers.push('5G');
  if (/\bnfc\b/.test(text)) modifiers.push('NFC');
  if (/\blte\b/.test(text)) modifiers.push('LTE');
  return modifiers.join(' ');
}
function tcCountry_(value) { const flag = /(🇺🇸|🇯🇵|🇭🇰|🇰🇷|🇮🇳|🇨🇦|🇸🇬|🇦🇪|🇷🇺|🇨🇳)/u.exec(String(value || '')); const names = {'🇺🇸':'США','🇯🇵':'Япония','🇭🇰':'Гонконг','🇰🇷':'Корея','🇮🇳':'Индия','🇨🇦':'Канада','🇸🇬':'Сингапур','🇦🇪':'ОАЭ','🇷🇺':'Россия','🇨🇳':'Китай'}; return flag ? names[flag[1]] + ' ' + flag[1] : ''; }
// Цвет из Telegram может стоять в любом месте строки и быть отделён скобками,
// тире или флагом страны. Это не подставляет цвет, которого нет у поставщика.
function tcColorKey_(value) { return tcNorm_(value).replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim(); }
function tcColor_(value) {
  const v = tcColorKey_(value);
  // Supplier finish names confirmed against the existing Android target rows.
  if (/galaxy\s+s25\s+ultra\b/.test(v) && /\bwhitesilver\b/.test(v)) return 'белый';
  if (/galaxy\s+s25\s+ultra\b/.test(v) && /\btitanium\s+silverblue\b/.test(v)) return 'синий';
  if (/galaxy\s+s25\b/.test(v) && /\bsilver\s+shadow\b/.test(v)) return 'серый';
  if (/galaxy\s+z\s*(?:fold|flip)\s*8\b/.test(v) && /\bgraphite\b/.test(v)) return 'серый';
  if (/\bpixel\s+11\b/.test(v)) {
    if (/\bcanyon\b/.test(v)) return 'оранжевый';
    if (/\bolive\b/.test(v)) return 'зеленый';
    if (/\bfog\b/.test(v)) return 'серый';
  }
  if (/\bhonor\s+400(?:\s+pro)?\b/.test(v)) {
    if (/\btidal\s+blue\b/.test(v) || /\bhonor\s+400\s+12\s+512\s+гб\s+blue\b/.test(v)) return 'голубой';
  }
  if (/\biphone\s+duo\b/i.test(v)) {
    if (/\bstar\s+white\b/i.test(v)) return 'белый';
    if (/\bnight\s+sky\b/i.test(v)) return 'синий';
  }
  const colors = [
    ['awesome icyblue','голубой'],['icyblue','голубой'],['sky cyan','голубой'],['lake cyan','голубой'],
    ['awesome lightgray','серый'],['lightgray','серый'],['jetblack','черный'],
    ['navy','синий'],['navi','синий'],['blueberry','синий'],['lilac','фиолетовый'],['lavander','фиолетовый'],
    ['pistachio','зеленый'],['olive','зеленый'],['cloud blush','розовый'],
    ['space black','черный'],['black titanium','черный'],['white titanium','белый'],['blue titanium','синий'],['natural titanium','натуральный'],['desert titanium','пустынный'],
    ['deep purple','темно-фиолетовый'],['sierra blue','голубой'],['pacific blue','голубой'],['sky blue','голубой'],['alpine green','темно-зеленый'],['midnight green','темно-зеленый'],
    ['space gray','серый'],['rose gold','розовое золото'],['cosmic orange','оранжевый'],['product red','красный'],
    ['сияющая звезда','сияющая звезда'],['розовое золото','розовое золото'],['темно фиолетовый','темно-фиолетовый'],['темно зеленый','темно-зеленый'],
    ['ultramarine','ультрамарин'],['graphite','графитовый'],['coral','коралловый'],['teal','бирюзовый'],['lavender','лавандовый'],['violet','фиолетовый'],['indigo','индиго'],['titanium','титан'],['porcelain','фарфоровый'],['hazel','ореховый'],['aloe','алоэ'],['peony','пионовый'],['wintergreen','зимний зеленый'],['charcoal','угольный'],['sage','шалфейный'],['mint','мятный'],['cream','кремовый'],
    ['lemongrass','лимонный'],['obsidian','обсидиан'],['snow','белый'],['bay','голубой'],['fog','серый'],['midnight','полночный'],['starlight','сияющая звезда'],['natural','натуральный'],['desert','пустынный'],
    ['черный','черный'],['белый','белый'],['синий','синий'],['голубой','голубой'],['зеленый','зеленый'],['розовый','розовый'],['желтый','желтый'],['серебристый','серебристый'],['серебряный','серебристый'],['серый','серый'],['оранжевый','оранжевый'],['фиолетовый','фиолетовый'],['лавандовый','лавандовый'],['бирюзовый','бирюзовый'],['графитовый','графитовый'],['коралловый','коралловый'],['красный','красный'],['золотистый','золотистый'],
    ['black','черный'],['white','белый'],['blue','синий'],['green','зеленый'],['pink','розовый'],['yellow','желтый'],['silver','серебристый'],['gray','серый'],['grey','серый'],['orange','оранжевый'],['purple','фиолетовый'],['violet','фиолетовый'],['red','красный'],['burgundy','красный'],['gold','золотистый']
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
  if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b)|18(?:\s+pro(?:\s+max)?)?)/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой';
  const pairs = [['натуральный','серый'],['серый космос','серый'],['графитовый','черный'],['угольный','черный'],['обсидиан','черный'],['титан','серый'],['пустынный','золотистый'],['кремовый','бежевый'],['ореховый','бежевый'],['фарфоровый','белый'],['сияющая звезда','белый'],['темно фиолетовый','фиолетовый'],['лавандовый','фиолетовый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['индиго','синий'],['полночный','черный'],['темно зеленый','зеленый'],['зимний зеленый','зеленый'],['шалфейный','зеленый'],['мятный','зеленый'],['алоэ','зеленый'],['розовое золото','розовый'],['коралловый','розовый'],['пионовый','розовый'],['лимонный','желтый']];
  const hit = pairs.find(function(pair) { return tcColorKey_(detected) === pair[0]; });
  return hit ? hit[1] : tcColorKey_(detected);
}
// ВСТАВИТЬ В КОНЕЦ существующего файла Apps Script и сохранить.
// Запустить одну функцию: setPriceTriggers / setIvanovoTriggers /
// setNizhnevartovskTriggers. Ссылки и ID таблиц для этого не нужны.
// Все времена — МСК. Google допускает отклонение nearMinute примерно ±15 мин.
// Удаляются ВСЕ прежние установленные триггеры текущего пользователя в проекте,
// включая отложенный второй этап и обработчики событий. Новые триггеры
// вызывают существующую основную функцию обновления цен.

function setPriceTriggers() {
  return pfOnceSetTriggers_([[8,25],[11,25],[14,20],[17,25],[20,25]]);
}

function setIvanovoTriggers() {
  return pfOnceSetTriggers_([[13,25],[14,20]]);
}

function setNizhnevartovskTriggers() {
  return pfOnceSetTriggers_([[2,20],[5,20],[8,20],[11,20],[14,20],[17,20],[20,20],[23,20]]);
}

function pfOnceFindRunner_(oldTriggers) {
  const known = ['priceFlowScheduledRun','syncTelegramCatalog',
    'syncTelegramSupplier','syncRMGroupCatalog','syncMoySkladCatalog',
    'syncRuStoreCatalog','syncAppleTradeCatalog'];
  const exists = function(name) { return typeof globalThis[name] === 'function'; };
  const available = known.filter(exists);
  const active = Array.from(new Set(oldTriggers.filter(function(t) {
    return t.getEventType() === ScriptApp.EventType.CLOCK;
  }).map(function(t) { return t.getHandlerFunction(); }).filter(function(name) {
    return available.indexOf(name) >= 0;
  })));
  if (active.length === 1) return active[0];
  if (!active.length && available.length === 1) return available[0];
  if (!available.length && exists('priceFlowRun')) return 'priceFlowRun';
  throw new Error('Основная функция обновления не определена однозначно. Триггеры не изменены. Найдены: ' + (active.length ? active : available).join(', ') + '. Пришлите эту строку — нужно указать имя функции запуска этого проекта.');
}

function pfOnceSetTriggers_(slots) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Сейчас выполняется обновление. Повторите установку после его завершения.');
  try {
    const old = ScriptApp.getProjectTriggers();
    const runner = pfOnceFindRunner_(old);
    // Сначала создаём новые триггеры: при ошибке прежнее расписание сохранится.
    if (old.length + slots.length > 20) {
      throw new Error('Недостаточно свободных мест для безопасной замены (' + old.length + ' старых и ' + slots.length + ' новых). Триггеры не изменены.');
    }
    const created = [];
    try {
      slots.forEach(function(slot) {
        created.push(ScriptApp.newTrigger(runner).timeBased()
          .atHour(slot[0]).nearMinute(slot[1]).everyDays(1)
          .inTimezone('Europe/Moscow').create());
      });
    } catch (error) {
      created.forEach(function(t) { ScriptApp.deleteTrigger(t); });
      throw new Error('Создание не удалось; старое расписание сохранено. ' + String(error.message || error));
    }
    old.forEach(function(t) { ScriptApp.deleteTrigger(t); });
    const actual = ScriptApp.getProjectTriggers();
    if (actual.length !== slots.length || actual.some(function(t) {
      return t.getHandlerFunction() !== runner || t.getEventType() !== ScriptApp.EventType.CLOCK;
    })) throw new Error('Проверьте раздел «Триггеры»: состав после замены отличается от ожидаемого.');
    const times = slots.map(function(s) { return ('0'+s[0]).slice(-2)+':'+('0'+s[1]).slice(-2); });
    const report = {functionName:runner,deleted:old.length,created:actual.length,times:times,timeZone:'Europe/Moscow'};
    console.log('ГОТОВО. Удалено: '+report.deleted+'. Создано: '+report.created+'. Функция: '+runner+'. Время МСК: '+times.join(', ')+'.');
    return report;
  } finally { lock.releaseLock(); }
}
