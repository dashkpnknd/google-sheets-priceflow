/**
 * Ulyanovsk stage 3 — Nobel.RF fallback catalogue.
 *
 * This module is intentionally not wired into TelegramCatalog.gs or the
 * stage-2 matcher yet.  Its public functions return a complete in-memory
 * catalogue/plan; the future integration point decides when it may write.
 * No remote JavaScript is ever evaluated here.
 */
const PriceFlowNobelCatalog = (function() {
  const HOST = 'https://xn--90aisff1g.xn--p1ai';
  const YELLOW = '#fff200';
  const ROOTS = {
    'телефоны':'/catalog/smartfony/', 'макбуки':'/catalog/kompyutery/',
    'айпады':'/catalog/planshety/', 'часы':'/catalog/smart-chasy/apple-watch/',
    'наушники':'/catalog/headphones/apple-3/',
    'пс':'/catalog/igrovye-pristavki/sonyplaystation/', 'дайсон':'/catalog/dyson/'
  };

  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function normal(value) { return text(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' '); }
  function validUrl(value) {
    const url = text(value); const full = /^https:\/\//i.test(url) ? url : HOST + (url.charAt(0) === '/' ? url : '/' + url);
    if (!new RegExp('^' + HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/catalog/').test(full)) return '';
    return full.replace(/[?#].*$/, '');
  }

  // Restricted decoder for an object literal embedded by Bitrix.  It accepts
  // only strings, numbers, booleans, null, arrays and plain objects; calls,
  // references, getters and arbitrary JavaScript are rejected.
  function LiteralReader(value) { this.s = value; this.i = 0; }
  LiteralReader.prototype.white = function() { while (/\s/.test(this.s.charAt(this.i))) this.i++; };
  LiteralReader.prototype.word = function() { const found = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i)); if (!found) fail('N2','Неверный ключ в конфигурации НОБЕЛЬ.РФ.'); this.i += found[0].length; return found[0]; };
  LiteralReader.prototype.string = function() {
    const quote = this.s.charAt(this.i++); let out = '';
    while (this.i < this.s.length) { const c = this.s.charAt(this.i++); if (c === quote) return out; if (c !== '\\') { out += c; continue; }
      const e = this.s.charAt(this.i++), map = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
      if (e === 'u') { const hex=this.s.slice(this.i,this.i+4); if (!/^[0-9a-f]{4}$/i.test(hex)) fail('N2','Неверная escape-последовательность НОБЕЛЬ.РФ.'); out += String.fromCharCode(parseInt(hex,16)); this.i += 4; }
      else out += Object.prototype.hasOwnProperty.call(map,e) ? map[e] : e;
    } fail('N2','Незакрытая строка в конфигурации НОБЕЛЬ.РФ.');
  };
  LiteralReader.prototype.value = function() {
    this.white(); const c=this.s.charAt(this.i);
    if (c === '\'' || c === '"') return this.string();
    if (c === '{') { this.i++; const out={}; this.white(); while (this.s.charAt(this.i) !== '}') { this.white(); const key=(this.s.charAt(this.i)==='\''||this.s.charAt(this.i)==='"')?this.string():this.word(); this.white(); if(this.s.charAt(this.i++)!==':')fail('N2','Ожидалось поле объекта НОБЕЛЬ.РФ.'); out[key]=this.value(); this.white(); if(this.s.charAt(this.i)===','){this.i++;this.white();if(this.s.charAt(this.i)==='}')break;}else if(this.s.charAt(this.i)!=='}')fail('N2','Ожидался разделитель объекта НОБЕЛЬ.РФ.'); } this.i++; return out; }
    if (c === '[') { this.i++; const out=[]; this.white(); while(this.s.charAt(this.i)!==']'){out.push(this.value());this.white();if(this.s.charAt(this.i)===','){this.i++;this.white();if(this.s.charAt(this.i)===']')break;}else if(this.s.charAt(this.i)!==']')fail('N2','Ожидался разделитель массива НОБЕЛЬ.РФ.');}this.i++;return out; }
    const atom=/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i)); if(!atom)fail('N2','Недопустимое значение конфигурации НОБЕЛЬ.РФ.'); this.i+=atom[0].length; return atom[0]==='true'?true:atom[0]==='false'?false:atom[0]==='null'?null:Number(atom[0]);
  };
  function balanced(value, start) { let quote='', escape=false, depth=0; for(let i=start;i<value.length;i++){const c=value.charAt(i);if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue;}if(c==='\''||c==='"'){quote=c;continue;}if(c==='{')depth++;if(c==='}'&&!--depth)return value.slice(start,i+1);}fail('N2','Незакрытая конфигурация карточки НОБЕЛЬ.РФ.'); }
  function configurations(html) {
    const found=[], re=/new\s+(?:JCCatalogItem|JCCatalogElement)\s*\(/g; let match;
    while ((match=re.exec(html))) { const begin=html.indexOf('{',match.index); if(begin<0)fail('N2','В карточке НОБЕЛЬ.РФ нет объекта конфигурации.'); const object=balanced(html,begin), reader=new LiteralReader(object), parsed=reader.value(); reader.white(); if(reader.i!==object.length)fail('N2','Лишние данные в конфигурации НОБЕЛЬ.РФ.'); found.push(parsed); re.lastIndex=begin+object.length; }
    if(!found.length)fail('N2','Страница НОБЕЛЬ.РФ не содержит JCCatalogItem/JCCatalogElement.'); return found;
  }

  function treeValues(config) { const all={}; (config.TREE_PROPS||[]).forEach(function(prop){const values={};Object.keys(prop.VALUES||{}).forEach(function(id){values[id]=text(prop.VALUES[id]&&prop.VALUES[id].NAME);});all[String(prop.ID)]=values;}); return all; }
  function treeLabels(html, treeId) {
    const labels={}; if(!treeId)return labels;
    // The site reuses one property id for the same SKU dimension within a
    // category.  Reading label → first tree value is less brittle than
    // depending on a fixed closing-div depth in the visual markup.
    const head=/<div[^>]*class=["'][^"']*item__prop-name[^"']*["'][^>]*>/g; let m;
    while((m=head.exec(html))){const close=html.indexOf('</div>',head.lastIndex);if(close<0)break;const label=text(html.slice(head.lastIndex,close).replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ');const tree=/data-treevalue=["'](\d+)_([\d]+)["']/.exec(html.slice(close+6,close+806));if(label&&tree)labels[tree[1]]=label;head.lastIndex=close+6;} return labels;
  }
  function priceOf(offer) { const prices=offer.ITEM_ALL_PRICES||offer.ITEM_PRICES_ALL||offer.ITEM_PRICES||[]; const values=Array.isArray(prices)?prices:Object.keys(prices).map(function(key){return prices[key];}); const base=values.find(function(price){return text(price.CODE).toUpperCase()==='BASE';}); const price=base&&Number(base.UNROUND_PRICE||base.PRICE); return price>0?price:0; }
  function canonicalColor(value) { const key=normal(value); const map={black:'черный',white:'белый',silver:'серебристый','deep blue':'синий','cosmic orange':'оранжевый','mist blue':'голубой',blue:'синий',lavender:'фиолетовый',purple:'фиолетовый','soft pink':'розовый',pink:'розовый',sage:'зеленый',green:'зеленый','space black':'черный','space gray':'серый',starlight:'сияющая звезда',midnight:'черный',natural:'натуральный','jet black':'черный'}; return map[key]||key; }
  function propName(name) { const key=normal(name); if(/памят/.test(key))return'memory';if(/цвет/.test(key))return'color';if(/связ|sim/.test(key))return'sim';if(/оператив|озу|ram/.test(key))return'ram';return''; }
  function propsFor(config, html) { const values=treeValues(config), labels=treeLabels(html,config.VISUAL&&config.VISUAL.TREE_ID), out={}; Object.keys(values).forEach(function(id){const name=propName(labels[id]);if(name)out[id]=name;}); return {values:values,names:out}; }
  function offerRecord(category, config, offer, props, at) {
    const product=config.PRODUCT||{}, title=text(offer.NAME||product.NAME), price=priceOf(offer); if(offer.CAN_BUY!==true||!price||!title)return null;
    const item={source:'nobel',category:category,title:title,model:category==='телефоны'?text(product.NAME):'',memory:'',color:'',sim:'',ram:'',price:price,url:validUrl(product.DETAIL_PAGE_URL),fetchedAt:at};
    if(!item.url)return null; Object.keys(offer.TREE||{}).forEach(function(key){const id=String(key).replace(/^PROP_/,'');const field=props.names[id],value=props.values[id]&&props.values[id][String(offer.TREE[key])];if(field&&value)item[field]=field==='color'?canonicalColor(value):text(value);});
    item.search=[item.title,item.model,item.memory,item.color,item.sim,item.ram].join(' '); if(!PriceFlowAvitoMatcher.eligible(item.search))return null;
    if(category==='телефоны'&&(!item.model||!item.memory||!item.color||!item.sim))return null;
    return item;
  }
  function parsePage(category, html, at) { const records=[], rejected={invalid:0,missingPrice:0}; configurations(html).forEach(function(config){const props=propsFor(config,html), product=config.PRODUCT||{}, offers=(config.OFFERS&&config.OFFERS.length)?config.OFFERS:[product];offers.forEach(function(offer){const item=offerRecord(category,config,offer,props,at);if(item)records.push(item);else if(!priceOf(offer)||offer.CAN_BUY!==true)rejected.missingPrice++;else rejected.invalid++;});});return{items:records,rejected:rejected}; }

  function sectionConfig(html) { const marker=/new\s+JCCatalogSectionComponent\s*\(/.exec(html);if(!marker)fail('N2','В категории НОБЕЛЬ.РФ нет конфигурации пагинации.');const begin=html.indexOf('{',marker.index), object=balanced(html,begin),r=new LiteralReader(object),result=r.value();r.white();if(r.i!==object.length)fail('N2','Неверная пагинация НОБЕЛЬ.РФ.');if(!result.navParams||!result.parameters||!result.componentPath)fail('N2','Неполные параметры пагинации НОБЕЛЬ.РФ.');return result; }
  function fetch(url, options) { const response=UrlFetchApp.fetch(url,Object.assign({muteHttpExceptions:true,followRedirects:true,headers:{Accept:'text/html'}},options||{}));if(response.getResponseCode()!==200)fail('N1','НОБЕЛЬ.РФ вернул HTTP '+response.getResponseCode()+' для '+url);return response.getContentText(); }
  function pages(category) {
    const root=ROOTS[category];if(!root)fail('N3','Не настроен раздел НОБЕЛЬ.РФ для «'+category+'».');const first=fetch(HOST+root),section=sectionConfig(first),nav=section.navParams,count=Number(nav.NavPageCount),number=Number(nav.NavNum);if(!Number.isInteger(count)||count<1||count>200||!Number.isInteger(number))fail('N2','Некорректная пагинация НОБЕЛЬ.РФ.');const out=[first];for(let page=2;page<=count;page++){const payload={action:'showMore',siteId:section.siteId,componentPath:section.componentPath,template:section.template,parameters:section.parameters};payload['PAGEN_'+number]=page;out.push(fetch(HOST+'/local/components/bitrix/catalog.section/ajax.php',{method:'post',payload:payload}));}return out;
  }
  function load(categories) { const started=new Date().toISOString(),all={},report={startedAt:started,categories:{}};(categories||Object.keys(ROOTS)).forEach(function(category){const htmls=pages(category),items=[],rejected={invalid:0,missingPrice:0},seen={};htmls.forEach(function(html){const parsed=parsePage(category,html,new Date().toISOString());parsed.items.forEach(function(item){const key=[item.url,item.title,item.memory,item.color,item.sim,item.ram].join('|');if(!seen[key]){seen[key]=true;items.push(item);}});rejected.invalid+=parsed.rejected.invalid;rejected.missingPrice+=parsed.rejected.missingPrice;});if(!items.length)fail('N3','В разделе «'+category+'» НОБЕЛЬ.РФ нет ни одной допустимой позиции.');all[category]=items;report.categories[category]={pages:htmls.length,items:items.length,rejected:rejected};});report.finishedAt=new Date().toISOString();return{catalogue:all,report:report}; }

  function min(candidates) { const safe=candidates.filter(function(item){return Number(item.price)>0;});return safe.length?{price:Math.min.apply(null,safe.map(function(item){return Number(item.price);})),candidates:safe}:null; }
  function phoneCandidate(items,target,options) { return min(PriceFlowAvitoMatcher.phoneCandidates(items,target,options)); }
  function titleCandidate(items,category,title) { return min(items.filter(function(item){return PriceFlowAvitoMatcher.eligible(item.search||item.title)&&PriceFlowAvitoMatcher.titleMatches(category,title,item.title);})); }
  // Builds an all-or-nothing result.  The caller must perform sheet-header
  // validation and load() for every category before applying these plans.
  function planRows(category, kind, rows, layout, primary, nobel, options) {
    const updates=[], origins=[], diagnostics=[], missing=[], ambiguous=[];
    rows.forEach(function(row,index){const target=kind==='phone'?{model:row[layout.model],memory:row[layout.memory],color:row[layout.color],sim:row[layout.sim],ram:layout.ram>=0?row[layout.ram]:''}:row[layout.title]; if(kind==='phone'&&!text(target.model)){origins[index]='';diagnostics[index]='';return;}
      const first=kind==='phone'?phoneCandidate(primary,target,options):titleCandidate(primary,category,target);const backup=first?null:(kind==='phone'?phoneCandidate(nobel,target,options):titleCandidate(nobel,category,target));const selected=first||backup;
      if(!selected){updates.push({row:index,price:''});origins[index]='';diagnostics[index]='';missing.push({row:index,code:'N4',target:kind==='phone'?target.model:String(target)});return;}
      if(category==='макбуки'&&backup&&backup.candidates.length>1){updates.push({row:index,price:''});origins[index]='';diagnostics[index]='ТРЕБУЕТ РЕШЕНИЯ';ambiguous.push({row:index,code:'M1',title:String(target),candidates:backup.candidates});return;}
      updates.push({row:index,price:selected.price});origins[index]=first?'primary':'nobel';diagnostics[index]=first?'':'Цена из сайта: НОБЕЛЬ.РФ';
    }); return{updates:updates,origins:origins,diagnostics:diagnostics,missing:missing,ambiguous:ambiguous};
  }
  // Deliberately separate from planRows.  This is the only function that
  // changes a sheet, and it is not called by this module automatically.
  function applyFallbackMarks(sheet, firstDataRow, priceColumn, originColumn, plan) {
    if(!sheet)fail('N2','Не задан лист для маркировки резервной цены.');const rows=plan.origins.length;if(!rows)return;
    const priceRange=sheet.getRange(firstDataRow,priceColumn+1,rows,1), backgrounds=priceRange.getBackgrounds();
    plan.origins.forEach(function(origin,index){if(origin==='nobel')backgrounds[index][0]=YELLOW;else if(backgrounds[index][0]===YELLOW)backgrounds[index][0]=null;});priceRange.setBackgrounds(backgrounds);
    if(originColumn!==undefined&&originColumn!==null)sheet.getRange(firstDataRow,originColumn+1,rows,1).setValues(plan.diagnostics.map(function(note){return[note||''];}));
  }
  return {ROOTS:ROOTS,YELLOW:YELLOW,load:load,parsePage:parsePage,configurations:configurations,planRows:planRows,applyFallbackMarks:applyFallbackMarks,sectionConfig:sectionConfig};
})();
