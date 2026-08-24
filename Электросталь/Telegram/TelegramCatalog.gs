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
    const sourceRows = tcFetchRows_(channel);
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
      if (!entries.length) { skippedSheets.push(name); return; }
      if (!sheet) throw new Error('Нет листа «' + name + '» в стандартной таблице.');
      written += tcWriteSheet_(sheet, entries);
    });
    const now = new Date(); p.setProperty(TC.props.last, String(now.getTime()));
    p.setProperty(TC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return {
      rows: rows.length, written: written,
      cheapest: 0, markedUp: markup.applied, withoutMarkup: markup.withoutRule,
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
  const markedUp = Number(result.markedUp || 0);
  const withoutMarkup = Number(result.withoutMarkup || 0);
  return 'Каталог получен: ' + result.rows + ' позиций. Записано в листы: ' + result.written +
    '. Наценка Электростали применена к ' + markedUp + ' позициям' +
    (withoutMarkup ? '. Без правила наценки: ' + withoutMarkup : '') +
    '. Далее обновляется автоматически каждые 15 минут.';
}
function tcNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
function tcDisplay_(product) { return [product.name, product.variant].filter(Boolean).join(' ').replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim(); }

function tcApplyElektrostalMarkup_(rows) {
  let applied = 0, withoutRule = 0;
  const priced = rows.map(function(row) {
    const amount = tcElektrostalMarkupAmount_(row);
    if (amount === null) { withoutRule++; return Object.assign({}, row); }
    applied++;
    const price = Math.ceil((Number(row.price) + amount) / 500) * 500;
    return Object.assign({}, row, { supplierPrice: row.price, markup: amount, price: price });
  });
  return { rows: priced, applied: applied, withoutRule: withoutRule };
}

function tcElektrostalMarkupAmount_(row) {
  if (!row) return null;
  const price = Number(row.price || 0), name = tcNorm_(tcDisplay_(row));
  if (price < 5000) return null;
  // Электросталь: Apple получает отдельную шкалу. Samsung и Android получают
  // Android-шкалу; та же Android-шкала обязательна для всех остальных
  // категорий (Dyson, приставки, аксессуары и т.д.).
  const apple = /\b(?:iphone|ipad|macbook|imac|apple\s+watch|airpods|apple\s+tv|apple\s+pencil)\b/.test(name);
  const android = /\b(?:samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo)\b/.test(name);
  if (price > 225999) return 15000;
  const bands = apple ? [[15999,3000],[35999,4000],[69999,5000],[89999,6000],[110999,7500],[150999,9000],[225999,13000]] : [[15999,3000],[35999,5000],[69999,7000],[89999,8000],[110999,8500],[150999,10000],[225999,15000]];
  const band = bands.find(function(rule) { return price <= rule[0]; });
  return band ? band[1] : null;
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
  // @astoredirectprice publishes whole catalogues as three lines per item:
  // title, configuration, then "1 шт <price> ₽ · 3+ ...". This must be
  // parsed separately from the older one-line "name — price" template.
  // Электросталь использует основную стоимость за одну единицу.
  if (/цена\s+за\s+объём/i.test(text) && lines.some(function(line) { return /^1\s*шт\s+/i.test(line); })) return tcParseVolumePost_(lines, channel, post);
  const header = lines[0].replace(/^📦\s*/, '').replace(/\s*\(часть\s*\d+\/\d+\)\s*$/i, '');
  // Supplier sections may be named just "Google" or "Honor". The models in
  // their rows still identify the correct destination sheet.
  return lines.slice(1).map(function(line) { return tcLine_(header, line, channel, post); })
    .filter(function(row) { return row && TC.sheets.indexOf(row.category) >= 0; });
}

function tcParseVolumePost_(lines, channel, post) {
  const rows = [], header = String(lines[0] || '').replace(/^[^\p{L}\d]*/u, '').trim();
  let previous = '', brand = '';
  lines.forEach(function(raw) {
    const line = String(raw).replace(/^[\[\]•·▪◦.\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!line || /^(?:цена\s+за\s+объём|\d+\s*шт\s*[—-]\s*основная|нашли\s+дешевле|актуальные\s+позиции)/i.test(line)) return;
    const price = /^1\s*шт\s+([\d\s.]+)\s*₽/i.exec(line);
    if (price) {
      const name = tcVolumeName_(brand, previous);
      const amount = Number(price[1].replace(/[.\s]/g, ''));
      if (name && amount > 0) rows.push({ category: tcCategory_(name), name: name, variant: '', price: amount, post: post, url: 'https://t.me/' + channel + '/' + post });
      return;
    }
    previous = line;
    // A title with an explicit Apple brand is a context only; the following
    // configuration line is the actual SKU.
    if (/^Apple\s*[·.]\s*iPhone\s+\d/i.test(line)) { brand = 'iPhone'; previous = ''; }
    else if (/^Apple\s*[·.]\s*iPad\b/i.test(line)) { brand = 'iPad'; previous = ''; }
    else if (/^Apple\s*[·.]\s*MacBook\b/i.test(line)) { brand = 'MacBook'; previous = ''; }
    else if (/^Apple\s*[·.]\s*Apple\s+Watch\b/i.test(line)) { brand = 'Apple Watch'; previous = ''; }
    else if (/^iPhone\s+\d/i.test(line)) brand = 'iPhone';
    else if (/^iPad\b/i.test(line)) brand = 'iPad';
    else if (/^MacBook\b/i.test(line)) brand = 'MacBook';
    else if (/^Apple\s+Watch\b/i.test(line)) brand = 'Apple Watch';
    // A new non-Apple product begins a new context. Without this reset a
    // later Dyson/Garmin line in one Telegram post inherited "MacBook".
    else if (/^(?:Dyson|Garmin|PlayStation|PS[345]\b|Xbox|Samsung|Galaxy|Pixel|Xiaomi|Redmi|Honor|Huawei|OnePlus|Realme|Oppo|Vivo)\b/i.test(line)) brand = '';
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
  if (/macbook/.test(v)) return 'макбуки';
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
