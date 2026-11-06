const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const writes=[];
class Sheet {
  constructor(name,grid){this.name=name;this.grid=grid.map(r=>r.slice());}
  getName(){return this.name;}
  getLastColumn(){return this.grid[0].length;}
  getLastRow(){return this.grid.length;}
  getRange(row,column,height=1,width=1){
    const sheet=this;
    return {
      getValues(){return Array.from({length:height},(_,r)=>Array.from({length:width},(_,c)=>sheet.grid[row-1+r]?.[column-1+c]??''));},
      getFormulas(){return Array.from({length:height},()=>Array(width).fill(''));},
      setValues(values){writes.push({row,column,height,width});values.forEach((values,r)=>values.forEach((v,c)=>{sheet.grid[row-1+r]??=[];sheet.grid[row-1+r][column-1+c]=v;}));return this;},
      setValue(value){writes.push({row,column,height:1,width:1});sheet.grid[row-1][column-1]=value;return this;}
    };
  }
}
const source=new Sheet('телефоны',[
  ['Model','SimConfig','MemorySize','Color','RamSize','Price'],
  ['Galaxy S26 Plus','2 SIM','256 ГБ','белый','12 ГБ',65000],
  ['Xiaomi 17T Pro','Не знаю','512 ГБ','черный','12 ГБ',53000],
  ['Honor 600 Pro','Не знаю','256 ГБ','белый','12 ГБ',47000],
  ['Pixel 11 Pro','Не знаю','256 ГБ','черный','12 ГБ',79000]
]);
const destination=new Sheet('телефоны',[
  ['Vendor','Model','MemorySize','Color','SimConfig','RamSize','Price','Причина без цены'],
  ['Samsung','Galaxy S26+','256 ГБ','белый','Не знаю','12 ГБ','', 'old reason'],
  ['Xiaomi','17T Pro','512 ГБ','черный','Не знаю','12 ГБ','', 'old reason'],
  ['HONOR','600 Pro','256 ГБ','белый','Не знаю','12 ГБ','', 'old reason'],
  ['Google','Pixel 11 Pro','256 ГБ','черный','Не знаю','12 ГБ','', 'old reason']
]);
const ctx=vm.createContext({console,SpreadsheetApp:{openById(){return{getSheetByName(){return destination;}};}}});
for(const p of [__dirname+'/./PriceFlowAvitoMatcher.gs',__dirname+'/./PriceFlowTemplateMatcher.gs'])vm.runInContext(fs.readFileSync(p,'utf8'),ctx);
const matcher=vm.runInContext('PriceFlowTemplateMatcher',ctx);
const result=matcher.sync({city:'elektrostal',sourceSpreadsheet:{getSheetByName(){return source;}},templateSpreadsheetId:'test',sheets:{телефоны:{sheetName:'телефоны',kind:'phone'}},priceOnly:true,allowIphoneAirAlias:true});
assert.equal(result.sheets.телефоны.matched,4);
assert.deepEqual(destination.grid.slice(1).map(r=>r[6]),[65000,53000,47000,79000]);
assert.deepEqual(destination.grid.slice(1).map(r=>r[7]),Array(4).fill('old reason'));
assert.ok(writes.every(x=>x.column===7&&x.width===1),'only Price is written');
console.log('Stage 2 vendor, model, price-only tests passed:',result.sheets.телефоны.matched);
