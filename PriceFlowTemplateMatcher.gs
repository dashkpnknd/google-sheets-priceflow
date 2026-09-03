/**
 * PriceFlow → price template.  It reads only the ready local catalogue and
 * validates every source/target header before the first write.
 */
const PriceFlowTemplateMatcher = (function() {
  function readSheet(sheet, headerRow, firstDataRow, minimumWidth) { const width=Math.max(sheet.getLastColumn(),minimumWidth||0),headers=sheet.getRange(headerRow,1,1,width).getValues()[0],height=Math.max(sheet.getLastRow()-firstDataRow+1,0); return {headers:headers,rows:height?sheet.getRange(firstDataRow,1,height,width).getValues():[]}; }
  function phoneLayouts(headers) {
    const prices=[];headers.forEach(function(value,index){if(PriceFlowAvitoMatcher.header(value)==='price')prices.push(index);});
    return prices.map(function(price,index){const start=index?prices[index-1]+1:0,columns={};headers.slice(start,price+1).forEach(function(value,offset){columns[PriceFlowAvitoMatcher.header(value)]=start+offset;});if(!['model','memorysize','color','simconfig'].every(function(name){return columns[name]>=0;}))return null;return{model:columns.model,memory:columns.memorysize,color:columns.color,sim:columns.simconfig,ram:columns.ramsize===undefined?-1:columns.ramsize,price:price,diagnostic:price+1};}).filter(Boolean);
  }
  function sourceHasLayout(headers,kind){return kind==='phone'?phoneLayouts(headers).length>0:Boolean(PriceFlowAvitoMatcher.titleLayout(headers));}
  function writePrices(sheet,firstDataRow,column,updates){updates.sort(function(a,b){return a.row-b.row;});for(let start=0;start<updates.length;){let end=start+1;while(end<updates.length&&updates[end].row===updates[end-1].row+1)end++;sheet.getRange(firstDataRow+updates[start].row,column+1,end-start,1).setValues(updates.slice(start,end).map(function(update){return[update.price];}));start=end;}}
  function reasonTotals(plans){return plans.reduce(function(result,plan){plan.missing.forEach(function(reason){result[reason]=(result[reason]||0)+1;});return result;},{});}
  function summarize(plans){return plans.reduce(function(result,plan){result.matched+=plan.matched;result.updated+=plan.updates.length;result.cleared+=plan.cleared;result.missing=result.missing.concat(plan.missing);result.ambiguous=result.ambiguous.concat(plan.ambiguous||[]);return result;},{matched:0,updated:0,cleared:0,missing:[],ambiguous:[]});}
  function validateDiagnostics(sheet,layouts,headers,headerRow,firstDataRow,rowCount){
    layouts.forEach(function(layout){
      if(layout.diagnostic>=headers.length)throw new Error('PriceFlowTemplateMatcher: нет диагностической колонки рядом с Price на листе «'+sheet.getName()+'».');
      const title=String(headers[layout.diagnostic]||'').trim();
      if(title&&title!=='Причина без цены')throw new Error('PriceFlowTemplateMatcher: занята диагностическая колонка на листе «'+sheet.getName()+'»; запись не выполнена.');
      if(!title&&rowCount){const range=sheet.getRange(firstDataRow,layout.diagnostic+1,rowCount,1);const values=range.getValues(),formulas=range.getFormulas();if(values.some(function(row){return row[0]!=='';})||formulas.some(function(row){return row[0]!=='';}))throw new Error('PriceFlowTemplateMatcher: диагностическая колонка не свободна на листе «'+sheet.getName()+'»; запись не выполнена.');}
    });
  }
  function sync(config){
    if(!config||!config.sourceSpreadsheet||!config.templateSpreadsheetId||!config.sheets)throw new Error('PriceFlowTemplateMatcher: неполная конфигурация.');
    const sourceBook=config.sourceSpreadsheet,templateBook=SpreadsheetApp.openById(config.templateSpreadsheetId),sourceHeaderRow=config.sourceHeaderRow||1,sourceFirstDataRow=config.sourceFirstDataRow||sourceHeaderRow+1,headerRow=config.headerRow||1,firstDataRow=config.firstDataRow||headerRow+1,staged=[],report={at:new Date().toISOString(),city:config.city||'',sourceRows:0,sheets:{}};
    // The complete plan (including F/O diagnostics) is produced before any Price/header write.
    Object.keys(config.sheets).forEach(function(category){
      const target=config.sheets[category],sourceSheet=sourceBook.getSheetByName(category),templateSheet=templateBook.getSheetByName(target.sheetName||category);
      if(!sourceSheet||!templateSheet)throw new Error('PriceFlowTemplateMatcher: отсутствует лист «'+category+'».');
      const source=readSheet(sourceSheet,sourceHeaderRow,sourceFirstDataRow),destination=readSheet(templateSheet,headerRow,firstDataRow,target.kind==='phone'?15:0);
      if(!sourceHasLayout(source.headers,target.kind))throw new Error('PriceFlowTemplateMatcher: неверная шапка исходного листа «'+sourceSheet.getName()+'»; запись не выполнена.');
      let sourceItems=PriceFlowAvitoMatcher.sourceRows(source.headers,source.rows),plans;
      if(target.kind==='phone'){
        const layouts=phoneLayouts(destination.headers);if(!layouts.length)throw new Error('PriceFlowTemplateMatcher: неверная шапка «'+templateSheet.getName()+'»; запись не выполнена.');
        validateDiagnostics(templateSheet,layouts,destination.headers,headerRow,firstDataRow,destination.rows.length);
        plans=layouts.map(function(layout){return{price:layout.price,diagnostic:layout.diagnostic,plan:PriceFlowAvitoMatcher.planPhone(sourceItems,layout,destination.rows,config)};});
      } else {
        const layout=PriceFlowAvitoMatcher.titleLayout(destination.headers);if(!layout)throw new Error('PriceFlowTemplateMatcher: неверная шапка «'+templateSheet.getName()+'»; запись не выполнена.');
        // Only Dyson OnTrac may use the ready Dyson catalogue as a second source
        // for the headphones template.  Other headphone matching remains local.
        if(category==='наушники'){
          const dyson=sourceBook.getSheetByName('дайсон');if(!dyson)throw new Error('PriceFlowTemplateMatcher: отсутствует лист «дайсон».');
          const dysonData=readSheet(dyson,sourceHeaderRow,sourceFirstDataRow);if(!sourceHasLayout(dysonData.headers,'title'))throw new Error('PriceFlowTemplateMatcher: неверная шапка исходного листа «дайсон»; запись не выполнена.');
          sourceItems=sourceItems.concat(PriceFlowAvitoMatcher.sourceRows(dysonData.headers,dysonData.rows));
        }
        plans=[{price:layout.price,plan:PriceFlowAvitoMatcher.planTitle(sourceItems,category,layout,destination.rows)}];
      }
      const total=summarize(plans.map(function(item){return item.plan;}));staged.push({sheet:templateSheet,headers:destination.headers,plans:plans,rowCount:destination.rows.length});report.sourceRows+=sourceItems.length;report.sheets[category]={matched:total.matched,updated:total.updated,cleared:total.cleared,missing:total.missing.slice(0,200),reasons:target.kind==='phone'?reasonTotals(plans.map(function(item){return item.plan;})):{},ambiguous:total.ambiguous};
    });
    staged.forEach(function(item){item.plans.forEach(function(itemPlan){writePrices(item.sheet,firstDataRow,itemPlan.price,itemPlan.plan.updates);if(itemPlan.diagnostic!==undefined){if(String(item.headers[itemPlan.diagnostic]||'').trim()!=='Причина без цены')item.sheet.getRange(headerRow,itemPlan.diagnostic+1).setValue('Причина без цены');if(item.rowCount)item.sheet.getRange(firstDataRow,itemPlan.diagnostic+1,item.rowCount,1).setValues(itemPlan.plan.reasons.map(function(reason){return[reason||''];}));}});});
    report.updated=Object.keys(report.sheets).reduce(function(total,key){return total+report.sheets[key].updated;},0);report.skippedByReason=Object.keys(report.sheets).reduce(function(total,key){const reasons=report.sheets[key].reasons||{};Object.keys(reasons).forEach(function(reason){total[reason]=(total[reason]||0)+reasons[reason];});return total;},{});return report;
  }
  return {sync:sync,phoneLayouts:phoneLayouts};
})();
