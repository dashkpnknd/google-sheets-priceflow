/**
 * Яблочный Спас | Орск — RM Group Client API.
 * API token is saved only in Script Properties, never in this source.
 * Prices are written exactly as RM Group returns them: price rules are pending
 * separate confirmation from the customer.
 */
const RMG = {
  endpoint: 'https://api-c.rmgroup.website/', everyMinutes: 15,
  sheets: ['телефоны', 'аксессуары', 'макбуки', 'аймаки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон'],
  props: { project: 'RMG_PROJECT', token: 'RMG_TOKEN', last: 'RMG_LAST', status: 'RMG_STATUS' }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог RM Group')
    .addItem('Подключить RM Group', 'showRMGroupCatalogSidebar')
    .addSeparator().addItem('Пересобрать каталог сейчас', 'runRMGroupCatalogNow').addToUi();
}
function showRMGroupCatalogSidebar() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('RMGroupCatalogSidebar').setTitle('Каталог RM Group').setWidth(380)); }
function getRMGroupCatalogSetup() { const p = PropertiesService.getScriptProperties(); return { project: p.getProperty(RMG.props.project) || '', connected: Boolean(p.getProperty(RMG.props.token)), lastSync: p.getProperty(RMG.props.last) || '', status: p.getProperty(RMG.props.status) || 'Ожидает токен RM Group' }; }
function saveRMGroupCatalogSetup(form) {
  const project = String(form && form.project || '').trim(), token = String(form && form.token || '').trim();
  if (!/^.{2,}\s*\|\s*.{2,}$/.test(project)) throw new Error('Укажите магазин в формате «Магазин | Город».');
  if (token.length < 16) throw new Error('Введите токен RM Group.');
  rmgFetch_(token); // validate access before saving it
  const p = PropertiesService.getScriptProperties(); p.setProperty(RMG.props.project, project); p.setProperty(RMG.props.token, token); rmgEnsureTrigger_();
  return Object.assign(getRMGroupCatalogSetup(), { message: rmgSummary_(syncRMGroupCatalog_()) });
}
function runRMGroupCatalogNow() { rmgEnsureTrigger_(); return Object.assign(getRMGroupCatalogSetup(), { message: rmgSummary_(syncRMGroupCatalog_()) }); }
function syncRMGroupCatalog() { if (!PropertiesService.getScriptProperties().getProperty(RMG.props.token)) return { rows: 0, written: 0, skipped: RMG.sheets }; return syncRMGroupCatalog_(); }
function rmgEnsureTrigger_() { ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'syncRMGroupCatalog') ScriptApp.deleteTrigger(t); }); ScriptApp.newTrigger('syncRMGroupCatalog').timeBased().everyMinutes(RMG.everyMinutes).create(); }

function syncRMGroupCatalog_() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { rows: 0, written: 0, skipped: [] };
  try {
    const p = PropertiesService.getScriptProperties(), token = p.getProperty(RMG.props.token); if (!token) throw new Error('Сначала подключите RM Group.');
    const rows = rmgFetch_(token).map(rmgItem_).filter(Boolean), grouped = {}, book = SpreadsheetApp.getActiveSpreadsheet(), skipped = []; let written = 0;
    rows.forEach(function(row) { (grouped[row.category] = grouped[row.category] || []).push(row); });
    RMG.sheets.forEach(function(name) { const sheet = book.getSheetByName(name), products = grouped[name] || []; if (!sheet) { skipped.push(name); return; } written += rmgWrite_(sheet, products); });
    p.setProperty(RMG.props.last, String(Date.now())); p.setProperty(RMG.props.status, 'Обновлено: ' + written + ' позиций.'); return { rows: rows.length, written: written, skipped: skipped };
  } finally { lock.releaseLock(); }
}
function rmgFetch_(token) {
  const response = UrlFetchApp.fetch(RMG.endpoint, { method: 'post', contentType: 'application/json', headers: { Auth: token, Accept: 'application/json' }, payload: JSON.stringify({ method: 'pricelist.get' }), muteHttpExceptions: true });
  const code = response.getResponseCode(), text = response.getContentText();
  if (code === 425) throw new Error('RM Group отдаёт прайс только с 11:00 до 18:00 МСК. Повторите в рабочее время прайса.');
  if (code < 200 || code >= 300) throw new Error('RM Group API ' + code + '. Проверьте токен и регистрацию приложения.');
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error('RM Group вернул не JSON.'); }
  if (!data || data.method !== 'pricelist.get' || !Array.isArray(data.result)) throw new Error('RM Group вернул неожиданный формат прайс-листа.');
  return rmgItems_(data.result);
}
// API RM Group возвращал прайс блоками {items:[...]}, а сейчас возвращает
// прямой массив товаров. Поддерживаем оба формата, чтобы не получать ложные
// «0 позиций» при действующем токене.
function rmgItems_(result) {
  return result.reduce(function(all, entry) {
    if (Array.isArray(entry && entry.items)) return all.concat(entry.items);
    return entry && typeof entry === 'object' ? all.concat(entry) : all;
  }, []);
}
function rmgItem_(item) {
  if (!item || !item.name || !Number.isFinite(Number(item.cost)) || Number(item.cost) <= 0) return null;
  const name = rmgName_(item), category = rmgCategory_([item.brand, item.category, item.subcategory, name].join(' ')); if (RMG.sheets.indexOf(category) < 0) return null;
  return { category: category, name: name, country: rmgCountry_(item.country), price: Number(item.cost), id: String(item.id || '') };
}
function rmgName_(item) {
  const category = String(item.category || '').trim(), subcategory = String(item.subcategory || '').trim(), name = String(item.name || '').trim();
  if (!category || new RegExp('^' + rmgEscape_(category) + '\\b', 'i').test(name)) return name;
  // В прайсе Samsung модель лежит в subcategory (например, «Galaxy A57»),
  // а строка варианта начинается только с «A57». Восстанавливаем полное
  // название до записи в таблицу.
  if (/^samsung$/i.test(String(item.brand || '')) && /^galaxy\b/i.test(subcategory)) return rmgExpandName_(subcategory, name);
  if (/^(iphone|ipad|macbook|apple watch|watch|airpods|dyson|playstation|ps\d|xbox)$/i.test(category)) return category.replace(/^watch$/i, 'Apple Watch') + ' ' + name;
  return name;
}
function rmgExpandName_(label, name) {
  const full = String(label || '').trim(), value = String(name || '').trim();
  if (!full || !value || new RegExp('^' + rmgEscape_(full) + '\\b', 'i').test(value)) return value || full;
  const tail = full.split(/\s+/).pop();
  return new RegExp('^' + rmgEscape_(tail) + '\\b', 'i').test(value) ? full + value.slice(tail.length) : full + ' ' + value;
}
function rmgCategory_(value) { const v = rmgNorm_(value); if (/airpods|earpods|buds|наушник|headphone|jbl|harman|marshall/.test(v)) return 'наушники'; if (/аксессуар|чехол|case\b|кабель|заряд|адаптер|держател|ремеш|gamepad|controller|док\b|подставк|дисковод|pitaka|google\s+аксессуар/.test(v)) return 'аксессуары'; if (/macbook|mac mini/.test(v)) return 'макбуки'; if (/\bimac\b/.test(v)) return 'аймаки'; if (/ipad|galaxy tab|poco pad|tablet/.test(v)) return 'айпады'; if (/apple watch|galaxy watch|\bwatch\b/.test(v)) return 'часы'; if (/dyson/.test(v)) return 'дайсон'; if (/playstation|\bps[345]\b|xbox|nintendo|oculus|steam deck/.test(v)) return 'пс'; if (/iphone|samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo|poco|nothing/.test(v)) return 'телефоны'; return 'прочее'; }
function rmgCountry_(code) { const key = String(code || '').trim().toUpperCase(), countries = { US:['США','🇺🇸'],EU:['Европа','🇪🇺'],RU:['Россия','🇷🇺'],CN:['Китай','🇨🇳'],JP:['Япония','🇯🇵'],AE:['ОАЭ','🇦🇪'],IN:['Индия','🇮🇳'],HK:['Гонконг','🇭🇰'],KR:['Южная Корея','🇰🇷'],CA:['Канада','🇨🇦'] }, hit = countries[key]; return hit ? hit[0] + ' ' + hit[1] : key; }
function rmgInfo_(name) { const text = String(name || ''), model = /\b(iPhone\s+(?:Air|\d+(?:e)?(?:\s+(?:Pro Max|Pro|Plus|mini|Air))?)|iPad\s+[^\d]*\d+|MacBook\s+(?:(?:Air|Pro|Neo)\s+)?\d+|Apple Watch\s+[^\d]*\d+mm|Galaxy\s+[A-Z]\d+(?:\+|\s+(?:Ultra|FE|Plus))?)/i.exec(text), specs = /(\d{1,2})\s*\/\s*(\d{1,4})(?:\s*(гб|gb|тб|tb))?/i.exec(text), memory = specs ? null : /(?:\b(64|128|256|512|1024|2048)\s*(гб|gb|тб|tb)?\b|\b(1|2)\s*(гб|gb|тб|tb)\b)/i.exec(text), unit = function(n, u) { return n + ' ' + String(u || 'GB').toUpperCase().replace('GB', 'ГБ').replace('TB', 'ТБ'); }; return { model: model ? model[1] : '', ram: specs ? unit(specs[1], 'GB') : '', memory: specs ? unit(specs[2], specs[3]) : memory ? unit(memory[1] || memory[3], memory[2] || memory[4]) : '', sim: /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : '', color: rmgColor_(text) }; }
function rmgColor_(value) { const v = rmgNorm_(value), pairs = [['rose gold','розовое золото'],['space gray','серый космос'],['natural','натуральный'],['desert','пустынный'],['ultramarine','ультрамарин'],['teal','бирюзовый'],['midnight','полуночный'],['starlight','сияющая звезда'],['lavender','лавандовый'],['sage','шалфейный'],['black','черный'],['white','белый'],['blue','синий'],['pink','розовый'],['green','зеленый'],['silver','серебристый'],['yellow','желтый'],['gray','серый'],['purple','фиолетовый'],['orange','оранжевый'],['gold','золотой'],['черный','черный'],['белый','белый'],['синий','синий'],['розовый','розовый']]; const hit = pairs.find(function(pair) { return new RegExp('\\b' + pair[0] + '\\b', 'i').test(v); }); return hit ? rmgAvitoColor_(v, hit[1]) : ''; }
function rmgAvitoColor_(source, detected) { const v = rmgNorm_(source); if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b))/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой'; const pairs = [['розовое золото','розовый'],['серый космос','серый'],['натуральный','серый'],['пустынный','золотистый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['полуночный','черный'],['сияющая звезда','белый'],['лавандовый','фиолетовый'],['шалфейный','зеленый'],['золотой','золотистый']], hit = pairs.find(function(pair) { return rmgNorm_(detected) === pair[0]; }); return hit ? hit[1] : rmgNorm_(detected); }
function rmgWrite_(sheet, products) {
  rmgEnsureCountry_(sheet); const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], layouts = rmgLayouts_(headers); if (!layouts.length) throw new Error('На листе «' + sheet.getName() + '» не найдена колонка Price/Цена.');
  const buckets = layouts.map(function() { return []; }); products.forEach(function(p) { buckets[rmgLayout_(layouts, p)].push(p); }); let written = 0;
  layouts.forEach(function(layout, index) { const data = buckets[index].sort(function(a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }) || a.price - b.price; }).map(function(p) { return rmgRow_(layout, p); }), height = Math.max(sheet.getLastRow() - 1, data.length, 1), width = layout.price - layout.start + 1; if (sheet.getMaxRows() < data.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), data.length + 1 - sheet.getMaxRows()); const range = sheet.getRange(2, layout.start + 1, height, width); range.clearDataValidations(); range.clearContent(); if (data.length) { sheet.getRange(2, layout.start + 1, data.length, width).setValues(data); sheet.getRange(2, layout.price + 1, data.length, 1).setNumberFormat('0'); written += data.length; } }); return written;
}
function rmgEnsureCountry_(sheet) { const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], prices = []; headers.forEach(function(v, i) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(v || '').trim())) prices.push(i); }); for (let i = prices.length - 1; i >= 0; i--) { const price = prices[i], start = i ? prices[i - 1] + 1 : 0, hasCountry = headers.slice(start, price + 1).some(function(v) { return /^(country|страна)$/i.test(String(v || '').trim()); }); if (!hasCountry) { sheet.insertColumnBefore(price + 1); sheet.getRange(1, price + 1).setValue('Country'); } } }
function rmgLayouts_(headers) { const prices = []; headers.forEach(function(v, i) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(v || '').trim())) prices.push(i); }); return prices.map(function(price, i) { const start = i ? prices[i - 1] + 1 : 0, block = headers.slice(start, price + 1).map(rmgNorm_), find = function(names) { const found = names.map(function(n) { return block.indexOf(n); }).find(function(x) { return x >= 0; }); return found === undefined ? -1 : start + found; }; return { start:start, price:price, title:find(['title','товар','наименование']), model:find(['model','модель']), memory:find(['memorysize','memory size','память']), ram:find(['ramsize','ram size','ram','озу']), color:find(['color','цвет']), sim:find(['simconfig','sim config','sim','сим конфигурация']), country:find(['country','страна']) }; }); }
function rmgLayout_(layouts, p) { return layouts.length > 1 && p.category === 'телефоны' && !/^iphone\b/i.test(p.name) ? layouts.length - 1 : 0; }
function rmgRow_(layout, p) { const row = Array(layout.price - layout.start + 1).fill(''), info = rmgInfo_(p.name), put = function(col, value) { if (col >= layout.start && col <= layout.price) row[col - layout.start] = value; }; put(layout.title, p.name); put(layout.model, info.model || p.name); put(layout.memory, info.memory); put(layout.ram, info.ram); put(layout.color, info.color); put(layout.sim, info.sim); put(layout.country, p.country); put(layout.price, p.price); return row; }
function rmgEscape_(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function rmgNorm_(value) { return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim(); }
function rmgSummary_(r) { return 'Каталог получен: ' + r.rows + ' позиций. Записано в листы: ' + r.written + '. Цены записаны без наценки: правило пока не задано. Следующая проверка — через 15 минут.'; }
