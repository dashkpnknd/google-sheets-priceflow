/**
 * PriceFlow → price-template, shared stage 2.
 *
 * Copy this file alongside PriceFlowAvitoMatcher.gs into a bound Apps Script
 * project. It reuses its matching rules, reads only ready catalogue tabs, and
 * changes only Price cells in an existing template.
 */
const PriceFlowTemplateMatcher = (function() {
  function readSheet(sheet, headerRow, firstDataRow) {
    const width = sheet.getLastColumn(), headers = sheet.getRange(headerRow, 1, 1, width).getValues()[0];
    const height = Math.max(sheet.getLastRow() - firstDataRow + 1, 0);
    return { headers: headers, rows: height ? sheet.getRange(firstDataRow, 1, height, width).getValues() : [] };
  }

  // A phone template may contain horizontal blocks. iPhone has no RAM column;
  // Android does. Each block is planned independently from the ready catalogue.
  function phoneLayouts(headers) {
    const prices = [];
    headers.forEach(function(value, index) { if (PriceFlowAvitoMatcher.header(value) === 'price') prices.push(index); });
    return prices.map(function(price, index) {
      const start = index ? prices[index - 1] + 1 : 0, columns = {};
      headers.slice(start, price + 1).forEach(function(value, offset) { columns[PriceFlowAvitoMatcher.header(value)] = start + offset; });
      if (!['model', 'memorysize', 'color', 'simconfig'].every(function(name) { return columns[name] >= 0; })) return null;
      return { model: columns.model, memory: columns.memorysize, color: columns.color, sim: columns.simconfig, ram: columns.ramsize === undefined ? -1 : columns.ramsize, price: price };
    }).filter(Boolean);
  }

  function sourceHasLayout(headers, kind) {
    return kind === 'phone' ? phoneLayouts(headers).length > 0 : Boolean(PriceFlowAvitoMatcher.titleLayout(headers));
  }

  function writePrices(sheet, firstDataRow, column, updates) {
    updates.sort(function(a, b) { return a.row - b.row; });
    for (let start = 0; start < updates.length;) {
      let end = start + 1;
      while (end < updates.length && updates[end].row === updates[end - 1].row + 1) end++;
      sheet.getRange(firstDataRow + updates[start].row, column + 1, end - start, 1)
        .setValues(updates.slice(start, end).map(function(update) { return [update.price]; }));
      start = end;
    }
  }

  function summarize(plans) {
    return plans.reduce(function(result, plan) {
      result.matched += plan.matched; result.updated += plan.updates.length; result.cleared += plan.cleared;
      result.missing = result.missing.concat(plan.missing); return result;
    }, { matched: 0, updated: 0, cleared: 0, missing: [] });
  }

  function sync(config) {
    if (!config || !config.sourceSpreadsheet || !config.templateSpreadsheetId || !config.sheets) throw new Error('PriceFlowTemplateMatcher: неполная конфигурация.');
    const sourceBook = config.sourceSpreadsheet, templateBook = SpreadsheetApp.openById(config.templateSpreadsheetId);
    const sourceHeaderRow = config.sourceHeaderRow || 1, sourceFirstDataRow = config.sourceFirstDataRow || sourceHeaderRow + 1;
    const headerRow = config.headerRow || 1, firstDataRow = config.firstDataRow || headerRow + 1;
    const staged = [], report = { at: new Date().toISOString(), city: config.city || '', sourceRows: 0, sheets: {} };

    // Validate and plan every sheet before the first Price write.
    Object.keys(config.sheets).forEach(function(category) {
      const target = config.sheets[category], sourceSheet = sourceBook.getSheetByName(category);
      const templateSheet = templateBook.getSheetByName(target.sheetName || category);
      if (!sourceSheet || !templateSheet) throw new Error('PriceFlowTemplateMatcher: отсутствует лист «' + category + '».');
      const source = readSheet(sourceSheet, sourceHeaderRow, sourceFirstDataRow), destination = readSheet(templateSheet, headerRow, firstDataRow);
      if (!sourceHasLayout(source.headers, target.kind)) throw new Error('PriceFlowTemplateMatcher: неверная шапка исходного листа «' + sourceSheet.getName() + '»; запись не выполнена.');
      const sourceItems = PriceFlowAvitoMatcher.sourceRows(source.headers, source.rows);
      let plans;
      if (target.kind === 'phone') {
        const layouts = phoneLayouts(destination.headers);
        if (!layouts.length) throw new Error('PriceFlowTemplateMatcher: неверная шапка «' + templateSheet.getName() + '»; запись не выполнена.');
        plans = layouts.map(function(layout) { return { price: layout.price, plan: PriceFlowAvitoMatcher.planPhone(sourceItems, layout, destination.rows) }; });
      } else {
        const layout = PriceFlowAvitoMatcher.titleLayout(destination.headers);
        if (!layout) throw new Error('PriceFlowTemplateMatcher: неверная шапка «' + templateSheet.getName() + '»; запись не выполнена.');
        plans = [{ price: layout.price, plan: PriceFlowAvitoMatcher.planTitle(sourceItems, category, layout, destination.rows) }];
      }
      const total = summarize(plans.map(function(item) { return item.plan; }));
      staged.push({ sheet: templateSheet, plans: plans }); report.sourceRows += sourceItems.length;
      report.sheets[category] = { matched: total.matched, updated: total.updated, cleared: total.cleared, missing: total.missing.slice(0, 200), ambiguous: [] };
    });
    staged.forEach(function(item) { item.plans.forEach(function(itemPlan) { writePrices(item.sheet, firstDataRow, itemPlan.price, itemPlan.plan.updates); }); });
    return report;
  }

  return { sync: sync, phoneLayouts: phoneLayouts };
})();
