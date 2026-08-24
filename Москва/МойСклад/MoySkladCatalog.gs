/**
 * МойСклад → каталог. Отдельный Apps Script-проект.
 * Источник истины — ассортимент МоегоСклада; значения под шапками стандартных
 * листов пересобираются без сопоставления со старыми строками.
 */
const MSC = {
  api: 'https://api.moysklad.ru/api/remap/1.2', pageSize: 1000, everyMinutes: 15,
  sheets: ['телефоны', 'макбуки', 'айпады', 'часы', 'наушники', 'пс', 'дайсон', 'аймаки'],
  props: { project: 'MSC_PROJECT', token: 'MSC_TOKEN', last: 'MSC_LAST', status: 'MSC_STATUS' }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог из МоегоСклада')
    .addItem('Подключить МойСклад', 'showMoySkladCatalogSidebar')
    .addSeparator().addItem('Пересобрать каталог сейчас', 'runMoySkladCatalogNow').addToUi();
}
function showMoySkladCatalogSidebar() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('MoySkladCatalogSidebar').setTitle('Каталог из МоегоСклада').setWidth(360));
}
function getMoySkladCatalogSetup() {
  const p = PropertiesService.getScriptProperties();
  return { project: p.getProperty(MSC.props.project) || '', connected: Boolean(p.getProperty(MSC.props.token)), lastSync: p.getProperty(MSC.props.last) || '', status: p.getProperty(MSC.props.status) || 'Не подключено' };
}
function saveMoySkladCatalogSetup(form) {
  const project = String(form && form.project || '').trim(), token = String(form && form.token || '').trim();
  if (!/^.{2,}\s*\|\s*.{2,}$/.test(project)) throw new Error('Укажите магазин в формате «Магазин | Город».');
  if (!/^[a-z0-9]{32,}$/i.test(token)) throw new Error('Введите API-токен МоегоСклада.');
  mscApi_(token, '/entity/assortment?limit=1&offset=0'); // validates access before saving
  const p = PropertiesService.getScriptProperties();
  p.setProperty(MSC.props.project, project); p.setProperty(MSC.props.token, token);
  mscEnsureTrigger_(); const result = syncMoySkladCatalog_();
  return Object.assign(getMoySkladCatalogSetup(), { message: mscSummary_(result) });
}
function runMoySkladCatalogNow() { mscEnsureTrigger_(); const result = syncMoySkladCatalog_(); return Object.assign(getMoySkladCatalogSetup(), { message: mscSummary_(result) }); }
function syncMoySkladCatalog() {
  // A copied trigger must not fail every 15 minutes before the new owner has
  // connected their account.
  if (!PropertiesService.getScriptProperties().getProperty(MSC.props.token)) return { rows: 0, written: 0, skippedSheets: MSC.sheets };
  return syncMoySkladCatalog_();
}
function mscEnsureTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'syncMoySkladCatalog') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncMoySkladCatalog').timeBased().everyMinutes(MSC.everyMinutes).create();
}

function syncMoySkladCatalog_() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { rows: 0, written: 0, skippedSheets: [] };
  try {
    const p = PropertiesService.getScriptProperties(), token = p.getProperty(MSC.props.token);
    if (!token) throw new Error('Сначала подключите МойСклад.');
    const items = mscPaged_(token, '/entity/assortment'), parsed = items.map(mscItem_), rows = parsed.filter(Boolean), book = SpreadsheetApp.getActiveSpreadsheet(), grouped = {};
    rows.forEach(function(row) { (grouped[row.category] = grouped[row.category] || []).push(row); });
    let written = 0; const skippedSheets = [];
    MSC.sheets.forEach(function(name) {
      const products = grouped[name] || [], sheet = book.getSheetByName(name);
      if (!products.length) { skippedSheets.push(name); return; }
      if (!sheet) throw new Error('Нет листа «' + name + '» в стандартной таблице.');
      written += mscWrite_(sheet, products);
    });
    p.setProperty(MSC.props.last, String(Date.now())); p.setProperty(MSC.props.status, 'Каталог обновлён: ' + written + ' позиций.');
    return { rows: rows.length, written: written, skippedSheets: skippedSheets, skipped: items.length - rows.length };
  } finally { lock.releaseLock(); }
}

function mscPaged_(token, path) {
  let offset = 0, all = [];
  while (true) {
    const rows = mscApi_(token, path + (path.indexOf('?') >= 0 ? '&' : '?') + 'limit=' + MSC.pageSize + '&offset=' + offset).rows || [];
    all = all.concat(rows); if (rows.length < MSC.pageSize) return all; offset += rows.length;
  }
}
function mscApi_(token, path) {
  const response = UrlFetchApp.fetch(MSC.api + path, { method: 'get', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json;charset=utf-8' }, muteHttpExceptions: true });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('МойСклад API ' + response.getResponseCode() + '. Проверьте API-токен и права на товары.');
  return JSON.parse(response.getContentText());
}
function mscItem_(item) {
  if (!item || !item.name || item.archived) return null;
  const name = String(item.name).trim(), parent = item.product && item.product.name || '', details = mscCharacteristicsText_(item), full = mscJoinParts_([parent, name, details]);
  const price = mscPrice_(item.salePrices || []), category = mscCategory_((item.productFolder && item.productFolder.name || '') + ' ' + full);
  // Placeholders and service rows with a symbolic price must not enter a
  // phone catalogue as a supposedly current device.
  if (MSC.sheets.indexOf(category) < 0 || !mscPlausiblePrice_(category, price)) return null;
  return { category: category, name: full, price: price, article: item.article || item.code || '', variant: parent && parent !== name ? name : '' };
}
function mscJoinParts_(parts) {
  const seen = {}, out = [];
  parts.forEach(function(part) { const value = mscCleanName_(part), key = mscNorm_(value); if (value && !seen[key]) { seen[key] = true; out.push(value); } });
  return out.join(' ');
}
// Решётка в начале — служебная пометка в номенклатуре, а не часть названия
// товара; в каталог её не выводим.
function mscCleanName_(value) { return String(value || '').replace(/^\s*#+\s*/, '').trim(); }
function mscCharacteristicsText_(item) {
  const values = [];
  (item.characteristics || []).forEach(function(characteristic) {
    const value = characteristic && characteristic.value;
    if (value !== undefined && value !== null && String(value).trim()) values.push(String(value).trim());
  });
  // Some МоегоСклада accounts store variant fields as custom attributes.
  (item.attributes || []).forEach(function(attribute) {
    let value = attribute && attribute.value;
    if (value && typeof value === 'object') value = value.name || value.value || '';
    if (value !== undefined && value !== null && String(value).trim()) values.push(String(value).trim());
  });
  return mscJoinParts_(values);
}
function mscPrice_(prices) { const value = prices && prices.length ? Number(prices[0].value || 0) : 0; return value ? value / 100 : ''; }
function mscPlausiblePrice_(category, price) { return Number(price) >= (category === 'телефоны' ? 1000 : 1); }
function mscIsAccessory_(value) { return /чехол|кейс|бампер|накладк|футляр|case\b|cover\b|стекло|пленк|глазур|кабель|cable|зарядн|charger|сзу|блок\s*питан|адаптер|держател|ремеш|клавиатур|мышь|защитн|access\b|type\s*-?\s*c|magsafe|пауэрбанк|power\s*bank|переходник|хаб\b|док-станц|dock|контроллер|геймпад|джойстик|руль|игровой\s+аксессуар/.test(mscNorm_(value)); }
function mscHasMemory_(value) { return /(?:\d{1,2}\s*\/\s*)?\d{2,4}\s*(?:гб|gb|тб|tb)\b/i.test(String(value || '')); }
function mscCategory_(value) {
  const v = mscNorm_(value);
  // Проверяем аксессуар раньше названия совместимого устройства: «чехол для
  // AirPods» — не наушники.
  if (mscIsAccessory_(v)) return 'прочее';
  if (/airpods|earpods|galaxy\s+(?:buds|ring)\b|наушник|headphone|гарнитур|колонк/.test(v)) return 'наушники';
  if (/\bwatch\b|часы/.test(v)) return 'часы';
  // В прайсе Samsung позиции без объёма памяти — это носимые устройства, а
  // не телефоны; Watch уже направлен выше, остальные идут в «наушники».
  if (/\b(?:galaxy|samsung)\b/.test(v) && !mscHasMemory_(v)) return 'наушники';
  if (/iphone|galaxy|pixel|xiaomi|samsung|honor|huawei|oneplus|realme/.test(v)) return 'телефоны';
  if (/macbook/.test(v)) return 'макбуки'; if (/ipad/.test(v)) return 'айпады';
  if (/playstation|\bps[345]\b|xbox/.test(v)) return 'пс'; if (/dyson/.test(v)) return 'дайсон'; if (/imac/.test(v)) return 'аймаки'; return 'прочее';
}
function mscNorm_(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }

function mscWrite_(sheet, products) {
  mscRemoveCountryColumns_(sheet);
  const columns = sheet.getLastColumn(), oldRows = Math.max(sheet.getLastRow(), 1), headers = sheet.getRange(1, 1, 1, columns).getValues()[0], layouts = mscLayouts_(headers);
  if (!layouts.length) throw new Error('На листе «' + sheet.getName() + '» не найдена колонка Price/Цена.');
  const buckets = layouts.map(function() { return []; }); products.forEach(function(product) { buckets[mscLayout_(layouts, product)].push(product); });
  buckets.forEach(function(bucket) { bucket.sort(mscProductSort_); });
  let written = 0;
  layouts.forEach(function(layout, index) {
    const data = buckets[index].map(function(product) { return mscRow_(layout, product); });
    if (sheet.getMaxRows() < data.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), data.length + 1 - sheet.getMaxRows());
    const height = Math.max(oldRows - 1, data.length, 1), width = layout.price - layout.start + 1;
    const target = sheet.getRange(2, layout.start + 1, height, width);
    // The source catalogue decides which values are legitimate: previous
    // dropdown validations must not reject a new model, country or memory.
    target.clearDataValidations();
    target.clearContent();
    if (data.length) { sheet.getRange(2, layout.start + 1, data.length, width).setValues(data); sheet.getRange(2, layout.price + 1, data.length, 1).setNumberFormat('0'); written += data.length; }
  });
  return written;
}
function mscRemoveCountryColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let column = headers.length - 1; column >= 0; column--) {
    if (/^(country|страна)$/i.test(String(headers[column] || '').trim())) sheet.deleteColumn(column + 1);
  }
}
function mscLayouts_(headers) {
  const prices = []; headers.forEach(function(h, i) { if (/^(price|цена|цена продажи|актуальная цена)$/i.test(String(h || '').trim())) prices.push(i); });
  return prices.map(function(price, index) {
    const start = index ? prices[index - 1] + 1 : 0, block = headers.slice(start, price + 1).map(mscNorm_), find = function(names) { const hit = names.map(function(n) { return block.indexOf(n); }).find(function(i) { return i >= 0; }); return hit === undefined ? -1 : start + hit; };
    return { start: start, price: price, title: find(['title','товар','наименование']), model: find(['model','модель']), memory: find(['memorysize','memory size','память']), ram: find(['ramsize','ram size','ram','озу']), color: find(['color','цвет']), sim: find(['simconfig','sim config','sim','сим конфигурация']) };
  });
}
function mscLayout_(layouts, product) {
  // The left block is always Apple iPhone. Do not make the destination depend
  // on whether a particular generation has a number in its name: "iPhone Air"
  // and decorated variation names must never move to the Android block.
  // A mention of iPhone in an accessory description is not enough: the
  // product itself must start with a recognisable iPhone model.
  const isIphone = mscIsIphoneHandset_(product.name);
  return layouts.length > 1 && product.category === 'телефоны' && !isIphone ? layouts.length - 1 : 0;
}
function mscIsIphoneHandset_(value) {
  const title = String(value || '').trim();
  // В МоемСкладе состояние нередко добавляется перед моделью: «(Active)
  // iPhone 17». Это всё равно телефон Apple, не аксессуар.
  return !mscIsAccessory_(title) && /^(?:(?:\([^)]*\)|asis|новый|новое|б\/у)\s+)*iphone\s+(?:air\b|\d{1,2}e?(?:\s+(?:mini|plus|air|pro(?:\s+max)?))?\b)/i.test(title);
}
function mscRow_(layout, product) {
  const row = Array(layout.price - layout.start + 1).fill(''), info = mscPhone_(product.name), at = function(column, value) { if (column >= layout.start && column <= layout.price) row[column - layout.start] = value; };
  // An accessory title may mention the compatible iPhone model. Keep its full
  // title visible instead of turning "Чехол для iPhone 17" into "iPhone 17".
  const shortIphoneMention = /^iphone\s/i.test(String(info.model || '')) && !mscIsIphoneHandset_(product.name);
  if (layout.title >= 0) at(layout.title, product.name); if (layout.model >= 0) at(layout.model, shortIphoneMention ? product.name : mscDisplayModel_(product.name, info.model)); if (layout.memory >= 0) at(layout.memory, info.memory); if (layout.ram >= 0) at(layout.ram, info.ram); if (layout.color >= 0) at(layout.color, info.color); if (layout.sim >= 0) at(layout.sim, info.sim); at(layout.price, product.price); return row;
}
function mscDisplayModel_(name, parsedModel) {
  const prefix = /^\s*(\([^)]*\))\s*/.exec(String(name || ''));
  return prefix && parsedModel ? prefix[1] + ' ' + parsedModel : (parsedModel || name);
}
function mscPhone_(value) {
  const text = String(value || ''), model = /(iphone\s+(?:air|\d+(?:e|\s+(?:air|pro\s*max|pro|plus|mini))?)|galaxy\s+(?:s|a|z|m)\d+(?:\+|\s+(?:ultra|fe|plus))?|pixel\s+\d+(?:[a-z])?(?:\s+(?:pro|xl))?|honor\s+[\w-]+)/i.exec(text), specs = /(\d{1,2})\s*\/\s*(\d{2,4})\s*(гб|gb|тб|tb)/i.exec(text), memory = specs ? null : /(?:^|[\s(,])(\d{1,4})\s?(гб|gb|тб|tb)(?=\s|$|[,;)])/i.exec(text), sim = /sim\s*\+\s*e\s*-?sim/i.test(text) ? 'SIM + eSIM' : /e\s*-?sim/i.test(text) ? 'eSIM' : /\bsim\b/i.test(text) ? 'SIM' : '';
  const unit = function(amount, suffix) { return amount + ' ' + suffix.toUpperCase().replace('GB','ГБ').replace('TB','ТБ'); };
  return { model: model && model[1] || '', memory: specs ? unit(specs[2], specs[3]) : memory ? unit(memory[1], memory[2]) : '', ram: specs ? unit(specs[1], 'GB') : '', color: mscColor_(text), sim: sim, country: mscCountry_(text) };
}
function mscCountry_(value) {
  const text = String(value || ''), flag = /(🇺🇸|🇯🇵|🇭🇰|🇰🇷|🇮🇳|🇨🇦|🇸🇬|🇦🇪|🇷🇺|🇨🇳)/u.exec(text), names = {'🇺🇸':'США','🇯🇵':'Япония','🇭🇰':'Гонконг','🇰🇷':'Корея','🇮🇳':'Индия','🇨🇦':'Канада','🇸🇬':'Сингапур','🇦🇪':'ОАЭ','🇷🇺':'Россия','🇨🇳':'Китай'};
  if (flag) return names[flag[1]] + ' ' + flag[1];
  const v = mscNorm_(text), countries = [['япония','Япония'],['japan','Япония'],['сша','США'],['usa','США'],['united states','США'],['гонконг','Гонконг'],['hong kong','Гонконг'],['корея','Корея'],['korea','Корея'],['индия','Индия'],['india','Индия'],['канада','Канада'],['canada','Канада'],['сингапур','Сингапур'],['singapore','Сингапур'],['оаэ','ОАЭ'],['uae','ОАЭ'],['китай','Китай'],['china','Китай'],['россия','Россия'],['russia','Россия']];
  const hit = countries.find(function(pair) { return v.indexOf(pair[0]) >= 0; }); return hit ? hit[1] : '';
}
// Цвет может быть в названии товара, варианте или характеристике МоегоСклада.
// Нормализация делает поиск устойчивым к «ё», дефисам, скобкам и порядку слов.
function mscColorKey_(value) { return mscNorm_(value).replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim(); }
function mscColor_(value) {
  const v = mscColorKey_(value);
  const pairs = [
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
  const hit = pairs.find(function(pair) { return padded.indexOf(' ' + pair[0] + ' ') >= 0; });
  return hit ? mscAvitoColor_(v, hit[1]) : '';
}
// Значения Color сверяются с эталонной автозагрузкой Avito. Фирменное имя
// сохраняется в названии товара, а в отдельную колонку попадает только цвет
// из списка Avito; для синего учитывается конкретная модель.
function mscAvitoColor_(source, detected) {
  const v = mscColorKey_(source);
  if (/iphone\s+(?:14(?:\s+plus)?|15(?!\s+pro\b)(?:\s+plus)?|16(?!\s+pro\b)(?:\s+plus)?|air|17(?!\s+pro\b))/i.test(v) && /\b(?:blue|ultramarine|teal|sky blue|bay)\b/i.test(v)) return 'голубой';
  const pairs = [['натуральный','серый'],['серый космос','серый'],['графитовый','черный'],['угольный','черный'],['обсидиан','черный'],['титан','серый'],['пустынный','золотистый'],['кремовый','бежевый'],['ореховый','бежевый'],['фарфоровый','белый'],['сияющая звезда','белый'],['темно фиолетовый','фиолетовый'],['лавандовый','фиолетовый'],['ультрамарин','голубой'],['бирюзовый','голубой'],['индиго','синий'],['полночный','черный'],['темно зеленый','зеленый'],['зимний зеленый','зеленый'],['шалфейный','зеленый'],['мятный','зеленый'],['алоэ','зеленый'],['розовое золото','розовый'],['коралловый','розовый'],['пионовый','розовый'],['лимонный','желтый']];
  const hit = pairs.find(function(pair) { return mscColorKey_(detected) === pair[0]; });
  return hit ? hit[1] : mscColorKey_(detected);
}
function mscProductSort_(left, right) { const a = mscPhone_(left.name), b = mscPhone_(right.name), ar = mscIphoneRank_(a.model), br = mscIphoneRank_(b.model); if (ar && br) { for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return ar[i] - br[i]; } else if (ar) return -1; else if (br) return 1; else { const models = String(a.model || left.name).localeCompare(String(b.model || right.name), 'ru', {numeric:true,sensitivity:'base'}); if (models) return models; } return Number(left.price || 0) - Number(right.price || 0); }
function mscIphoneRank_(model) { const match = /^iphone\s+(\d+)(e?)(?:\s+(.*))?$/i.exec(String(model || '')); if (!match) return null; const version = mscNorm_(match[3]), variant = match[2] ? 0 : version === '' ? 1 : version === 'mini' ? 2 : version === 'plus' ? 3 : version === 'air' ? 4 : version === 'pro' ? 5 : version === 'pro max' ? 6 : 7; return [Number(match[1]), variant]; }
function mscSummary_(result) { return 'Каталог получен: ' + result.rows + ' позиций. Записано в листы: ' + result.written + (result.skipped ? '. Пропущено: ' + result.skipped + ' (неподходящая категория, архив или неполная цена).' : '') + '. Далее обновляется автоматически каждые 15 минут.'; }
