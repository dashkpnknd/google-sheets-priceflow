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
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return {
      rows: rows.length, written: written, mirrored: mirror.mirrored,
      cheapest: cheapest.removed, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
      skippedSheets: skippedSheets
    };
  } finally { lock.releaseLock(); }
}

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
  const url = 'https://docs.google.com/spreadsheets/d/' + TC.markupSheetId + '/export?format=csv&gid=0';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось прочитать файл наценок Ульяновска. Проверьте доступ к нему.');
  }
  const rules = tcParseMarkupCsv_(response.getContentText());
  if (!rules.length) throw new Error('В файле наценок Ульяновска не найдены правила.');
  return rules;
}

function tcParseMarkupCsv_(csv) {
  const table = Utilities.parseCsv(String(csv || ''));
  return table.slice(1).map(function(row) {
    const label = String(row[0] || '').trim();
    const amount = Number(String(row[1] || '').replace(/[^\d.,-]/g, '').replace(',', '.'));
    return label && Number.isFinite(amount) ? { label: label, amount: amount } : null;
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
  const name = tcNorm_(tcDisplay_(row)), phone = tcPhone_(tcDisplay_(row));
  const find = function(pattern) {
    const hit = rules.find(function(rule) { return pattern.test(tcNorm_(rule.label)); });
    return hit ? hit.amount : null;
  };
  if (/airpods/.test(name)) return find(/наушники\s+airpods/);
  if (/\bwatch\b/.test(name)) return find(/^часы$/);
  if (/macbook/.test(name)) return find(/^macbook/);
  if (/\b(imac|mini)\b/.test(name)) return find(/imac\/mini/);
  if (/ipad/.test(name)) return find(/\bpro\b/.test(name) ? /^ipad\s+pro$/ : /ipad.*кроме\s+про/);
  if (!/^iphone\b/.test(name)) return null;

  const memoryGb = Number(String(phone.memory || '').replace(/[^\d]/g, ''));
  const premium = /^iphone\s+17\s+(?:pro|max|pro\s+max)\b/.test(name) && memoryGb >= 512;
  if (premium) {
    const amount = find(/iphone\s+17\s+pro.*512.*17\s+pro\s+max.*512/);
    if (amount !== null) return amount;
  }
  return find(/iphone\s+13.*17\s+pro\s+max.*256/);
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
