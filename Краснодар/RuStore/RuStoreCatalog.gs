/**
 * Краснодар / ru:Store.  The Telegram account is deliberately outside this
 * project. It sends a normalized snapshot to an HTTPS endpoint; this script
 * fetches that snapshot and rebuilds the client catalogue every 15 minutes.
 */
const RUS = {
  sheets: ['телефоны', 'аксессуары', 'макбуки', 'аймаки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон'],
  everyMinutes: 15,
  project: 'ru:Store | Краснонедар',
  endpoint: 'https://api.pricemasterapp.ru/krasnodar/snapshot',
  snapshotSecret: 'e02840249d79ec99f0317780d4b76b3ca0a91a6f2d08df376ce221566bb606a8',
  props: { connected: 'RUS_CONNECTED', last: 'RUS_LAST', status: 'RUS_STATUS' }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог ru:Store')
    .addItem('Настроить источник', 'showRuStoreCatalogSidebar')
    .addSeparator().addItem('Пересобрать каталог сейчас', 'runRuStoreCatalogNow').addToUi();
}
function showRuStoreCatalogSidebar() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('RuStoreCatalogSidebar').setTitle('Каталог ru:Store').setWidth(380));
}
function getRuStoreCatalogSetup() {
  const p = PropertiesService.getScriptProperties();
  return { connected: Boolean(p.getProperty(RUS.props.connected)), lastSync: p.getProperty(RUS.props.last) || '', status: p.getProperty(RUS.props.status) || 'Готово к запуску' };
}
function saveRuStoreCatalogSetup() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty(RUS.props.connected, 'true');
  rusEnsureTrigger_();
  const result = syncRuStoreCatalog_();
  return Object.assign(getRuStoreCatalogSetup(), { message: rusSummary_(result) });
}
function runRuStoreCatalogNow() { rusEnsureTrigger_(); return Object.assign(getRuStoreCatalogSetup(), { message: rusSummary_(syncRuStoreCatalog_()) }); }
function syncRuStoreCatalog() { return syncRuStoreCatalog_(); }
function rusEnsureTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'syncRuStoreCatalog') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncRuStoreCatalog').timeBased().everyMinutes(RUS.everyMinutes).create();
}
function syncRuStoreCatalog_() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { rows: 0, written: 0, skipped: [] };
  try {
    const snapshot = rusFetchSnapshot_(), rows = snapshot.rows, activeCategories = snapshot.categories, book = SpreadsheetApp.getActiveSpreadsheet(), bySheet = {};
    rows.forEach(function(row) { (bySheet[row.category] = bySheet[row.category] || []).push(row); });
    let written = 0, skipped = [];
    RUS.sheets.forEach(function(name) {
      const products = bySheet[name] || [], sheet = book.getSheetByName(name);
      // A category seen in the current source is rebuilt even when all its
      // products have an empty or questioned price: those products must be
      // absent now, and may reappear after the supplier edits the post.
      if (!activeCategories[name]) { skipped.push(name); return; }
      // Customer templates may omit a standard tab. This must not prevent the
      // remaining existing tabs from being rebuilt.
      if (!sheet) { skipped.push(name); return; }
      written += rusWriteSheet_(sheet, products);
    });
    const p = PropertiesService.getScriptProperties(); p.setProperty(RUS.props.last, String(Date.now())); p.setProperty(RUS.props.status, 'Обновлено: ' + written + ' позиций.');
    return { rows: rows.length, written: written, skipped: skipped };
  } finally { lock.releaseLock(); }
}
/** Endpoint contract: {posts:[{id:"123", text:"...", updatedAt:"ISO"}]}. */
function rusFetchSnapshot_() {
  const response = UrlFetchApp.fetch(RUS.endpoint, { headers: { 'X-PriceFlow-Secret': RUS.snapshotSecret }, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error('Сервис снимков вернул HTTP ' + response.getResponseCode());
  const payload = JSON.parse(response.getContentText());
  if (!payload || !Array.isArray(payload.posts)) throw new Error('Сервис вернул неверный формат снимка: ожидается posts[].');
  const report = [], rows = [], categories = {};
  payload.posts.forEach(function(post) { const parsed = rusParsePost_(post.text, String(post.id || '')); parsed.rows.forEach(function(row) { rows.push(row); }); parsed.categories.forEach(function(category) { categories[category] = true; }); parsed.skipped.forEach(function(item) { report.push('post ' + post.id + ': ' + item); }); });
  PropertiesService.getScriptProperties().setProperty('RUS_LAST_REPORT', JSON.stringify({ at: new Date().toISOString(), posts: payload.posts.length, rows: rows.length, categories: Object.keys(categories), skipped: report.slice(0, 200) }));
  return { rows: rows, categories: categories };
}
function rusWriteSheet_(sheet, products) {
  rusEnsureCountryColumns_(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], layouts = rusLayouts_(headers);
  if (!layouts.length) throw new Error('На листе «' + sheet.getName() + '» не найдена колонка Price/Цена.');
  const buckets = layouts.map(function() { return []; });
  products.forEach(function(p) { buckets[rusLayoutFor_(layouts, p)].push(p); });
  let written = 0;
  layouts.forEach(function(layout, index) {
    const data = buckets[index].sort(rusSort_).map(function(p) { return rusTargetRow_(layout, p); });
    const height = Math.max(sheet.getLastRow() - 1, data.length, 1), width = layout.price - layout.start + 1;
    if (sheet.getMaxRows() < data.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), data.length + 1 - sheet.getMaxRows());
    const target = sheet.getRange(2, layout.start + 1, height, width); target.clearDataValidations(); target.clearContent();
    if (data.length) { sheet.getRange(2, layout.start + 1, data.length, width).setValues(data); sheet.getRange(2, layout.price + 1, data.length, 1).setNumberFormat('0'); written += data.length; }
  });
  return written;
}
function rusEnsureCountryColumns_(sheet) {
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], prices = [];
  headers.forEach(function(v, i) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(v || '').trim())) prices.push(i); });
  for (let i = prices.length - 1; i >= 0; i--) { const price = prices[i], start = i ? prices[i - 1] + 1 : 0, hasCountry = headers.slice(start, price + 1).some(function(h) { return /^(country|страна)$/i.test(String(h).trim()); }); if (!hasCountry) { sheet.insertColumnBefore(price + 1); sheet.getRange(1, price + 1).setValue('Country'); } }
}
function rusLayouts_(headers) {
  const prices = []; headers.forEach(function(v, i) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(v || '').trim())) prices.push(i); });
  return prices.map(function(price, i) { const start = i ? prices[i - 1] + 1 : 0, block = headers.slice(start, price + 1).map(rusNorm_), col = function(names) { const hit = names.map(function(n) { return block.indexOf(n); }).find(function(x) { return x >= 0; }); return hit === undefined ? -1 : start + hit; }; return { start: start, price: price, title: col(['title','товар','наименование']), model: col(['model','модель']), memory: col(['memorysize','memory size','память']), ram: col(['ramsize','ram size','ram','озу']), color: col(['color','цвет']), sim: col(['simconfig','sim config','sim','сим конфигурация']), country: col(['country','страна']) }; });
}
function rusLayoutFor_(layouts, product) { return layouts.length === 1 ? 0 : product.category === 'телефоны' && /^iphone\b/i.test(product.name) ? 0 : layouts.length - 1; }
function rusTargetRow_(layout, product) {
  const row = Array(layout.price - layout.start + 1).fill(''), phone = rusPhone_(rusDisplay_(product)), put = function(col, value) { if (col >= layout.start && col <= layout.price) row[col - layout.start] = value; };
  put(layout.title, rusDisplay_(product)); put(layout.model, phone.model || product.name); put(layout.memory, phone.memory); put(layout.ram, phone.ram); put(layout.color, phone.color); put(layout.sim, phone.sim); put(layout.country, phone.country); put(layout.price, product.price); return row;
}
function rusParsePost_(text, postId) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(function(x) { return x.trim(); }).filter(Boolean), rows = [], skipped = [], categories = {}; let context = '';
  const seen = function(value) { const category = rusCategory_(value); if (category !== 'прочее') categories[category] = true; };
  lines.forEach(function(raw) {
    // Supplier headings use category emoji. Remove those markers but keep
    // regional-indicator country flags intact at the beginning of product rows.
    const line = raw.replace(/^(?:[•·▪◦📱🎧🎮💼💻🔘🏠🕹️📸🔌🔥⚠️🔈⌚🤖👱🏽‍♀️\uFE0F]+\s*)+/u, '').trim();
    if (!line || /^(цена за объ[её]м|\d+\s*шт\s*[—-]\s*основная|указано по обычной цене|уточняйте|цены могут|конфигурац|если в прайсе|нашли дешевле)/i.test(line)) return;
    // Объёмные строки «1 шт / 3+ / 5+» относятся к другому клиентскому
    // формату и для Краснодара не являются товарной позицией.
    if (/^\d+\s*шт\s+/i.test(line)) { skipped.push('неподдерживаемая объёмная цена: ' + line); return; }
    const parsed = rusInlineLine_(line, context, postId);
    if (parsed === 'skip') { seen(rusExpand_(context, line.replace(/\s*[—–-].*$/, ''))); return; }
    if (parsed) {
      const parsedRows = Array.isArray(parsed) ? parsed : [parsed];
      parsedRows.forEach(function(row) { rows.push(row); seen(row.name); });
      // Keep the section heading as context. Using the preceding product here
      // caused its country and memory to be appended to the next product.
      return;
    }
    if (rusLooksLikeProduct_(line)) { context = rusExpand_(context, line); seen(context); } else if (/^(iphone|ipad|macbook|airpods|(?:apple\s+)?watch|samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo|dyson|ps\d|playstation|xbox)/i.test(line)) { context = line.replace(/[.·]{3,}/g, '').trim(); seen(context); }
  });
  return { rows: rows.filter(function(r) { return r.category !== 'прочее'; }), categories: Object.keys(categories), skipped: skipped };
}
function rusInlineLine_(line, context, postId) {
  // A supplier article may follow the price (for example "66 990 MHFD4").
  // It is not part of the product name or price; a trailing question mark
  // still means that the whole line must be omitted.
  const match = /^(.*?)\s*[—–-]\s*([\d\s]+)(?:\s*₽|\s*р\.?|\s*rub)?(?:\s+[A-Za-zА-Яа-яЁё0-9]+)?\s*(\?)?\s*$/iu.exec(line);
  if (!match) return null;
  // A question mark means the supplier has not confirmed this price yet.
  // It is deliberately omitted now; a later edited message will be parsed anew.
  if (match[3]) return 'skip';
  const price = Number(match[2].replace(/\s/g, '')); if (!price) return 'skip';
  return rusRowsForCountries_(rusExpand_(context, match[1]), price, postId);
}
function rusRow_(name, price, post, uncertain) { const clean = String(name).replace(/^[\[\]()\s]+/, '').replace(/\s+/g, ' ').trim(); return { name: clean, price: Number(price), uncertain: Boolean(uncertain), category: rusCategory_(clean), post: post }; }
function rusRowsForCountries_(name, price, postId) {
  const flags = Array.from(new Set(String(name).match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []));
  if (!flags.length) return rusRow_(name, price, postId, false);
  const base = String(name).replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim();
  return flags.map(function(flag) { return rusRow_(base + ' ' + flag, price, postId, false); });
}
function rusExpand_(context, item) {
  const value = String(item).trim(), ctx = String(context || '').replace(/[.·•]{3,}/g, '').trim(), flags = /^((?:[\u{1F1E6}-\u{1F1FF}]{2})+)\s*/u.exec(value);
  const core = (flags ? value.slice(flags[0].length) : value).replace(/^(?:[•·▪◦📱🎧🎮💼💻🔘🏠🕹️📸🔌🔥⚠️🔈⌚🤖👱🏽‍♀️\uFE0F]+\s*)+/u, '').trim(), suffix = flags ? ' ' + flags[1] : '';
  if (!ctx) return core + suffix;
  if (/^iphone\s+\d+(?:e)?(?:\s+(?:pro max|pro|plus|air|mini))?$/i.test(ctx) && /^\d/.test(core)) return 'iPhone ' + core + suffix;
  if (/^iphone\s+air$/i.test(ctx) && !/^iphone\b/i.test(core)) return 'iPhone ' + core + suffix;
  // Supplier uses bare headings "MacBook" and "Watch". Keep that family
  // on each row so the product reaches the correct sheet.
  if (/^macbook\b/i.test(ctx) && !/^macbook\b/i.test(core)) return 'MacBook ' + core + suffix;
  if (/^(?:apple\s+)?watch\b/i.test(ctx) && !/^(?:apple\s+)?watch\b/i.test(core)) return 'Apple Watch ' + core + suffix;
  if (/^airpods\b/i.test(ctx) && !/^airpods\b/i.test(core)) return 'AirPods ' + core + suffix;
  // Android supplier posts may contain a brand-only heading followed by
  // abbreviated model lines (for example "Xiaomi" then "14 12/256 …").
  // Keep that brand on the row so it reaches the Android phone block.
  if (/^(?:samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo)$/i.test(ctx) && !/^(?:samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo)\b/i.test(core) && /\d/.test(core)) return ctx + ' ' + core + suffix;
  if (/^(?:iphone|ipad)\b/i.test(ctx) && !/^(?:iphone|ipad)\b/i.test(core) && /^\d/.test(core)) return ctx.split(/\s+/)[0] + ' ' + core + suffix;
  return core + suffix;
}
function rusLooksLikeProduct_(line) { return /\d/.test(line) && !/^(?:\d+\s*шт|\d+\+|\d{1,2}:\d{2})/i.test(line); }
function rusCategory_(value) { const v = rusNorm_(value); if (/airpods|galaxy\s*buds|\bbuds\b|наушник|headphones?/.test(v)) return 'наушники'; if (/apple\s*watch|galaxy\s*(watch|fit|ring)|\bwatch\b/.test(v)) return 'часы'; if (/ipad|galaxy\s*tab|\btablet\b/.test(v)) return 'айпады'; if (/macbook/.test(v)) return 'макбуки'; if (/\bimac\b/.test(v)) return 'аймаки'; if (/dyson/.test(v)) return 'дайсон'; if (/playstation|\bps[345]\b|xbox/.test(v)) return /gamepad|controller|геймпад|док|подставк|дисковод/.test(v) ? 'аксессуары' : 'пс'; if (/чехол|стекло|кабель|заряд|адаптер|держател|ремеш|powerbank|пауэрбанк/.test(v)) return 'аксессуары'; if (/iphone|samsung|galaxy|pixel|xiaomi|redmi|honor|huawei|oneplus|realme|oppo|vivo/.test(v)) return 'телефоны'; return 'прочее'; }
const RUS_COUNTRIES = {AE:'ОАЭ',AR:'Аргентина',AT:'Австрия',AU:'Австралия',AZ:'Азербайджан',BE:'Бельгия',BH:'Бахрейн',BR:'Бразилия',BY:'Беларусь',CA:'Канада',CH:'Швейцария',CL:'Чили',CN:'Китай',CO:'Колумбия',CZ:'Чехия',DE:'Германия',DK:'Дания',EE:'Эстония',EG:'Египет',ES:'Испания',EU:'Европа',FI:'Финляндия',FR:'Франция',GB:'Великобритания',GE:'Грузия',GR:'Греция',HK:'Гонконг',HU:'Венгрия',ID:'Индонезия',IE:'Ирландия',IL:'Израиль',IN:'Индия',IS:'Исландия',IT:'Италия',JP:'Япония',KR:'Южная Корея',KW:'Кувейт',KZ:'Казахстан',LT:'Литва',LU:'Люксембург',LV:'Латвия',MA:'Марокко',MX:'Мексика',MY:'Малайзия',NL:'Нидерланды',NO:'Норвегия',NZ:'Новая Зеландия',OM:'Оман',PH:'Филиппины',PL:'Польша',PT:'Португалия',QA:'Катар',RO:'Румыния',RS:'Сербия',RU:'Россия',SA:'Саудовская Аравия',SE:'Швеция',SG:'Сингапур',TH:'Таиланд',TR:'Турция',TW:'Тайвань',UA:'Украина',US:'США',VN:'Вьетнам',ZA:'ЮАР'};
function rusFlagCode_(flag) { const chars = Array.from(String(flag || '')); return chars.length === 2 ? chars.map(function(c) { return String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65); }).join('') : ''; }
function rusCountry_(value) { const flag = (String(value || '').match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || [])[0]; if (!flag) return ''; const code = rusFlagCode_(flag); return (RUS_COUNTRIES[code] || code || 'Неизвестная страна') + ' ' + flag; }
function rusPhone_(text) { const value = String(text), specs = /(\d{1,2})\s*\/\s*(\d{1,4})(?:\s*(гб|gb|тб|tb))?/i.exec(value), memory = specs ? null : /\b(\d{1,4})\s*(гб|gb|тб|tb)\b/i.exec(value), bareMemory = specs || memory ? null : /\b(64|128|256|512|1024|2048)\b/.exec(value), unit = function(n,u) { return n + ' ' + String(u || 'GB').toUpperCase().replace('GB','ГБ').replace('TB','ТБ'); }, model = /\b(iPhone\s+(?:\d+(?:e)?(?:\s+(?:Pro Max|Pro|Plus|Air|mini))?|Air)|iPad\s+[^\d]*\d+|MacBook\s+(?:(?:Air|Pro|Neo)\s+)?\d+|Apple Watch\s+(?:(?:SE\d*|S\d+|Ultra\s+\d+)\s+)?\d+mm|Galaxy\s+[A-Z]\d+|Pixel\s+\d+(?:\s+Pro)?)/i.exec(value); return { model: model ? model[1].replace(/\s+/g,' ') : '', memory: specs ? unit(specs[2],specs[3]) : memory ? unit(memory[1],memory[2]) : bareMemory ? unit(bareMemory[1],'GB') : '', ram: specs ? unit(specs[1],'GB') : '', sim: /(?:1\s*)?sim\s*\+\s*e\s*-?sim/i.test(value) ? 'SIM + eSIM' : /e\s*-?sim/i.test(value) ? 'eSIM' : '', country: rusCountry_(value), color: rusColor_(value) }; }
function rusColor_(value) { const v = rusNorm_(value); const pairs = [['volcanic red','вулканический красный'],['rose gold','розовое золото'],['space gray','серый космос'],['natural','натуральный'],['desert','пустынный'],['ultramarine','ультрамарин'],['teal','бирюзовый'],['midnight','полуночный'],['starlight','сияющая звезда'],['lavender','лавандовый'],['camouflage','камуфляж'],['charcoal','угольный'],['citrus','цитрусовый'],['blush','румяный'],['indigo','индиго'],['orange','оранжевый'],['purple','фиолетовый'],['violet','фиолетовый'],['black','черный'],['white','белый'],['blue','синий'],['pink','розовый'],['green','зеленый'],['silver','серебристый'],['yellow','желтый'],['gold','золотой'],['sage','шалфейный'],['pearl','жемчужный'],['red','красный'],['gray','серый'],['серый','серый'],['черный','черный'],['белый','белый'],['синий','синий'],['розовый','розовый']]; const hit = pairs.find(function(p) { return new RegExp('\\b' + p[0] + '\\b','i').test(v); }); return hit ? rusAvitoColor_(v, hit[1]) : ''; }
function rusAvitoColor_(source, detected) { const v = rusNorm_(source); if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b))/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой'; const pairs = [['вулканический красный','красный'],['розовое золото','розовый'],['серый космос','серый'],['натуральный','серый'],['пустынный','золотистый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['полуночный','черный'],['сияющая звезда','белый'],['лавандовый','фиолетовый'],['камуфляж','зеленый'],['угольный','черный'],['цитрусовый','желтый'],['румяный','розовый'],['индиго','синий'],['золотой','золотистый'],['шалфейный','зеленый'],['жемчужный','белый']], hit = pairs.find(function(pair) { return rusNorm_(detected) === pair[0]; }); return hit ? hit[1] : rusNorm_(detected); }
function rusDisplay_(p) { return p.name; }
function rusSort_(a,b) { return String(a.name).localeCompare(String(b.name), 'ru', { numeric: true, sensitivity: 'base' }) || a.price - b.price; }
function rusNorm_(value) { return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').trim(); }
function rusSummary_(r) { return 'Каталог получен: ' + r.rows + ' позиций. Записано: ' + r.written + '. Цены переданы без наценки. Следующая проверка — через 15 минут.'; }
