/**
 * Supplier price sheet → catalogue.
 * The public channel supplies the current price-sheet link.  The sheet itself
 * is the source of truth and rebuilds rows in the existing client tabs without
 * changing their structure or style.
 */
const TC = {
  sheets: ['телефоны', 'макбуки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон', 'аймаки'],
  everyMinutes: 15,
  // Current Uniseil price sheet. The synchronizer discovers this link again
  // from the latest public channel menu before every run, so a supplier link
  // replacement does not bring back historical Telegram products.
  supplierSheetId: '1c2-nEGnaoeCxByKI51EYmEOeSEkE8r0h6AaAa7XZGY4',
  // Публичный файл клиента с правилами наценки. Суммы не хранятся в коде:
  // при каждом обновлении читается его актуальная версия.
  markupSheetId: '1DOuNTe2yJcU6h-TK3-xpWqe6zWpNl0NAQfVVYvZ0IpA',
  // Правила распределены по брендам и товарным группам. Нельзя читать
  // только Apple (gid=0): тогда Android, Dyson, аксессуары и приставки
  // останутся без наценки.
  markupGids: [0, 998621873, 1581268057, 816391661, 72651251, 1869147184,
    385010794, 128937099, 338535652, 463783735, 933137760, 1778122432,
    739113936, 2069038397],
  // The only stage-2 destination. Its tab names and structure stay intact;
  // the template matcher writes only Price after the ready catalogue is built.
  priceTemplate: { spreadsheetId: '16zsIEQF1CqeQJWvskAChZQmZiRZj7NIxrzle_uKDM0I', headerRow: 1, firstDataRow: 2, sheets: {
    'телефоны': { sheetName: 'телефоны', kind: 'phone' }, 'макбуки': { sheetName: 'макбуки', kind: 'title' },
    'айпады': { sheetName: 'айпады', kind: 'title' }, 'часы': { sheetName: 'часы', kind: 'title' },
    'наушники': { sheetName: 'наушники', kind: 'title' }, 'пс': { sheetName: 'пс', kind: 'title' },
    'дайсон': { sheetName: 'дайсон', kind: 'title' }
  } },
  props: { project: 'TC_PROJECT', channel: 'TC_CHANNEL', mirrorTwoSim: 'TC_MIRROR_TWO_SIM', last: 'TC_LAST', status: 'TC_STATUS', templateLastReport: 'TC_TEMPLATE_LAST_REPORT', supplierModels: 'TC_READY_SUPPLIER_MODELS' }
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
// Reconciliation for the separate customer template without rebuilding stage 1.
function runPriceTemplateSyncNow() { tcAssertUlyanovskInvariants_(); const report = tcSyncPriceTemplate_(); return Object.assign(report, { message: tcPriceTemplateSummary_(report) }); }
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
    const book = SpreadsheetApp.getActiveSpreadsheet();
    const sourceRows = tcFetchSupplierSheetRows_(channel).filter(function(row) { return !tcIsAsis_(tcSourceText_(row)); });
    const mirror = tcAddTwoSimMirror_(sourceRows, p.getProperty(TC.props.mirrorTwoSim) === 'true');
    // Одна и та же конфигурация может быть у поставщика из нескольких стран.
    // Для Ульяновска берём только вариант с минимальной закупочной ценой.
    const cheapest = tcChooseCheapestCountry_(mirror.rows);
    const rules = tcLoadUlyanovskMarkup_(), markup = tcApplyUlyanovskMarkup_(cheapest.rows, rules);
    const rows = markup.rows;
    tcAssertBaseIphonesTransferred_(sourceRows, rows);
    const byCategory = {};
    rows.forEach(function(row) { (byCategory[row.category] = byCategory[row.category] || []).push(row); });
    let written = 0; const skippedSheets = [];
    TC.sheets.forEach(function(name) {
      const entries = byCategory[name] || [], sheet = book.getSheetByName(name);
      if (!sheet) throw new Error('Нет листа «' + name + '» в стандартной таблице.');
      written += tcWriteSheet_(sheet, entries);
    });
    // The second stage remains supplier-free. It receives only this compact
    // snapshot from a successful first-stage rebuild for truthful F/O reasons.
    p.setProperty(TC.props.supplierModels, JSON.stringify(tcSupplierModels_(sourceRows)));
    // The completed local catalogue is the only source for the external
    // template: it already has selected country, markup and technical fields.
    SpreadsheetApp.flush();
    const templateSync = tcSyncPriceTemplate_();
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return {
      rows: rows.length, written: written, mirrored: mirror.mirrored,
      cheapest: cheapest.removed, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
      withoutMarkupItems: markup.withoutMarkupItems,
      skippedSheets: skippedSheets, templateSync: templateSync
    };
  } finally { lock.releaseLock(); }
}

/** Stage 2 reads only the completed local catalogue and writes Price only. */
function tcSyncPriceTemplate_() {
  const report = PriceFlowTemplateMatcher.sync({ city:'ulyanovsk', sourceSpreadsheet:SpreadsheetApp.getActiveSpreadsheet(), templateSpreadsheetId:TC.priceTemplate.spreadsheetId, headerRow:TC.priceTemplate.headerRow, firstDataRow:TC.priceTemplate.firstDataRow, sheets:TC.priceTemplate.sheets, allowIphoneAirAlias:true, supplierModels:tcReadySupplierModels_() });
  // Script Properties hold the compact technical result; no audit sheet is created.
  PropertiesService.getScriptProperties().setProperty(TC.props.templateLastReport, JSON.stringify({ at:report.at, updated:report.updated, skippedByReason:report.skippedByReason, ambiguous:Object.keys(report.sheets).reduce(function(all, name) { return all.concat((report.sheets[name].ambiguous || []).map(function(item) { return { sheet:name, title:item.title, prices:item.prices }; })); }, []).slice(0, 50) }));
  return report;
}

function tcPriceTemplateSummary_(report) {
  const reasons = Object.keys(report.skippedByReason || {}).map(function(reason) { return reason + ': ' + report.skippedByReason[reason]; });
  return 'Шаблон цен: обновлено ' + Number(report.updated || 0) + '. ' + (reasons.length ? 'Пропуски — ' + reasons.join(', ') + '.' : 'Пропусков нет.');
}

// These invariants run before every supplier rebuild.  They make accidental
// weakening of SKU matching or markup parsing fail closed, before Avito data
// is touched.  Run manually from Apps Script as tcRunUlyanovskRegressionTests.
function tcRunUlyanovskRegressionTests() { return PriceFlowAvitoMatcher.runRegressionTests(); }
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
    const data = buckets[index].map(function(product, rowIndex) { product.outputRow = rowIndex + 2; product.outputSheet = sheet.getName(); return tcTargetRow_(headers, layout, product); });
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
  if (layout.model >= 0) at(layout.model, tcOutputPhoneModel_(phone, full, product.name));
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
function tcWriteAndroidCalculationLog_(book, rows, missingMarkup) {
  let sheet = book.getSheetByName(TC.androidLogSheet);
  if (!sheet) sheet = book.insertSheet(TC.androidLogSheet);
  const headers = ['Итоговая строка', 'Строка поставщика', 'Товар поставщика', 'Закупочная цена', 'Цветовая группа', 'Правило наценки', 'Наценка', 'Итог', 'Статус'];
  const log = rows.filter(function(row) { const phone = tcPhone_(tcDisplay_(row)); return row.category === 'телефоны' && !/^iphone\b/i.test(phone.model); }).map(function(row) {
    const phone = tcPhone_(tcDisplay_(row));
    return [String(row.outputSheet || 'телефоны') + '!L' + String(row.outputRow || ''), 'Лист1!A' + String(row.sourceRow || ''), tcDisplay_(row), row.supplierPrice || '', tcColorGroup_(phone.color) || 'не указан', tcAndroidMarkupRule_(row), row.markup || '', row.price || '', 'CALCULATED'];
  });
  (missingMarkup || []).forEach(function(item) { log.push(['', '', item, '', '', '', '', '', 'MISSING_MARKUP_RULE']); });
  sheet.clearContents(); sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (log.length) sheet.getRange(2, 1, log.length, headers.length).setValues(log);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  if (log.length) sheet.getRange(2, 4, log.length, 1).setNumberFormat('0');
  if (log.length) sheet.getRange(2, 7, log.length, 2).setNumberFormat('0');
}
function tcAndroidMarkupRule_(row) {
  const name = tcNorm_(tcDisplay_(row));
  if (/galaxy\s+z\s*(?:flip|fold)/.test(name)) return 'Samsung Foldables';
  if (/galaxy\s+s/.test(name)) return 'Samsung Galaxy S';
  if (/galaxy\s+a\d/.test(name)) return 'Samsung Galaxy A';
  return 'Точное правило таблицы';
}
function tcNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
function tcDisplay_(product) { return [product.name, product.variant].filter(Boolean).join(' ').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim(); }
function tcSourceText_(product) { return [tcDisplay_(product), product && product.section, product && product.sourceRow].filter(Boolean).join(' '); }
function tcIsAsis_(value) { return /(?:\b(?:asis|асис|cpo|цпо|open\s*box|refurb(?:ished)?|defect(?:ive)?|faulty|damaged|used|active|б\/?у|бу)\b|уцен|витрин|демо|пред\s*актив|предактив|активир|распак|брак|вскрыт[а-я]*\s*(?:короб|упаков)|поврежд[а-я]*\s*(?:короб|упаков)|мят(?:ая|ый|ой|ую|ые|ых))/iu.test(String(value || '')); }
function tcSupplierModels_(rows) { return Array.from(new Set((rows || []).map(function(row) { return tcPhone_(tcSourceText_(row)).model; }).filter(Boolean).map(tcNorm_))); }
function tcReadySupplierModels_() { try { const stored = JSON.parse(PropertiesService.getScriptProperties().getProperty(TC.props.supplierModels) || '[]'); return Array.isArray(stored) ? stored : []; } catch (error) { return []; } }
function tcAssertBaseIphonesTransferred_(sourceRows, catalogueRows) { const source = tcSupplierModels_(sourceRows), catalogue = tcSupplierModels_(catalogueRows); const missing = source.filter(function(model) { return /^iphone\s+\d+$/.test(model) && catalogue.indexOf(model) < 0; }); if (missing.length) throw new Error(missing.join(', ') + ' найден у поставщика, но не передан в общую таблицу; синхронизация шаблона отменена.'); }
function tcOutputPhoneModel_(phone, full, fallback) {
  const model = phone.model || fallback;
  return tcIsAsis_(full) && !/^\(asis\)\s*/i.test(model) ? '(ASIS) ' + model : model;
}

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
    if (phone.config === '2 SIM') existingTwoSim[tcTwoSimKey_(phone, row)] = true;
  });
  const additions = [];
  rows.forEach(function(row) {
    const phone = tcPhone_(tcDisplay_(row));
    if (phone.config !== 'SIM + eSIM') return;
    const replacement = tcReplaceTwoSim_(row);
    const key = tcTwoSimKey_(tcPhone_(tcDisplay_(replacement)), replacement);
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

function tcTwoSimKey_(phone, row) {
  return [tcIsAsis_(row && tcDisplay_(row)) ? 'asis' : 'new', phone.model, phone.memory, phone.ram, phone.color, phone.country]
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
    // A populated supplier colour is part of the Android SKU. In particular,
    // blue and light-blue must never be collapsed before stage 2 checks it.
    const colorKey = tcNorm_(phone.color) || tcSupplierColorKey_(tcDisplay_(row), phone);
    // SIM and country do not make Android phones different price candidates.
    // iPhone keeps its configuration because its destination grid publishes it.
    const configKey = /^iphone\b/i.test(String(phone.model || '')) ? phone.config : '';
    const key = [row.category, tcIsAsis_(tcDisplay_(row)) ? 'asis' : 'new', phone.model || fallback, configKey, phone.memory, phone.ram, colorKey]
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
// Unknown supplier finishes must never collapse into one "no colour" SKU.
function tcSupplierColorKey_(value, phone) {
  if (phone && phone.color) return tcNorm_(phone.color);
  return tcNorm_(value).replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ').replace(/(?:galaxy\s+(?:s|a|m)\d+(?:\s+(?:fe|ultra|plus))?|galaxy\s+z\s+(?:flip|fold)\d+(?:\s+ultra)?|iphone\s+[^\s]+|\d+\s*\/\s*\d+\s*(?:gb|гб|tb|тб)?|\d+\s*(?:gb|гб|tb|тб)|sim\s*\+\s*e\s*-?sim|e\s*-?sim|2\s*sim|dual\s*-?sim)/giu, ' ').replace(/\s+/g, ' ').trim();
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
  let applied = 0, withoutRule = 0; const withoutMarkupItems = [];
  const priced = rows.map(function(row) {
    const amount = tcMarkupAmount_(row, rules);
    if (amount === null) { withoutRule++; withoutMarkupItems.push(tcDisplay_(row)); return null; }
    applied++;
    return Object.assign({}, row, { supplierPrice: row.price, markup: amount, price: Number(row.price) + amount });
  }).filter(Boolean);
  return { rows: priced, applied: applied, withoutRule: withoutRule, withoutMarkupItems: withoutMarkupItems };
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
  // Android supplier names may repeat a technical marker (`(5G) 5G`) that is
  // not part of the catalogue model.  Resolve the markup by the parsed SKU,
  // never by the first similarly named rule.  Colour stays mandatory first;
  // it is relaxed only for the markup amount (not for the catalogue SKU) and
  // only when all approved sibling rules have one and the same amount.
  const androidSkuKey = tcAndroidMarkupKey_(display, false);
  const androidSkuAmount = tcUniqueRuleAmount_(rules, function(rule) {
    return tcAndroidMarkupKey_(rule.label, false) === androidSkuKey;
  });
  if (androidSkuKey && androidSkuAmount !== null) return androidSkuAmount;
  const androidConfigurationKey = tcAndroidMarkupKey_(display, true);
  const androidConfigurationAmount = tcUniqueRuleAmount_(rules, function(rule) {
    return tcAndroidMarkupKey_(rule.label, true) === androidConfigurationKey;
  });
  if (androidConfigurationKey && androidConfigurationAmount !== null) return androidConfigurationAmount;
  // The approved Redmi Note Pro policy is a product tier, rather than a
  // one-off year number.  It remains strictly `Note ... Pro`: no Pro+, base
  // Note, Ultra or a different RAM/memory configuration can use this branch.
  const androidFamilyKey = tcAndroidMarkupFamilyKey_(display);
  const androidFamilyAmount = tcUniqueRuleAmount_(rules, function(rule) {
    return tcAndroidMarkupFamilyKey_(rule.label) === androidFamilyKey &&
      tcAndroidMarkupKey_(rule.label, true).replace(/^[^|]*\|/, '') === androidConfigurationKey.replace(/^[^|]*\|/, '');
  });
  if (androidFamilyKey && androidFamilyAmount !== null) return androidFamilyAmount;
  // Supplier writes `Dyson HD…`, while the approved rule sheet stores the
  // same exact SKU as `HD…`. This exception is limited to Dyson only.
  if (/^dyson\b/.test(productKey)) {
    const dysonKey = productKey.replace(/^dyson\s+/, '');
    const dysonAmounts = rules.filter(function(rule) { return tcMarkupKey_(rule.label) === dysonKey; })
      .map(function(rule) { return rule.amount; }).filter(function(amount, index, values) { return values.indexOf(amount) === index; });
    if (dysonKey && dysonAmounts.length === 1) return dysonAmounts[0];
  }
  if (/airpods/.test(name)) return find(/наушники\s+airpods/);
  if (/\bwatch\b/.test(name)) return find(/^часы$/);
  if (/macbook/.test(name)) return find(/^macbook/);
  if (/\b(imac|mini)\b/.test(name)) return find(/imac\/mini/);
  if (/ipad/.test(name)) return find(/\bpro\b/.test(name) ? /^ipad\s+pro$/ : /ipad.*кроме\s+про/);
  if (!/^iphone\b/.test(name)) {
    // A generic Pixel rule is valid only when the rule sheet actually has
    // one.  Do not take the first concrete Pixel SKU (for example Pixel 7)
    // for a different generation.
    if (/\bpixel\b/.test(name)) return tcUniqueRuleAmount_(rules, function(rule) {
      return /^(?:google\s+)?pixel$/.test(tcNorm_(rule.label));
    });
    if (/galaxy\s*buds/.test(name)) return find(/galaxy\s*buds/);
    if (/galaxy\s*watch/.test(name)) return find(/galaxy\s*watch/);
    if (/galaxy\s*tab\s*s/.test(name)) return find(/galaxy\s*tab\s*s.*сер/);
    if (/galaxy\s*tab\s*a/.test(name)) return find(/galaxy\s*tab\s*a.*сер/);
    if (/galaxy\s*(?:s|z\s*(?:fold|flip))/.test(name)) return find(/s\s*-\s*сер|z\s*-?fold/);
    if (/galaxy\s*a\d/.test(name)) return find(/a\s*-\s*сер/);
    return null;
  }

  const memoryMatch = /^(\d+)\s*(ГБ|GB|ТБ|TB)$/i.exec(String(phone.memory || '').trim());
  const memoryGb = memoryMatch ? Number(memoryMatch[1]) * (/тб|tb/i.test(memoryMatch[2]) ? 1024 : 1) : 0;
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
    .replace(/\bdisk(?:drive)?\b/gi, 'disc')
    .replace(/(\d+)\s*(?:gb|гб)/gi, '$1gb').replace(/(\d+)\s*(?:tb|тб)/gi, '$1tb')
    .replace(/[^a-zа-я0-9]+/gi, ' ').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function tcUniqueRuleAmount_(rules, predicate) {
  const amounts = rules.filter(predicate).map(function(rule) { return rule.amount; })
    .filter(function(amount, index, values) { return values.indexOf(amount) === index; });
  return amounts.length === 1 ? amounts[0] : null;
}

// Key for markup resolution only.  The ready catalogue retains the complete
// Android SKU, including its technical source attribute, and stage 2 still
// compares Model/RAM/memory/colour exactly.
function tcAndroidMarkupKey_(value, omitColor) {
  const phone = tcPhone_(value);
  if (!phone.model || !phone.ram || !phone.memory) return '';
  return [phone.model, phone.ram, phone.memory, omitColor ? '' : phone.color]
    .map(tcNorm_).join('|');
}

function tcAndroidMarkupFamilyKey_(value) {
  const model = tcNorm_(tcPhone_(value).model);
  return /^redmi note \d+ pro$/.test(model) ? model.replace(/\d+/, '#') : '';
}

// The supplier publishes one complete, editable price sheet in the current
// channel menu. Its snapshot is authoritative: a successful read always
// rebuilds every existing product tab, including an empty tab when a section
// has disappeared. This intentionally never merges historical Telegram posts.
function tcFetchSupplierSheetRows_(channel) {
  const sheetId = tcDiscoverSupplierSheetId_(channel);
  const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=csv&gid=0';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось прочитать актуальный прайс поставщика (HTTP ' + response.getResponseCode() + '). Каталог не изменён.');
  }
  const rows = tcParseSupplierSheetCsv_(response.getContentText(), sheetId);
  if (!rows.length) throw new Error('В актуальном прайсе поставщика не найдено ни одной подтверждённой цены. Каталог не изменён.');
  return rows;
}

function tcDiscoverSupplierSheetId_(channel) {
  const fallback = TC.supplierSheetId;
  const response = UrlFetchApp.fetch('https://t.me/s/' + channel, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return fallback;
  const found = /https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/i.exec(response.getContentText());
  return found && found[1] || fallback;
}

function tcParseSupplierSheetCsv_(csv, sheetId) {
  const table = Utilities.parseCsv(String(csv || '')), rows = [];
  let header = '';
  table.forEach(function(cells, rowIndex) {
    const item = String(cells[0] || '').trim(), priceText = String(cells[1] || '').trim();
    if (!item) return;
    if (!priceText) { header = item; return; }
    const row = tcLine_(header, item + ' — ' + priceText, 'opt_uniseil', 'supplier-sheet');
    if (!row) return;
    const category = tcSupplierCategory_(header, row.name);
    if (TC.sheets.indexOf(category) < 0) return;
    rows.push(Object.assign(row, {
      category: category,
      section: 'sheet:' + tcNorm_(header),
      sourceRow: rowIndex + 1,
      url: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit'
    }));
  });
  return rows;
}

function tcSupplierCategory_(header, name) {
  const h = tcNorm_(header), item = tcNorm_(name);
  // Android and Google are supplier section names, not model names. Preserve
  // every current phone in them (Nothing and Tecno do not contain a legacy
  // brand recognised by tcCategory_). The other mappings retain the existing
  // Ulyanovsk category rules.
  if (h === 'android' || h === 'google') return 'телефоны';
  if (h === 'naushniki i kolonki' || h === 'airpods') return 'наушники';
  if (h === 'igrovye pristavki') return 'пс';
  if (h === 'dyson') return 'дайсон';
  if (/^macbook/.test(h)) return 'макбуки';
  if (/^ipad/.test(h)) return 'айпады';
  if (/watch/.test(h)) return 'часы';
  if (/imac/.test(h)) return 'аймаки';
  return tcCategory_(header + ' ' + item);
}

function tcFetchRows_(channel) {
  // Apple, Android and other supplier sections are updated independently.
  // Keep the newest post for every section instead of treating one page as
  // the whole catalogue or merging every historical SKU indiscriminately.
  let url = 'https://t.me/s/' + channel, page = 0; const rows = [], newest = {};
  while (url && page++ < 12) {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('Telegram вернул HTTP ' + response.getResponseCode());
    const parsed = tcParsePreview_(response.getContentText(), channel);
    parsed.rows.forEach(function(row) {
      rows.push(row);
      const section = row.section || tcNorm_(row.category);
      newest[section] = Math.max(Number(newest[section] || 0), Number(row.post || 0));
    });
    url = parsed.previous ? 'https://t.me' + parsed.previous : '';
  }
  if (!rows.length) throw new Error('В Telegram не найдено ни одной подтверждённой цены. Каталог не изменён.');
  const unique = {};
  rows.filter(function(row) { return Number(row.post || 0) === newest[row.section || tcNorm_(row.category)]; }).forEach(function(row) {
    const key = (row.section || '') + '|' + tcNorm_(row.name).replace(/[^a-zа-я0-9]+/g, ' ') + '|' + tcNorm_(row.variant);
    if (!unique[key]) unique[key] = row;
  });
  return Object.keys(unique).map(function(key) { return unique[key]; });
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

function tcLine_(header, line, channel, post) {
  const match = /^(.*?)\s*(?:-|—|–)\s*([\d\s]{3,})\s*(?:₽|руб\.?|rub)?\s*$/i.exec(line);
  if (!match) return null;
  let core = match[1].replace(/\s+/g, ' ').trim(), variant = '';
  const suffix = /(\([^)]*\))\s*$/u.exec(core); if (suffix) { variant = suffix[1]; core = core.slice(0, suffix.index).trim(); }
  const flag = /([\u{1F1E6}-\u{1F1FF}]{2})\s*$/u.exec(core); if (flag) { variant = (flag[1] + (variant ? ' ' + variant : '')).trim(); core = core.slice(0, flag.index).trim(); }
  const name = tcExpand_(header, core), price = Number(match[2].replace(/\s/g, ''));
  return name && price > 0 ? { category: tcCategory_(header + ' ' + name), name: name, variant: variant, price: price, post: post, url: 'https://t.me/' + channel + '/' + post } : null;
}

function tcExpand_(header, item) {
  const rawHeader = String(header).trim(), h = rawHeader.replace(/\\/g, ' ').replace(/\s+/g, ' ').trim(), i = String(item).trim();
  // A current supplier section intentionally combines two base models. Each
  // price row begins with its actual model, so never assign the header's 17e
  // to an ordinary 17 row.
  const mixedHeader = /^iphone\s+(\d+)e\s*(?:\\|\/)\s*\1$/i.exec(rawHeader);
  if (mixedHeader) {
    const mixed = /^(?:iphone\s+)?(\d+e?)(?:\s+|$)(.*)$/i.exec(i);
    if (mixed && (mixed[1] === mixedHeader[1] || mixed[1] === mixedHeader[1] + 'e')) return 'iPhone ' + mixed[1] + (mixed[2] ? ' ' + mixed[2].trim() : '');
  }
  // In the mixed MacBook section the leading article is not a model. The
  // family stated in the row wins, so Air rows never inherit Neo from header.
  if (/^macbook\s+neo\s*(?:\\|\/)\s*air$/i.test(rawHeader)) {
    const family = /\b(neo|air)\b/i.exec(i);
    if (family) return 'MacBook ' + family[1].replace(/^./, function(letter) { return letter.toUpperCase(); }) + ' ' + i.slice(family.index + family[0].length).trim();
  }
  // In Uniseil posts a section can already contain the model ("iPhone 16 Pro")
  // while each line starts with it again ("16 Pro 128GB …").  Keep one model
  // name only; duplicated text previously made diagnostics and exact matching
  // needlessly fragile.
  const iphone = /^iphone\s+(.+)$/i.exec(h);
  if (iphone && !/^iphone\s/i.test(i)) {
    const tail = iphone[1].trim();
    const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repeated = new RegExp('^' + escaped + '(?:\\s+|$)', 'i');
    return 'iPhone ' + tail + (repeated.test(i) ? ' ' + i.replace(repeated, '').trim() : ' ' + i);
  }
  if (/^macbook\b/i.test(h) && !/^macbook\b/i.test(i)) return h + ' ' + i;
  if (/^dyson\b/i.test(h) && !/^dyson\b/i.test(i)) return h + ' ' + i;
  if (/^airpods\b/i.test(h) && !/^airpods\b/i.test(i)) return h + ' ' + i;
  if (/^imac\b/i.test(h) && !/^imac\b/i.test(i)) return h + ' ' + i;
  if (/^watch\b/i.test(h) && /^watch\b/i.test(i)) return 'Apple ' + i;
  return i;
}
function tcCategory_(value) { const v = tcNorm_(value); if (/iphone|galaxy|pixel|xiaomi|redmi|poco|samsung|honor|huawei|oneplus|realme|nothing|tecno/.test(v)) return 'телефоны'; if (/macbook/.test(v)) return 'макбуки'; if (/ipad/.test(v)) return 'айпады'; if (/watch/.test(v)) return 'часы'; if (/airpods|наушники|колонки/.test(v)) return 'наушники'; if (/playstation|\bps[345]\b|xbox/.test(v)) return 'пс'; if (/dyson/.test(v)) return 'дайсон'; if (/imac/.test(v)) return 'аймаки'; return 'прочее'; }
function tcPhone_(value) {
  const text = String(value || ''), specs = /(\d{1,2})\s*\/\s*(\d{1,4})\s*(гб|gb|тб|tb)/i.exec(text);
  const memory = specs ? null : /(?:^|\s)(\d{1,4})\s?(гб|gb|тб|tb)(?=\s|$)/i.exec(text);
  const unit = function(amount, suffix) { return /тб|tb/i.test(suffix) ? String(Number(amount) * 1024) + ' ГБ' : amount + ' ГБ'; };
  const sim = /\b(?:2\s*(?:sim|сим)|dual\s*-?\s*sim)\b/i.test(text) ? '2 SIM' : /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : '';
  return { model: tcModel_(text), memory: specs ? unit(specs[2], specs[3]) : memory ? unit(memory[1], memory[2]) : '', ram: specs ? unit(specs[1], 'GB') : '', color: tcColor_(text), config: sim, country: tcCountry_(text), technical: tcAndroidTechnicalModifiers_(text) };
}
function tcModel_(value) {
  const text = String(value || '').replace(/\(\s*asis\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  const iphone = /\biphone\s+(\d+(?:e)?(?:\s+(?:air|pro\s*max|pro|plus|mini))?)/i.exec(text);
  if (iphone) return 'iPhone ' + iphone[1].replace(/\s+/g, ' ').trim();
  const other = /\b(galaxy\s+(?:(?:s|a|m)\d+(?:\+|\s+(?:ultra|fe|plus))?|z\s+(?:flip|fold)\d+(?:\s+ultra)?)|pixel\s+\d+(?:[a-z])?(?:\s+(?:pro(?:\s+fold|\s+xl)?|xl))?|honor\s+[\w-]+(?:\s+(?:pro|lite|x\d+d?))?|huawei\s+(?:nova\s+\d+(?:\s+(?:pro|i|se))?|pura\s+[\w-]+(?:\s+(?:pro(?:\s+max)?|ultra|plus))?)|(?:xiaomi|redmi|poco)\s+(?:note\s+)?[\w-]+(?:\s+(?:pro\+?|plus|ultra|max|t))?|oneplus\s+[\w-]+(?:\s+(?:pro|r|t))?|realme\s+[\w-]+(?:\s+(?:pro|plus))?|nothing\s+phone\s*\(?[\w-]+\)?(?:\s+(?:pro|plus))?)/i.exec(text);
  if (!other) return '';
  // 4G/5G/NFC remain an original technical attribute, not a model suffix.
  // Thus an unspecified template model may match it, while an explicit
  // suffix still remains a different template model until separately agreed.
  return other[1].replace(/\s+/g, ' ').trim();
}
function tcAndroidTechnicalModifiers_(value) {
  const text = tcNorm_(value), modifiers = [];
  if (/\b4\s*g\b/.test(text)) modifiers.push('4G');
  if (/\b5\s*g\b/.test(text)) modifiers.push('5G');
  if (/\bnfc\b/.test(text)) modifiers.push('NFC');
  if (/\blte\b/.test(text)) modifiers.push('LTE');
  return modifiers.join(' ');
}
function tcCountry_(value) { const flag = /(🇺🇸|🇯🇵|🇭🇰|🇰🇷|🇮🇳|🇨🇦|🇸🇬|🇦🇪|🇷🇺|🇨🇳|🇪🇺|🇦🇺|🇰🇼|🇮🇩|🇧🇷)/u.exec(String(value || '')); const names = {'🇺🇸':'США','🇯🇵':'Япония','🇭🇰':'Гонконг','🇰🇷':'Корея','🇮🇳':'Индия','🇨🇦':'Канада','🇸🇬':'Сингапур','🇦🇪':'ОАЭ','🇷🇺':'Россия','🇨🇳':'Китай','🇪🇺':'Европа','🇦🇺':'Австралия','🇰🇼':'Кувейт','🇮🇩':'Индонезия','🇧🇷':'Бразилия'}; return flag ? names[flag[1]] + ' ' + flag[1] : ''; }
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
    ['ultramarine','ультрамарин'],['graphite','графитовый'],['coral','коралловый'],['teal','бирюзовый'],['lavender','лавандовый'],['lilac','фиолетовый'],['violet','фиолетовый'],['indigo','индиго'],['porcelain','фарфоровый'],['hazel','ореховый'],['aloe','алоэ'],['peony','пионовый'],['wintergreen','зимний зеленый'],['charcoal','угольный'],['sage','шалфейный'],['mint','мятный'],['cream','кремовый'],
    // Supplier shade names are intentionally grouped into the closest Avito
    // colour rather than blocking a sale over a cosmetic naming difference.
    ['jetblack','черный'],['jet black','черный'],['black','черный'],['graphite','черный'],['charcoal','черный'],['midnight','черный'],['silver shadow','серый'],['silvershadow','серый'],['lightgray','серый'],['light gray','серый'],['graygreen','зеленый'],['gray green','зеленый'],['whitesilver','белый'],['white silver','белый'],['cobalt violet','фиолетовый'],['cobaltviolet','фиолетовый'],['violet shadow','фиолетовый'],['violetshadow','фиолетовый'],['navy','синий'],['cobalt blue','синий'],['cobaltblue','синий'],['sky blue','голубой'],['skyblue','голубой'],['icy blue','голубой'],['icyblue','голубой'],['silver blue','голубой'],['silverblue','голубой'],['titanium','титан'],['lemongrass','лимонный'],['obsidian','черный'],['snow','белый'],['bay','голубой'],['fog','серый'],['olive','оливковый'],['starlight','сияющая звезда'],['natural','натуральный'],['desert','пустынный'],
    ['черный','черный'],['белый','белый'],['синий','синий'],['голубой','голубой'],['зеленый','зеленый'],['розовый','розовый'],['желтый','желтый'],['серебристый','серебристый'],['серебряный','серебристый'],['серый','серый'],['оранжевый','оранжевый'],['фиолетовый','фиолетовый'],['лавандовый','лавандовый'],['бирюзовый','бирюзовый'],['графитовый','графитовый'],['коралловый','коралловый'],['красный','красный'],['золотистый','золотистый'],
    ['black','черный'],['white','белый'],['blue','синий'],['green','зеленый'],['pink','розовый'],['yellow','желтый'],['silver','серебристый'],['gray','серый'],['grey','серый'],['orange','оранжевый'],['purple','фиолетовый'],['violet','фиолетовый'],['red','красный'],['gold','золотистый']
  ];
  const padded = ' ' + v + ' ';
  const hit = colors.find(function(pair) { return padded.indexOf(' ' + pair[0] + ' ') >= 0; });
  return hit ? tcAvitoColor_(v, hit[1]) : '';
}
function tcColorGroup_(value) {
  const color = tcNorm_(value).replace(/ё/g, 'е');
  if (!color || color === 'не знаю') return '';
  if (/черн|сер|графит|graphite|gray|grey|charcoal|jet\s*black/.test(color)) return 'black';
  if (/син|голуб|небес|icy|sky|silverblue|silver\s*blue|navy|cobalt\s*blue/.test(color)) return 'blue';
  if (/бел|silver|white/.test(color)) return 'white';
  if (/зелен|mint|olive/.test(color)) return 'green';
  if (/фиолет|lavender|lilac|cobalt\s*violet|violet\s*shadow/.test(color)) return 'violet';
  if (/розов|pink/.test(color)) return 'pink';
  if (/беж|cream/.test(color)) return 'beige';
  if (/золот|gold/.test(color)) return 'gold';
  return '';
}
// Значения Color сверяются с эталонной автозагрузкой Avito. Фирменное имя
// сохраняется в названии товара, а в отдельную колонку попадает только цвет
// из списка Avito; для синего учитывается конкретная модель.
function tcAvitoColor_(source, detected) {
  const v = tcColorKey_(source);
  // Android supplier colour marketing names are SKU colours, not cosmetic
  // hints. Keep this dictionary local to Android field normalisation.
  if (/\b(?:galaxy|pixel)\b/i.test(v)) {
    if (/titanium\s+(?:black|jetblack)|awesome\s+graphite|\bobsidian\b/.test(v)) return 'черный';
    if (/titanium\s+whitesilver/.test(v)) return 'белый';
    if (/titanium\s+silverblue/.test(v)) return 'синий';
    if (/titanium\s+gray|\bgraphite\b/.test(v)) return 'серый';
    if (/awesome\s+olive/.test(v)) return 'зеленый';
    if (/\bcream\b/.test(v)) return 'бежевый';
    if (/lavender|cobalt\s+violet|violet\s+shadow/.test(v)) return 'фиолетовый';
    if (/sky\s+blue|icy\s*blue/.test(v)) return 'голубой';
  }
  if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b))/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой';
  const pairs = [['натуральный','серый'],['серый космос','серый'],['графитовый','черный'],['угольный','черный'],['обсидиан','черный'],['титан','серый'],['пустынный','золотистый'],['кремовый','бежевый'],['ореховый','бежевый'],['фарфоровый','белый'],['сияющая звезда','белый'],['темно фиолетовый','фиолетовый'],['лавандовый','фиолетовый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['индиго','синий'],['полночный','черный'],['темно зеленый','зеленый'],['зимний зеленый','зеленый'],['шалфейный','зеленый'],['мятный','зеленый'],['алоэ','зеленый'],['розовое золото','розовый'],['коралловый','розовый'],['пионовый','розовый'],['лимонный','желтый']];
  const hit = pairs.find(function(pair) { return tcColorKey_(detected) === pair[0]; });
  return hit ? hit[1] : tcColorKey_(detected);
}
