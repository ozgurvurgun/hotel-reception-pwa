/** SpreadsheetML (.xls) - opens in Excel / Numbers; amounts are Number, row totals use formulas */

const TX_TYPE_LABELS = {
  income: 'Income',
  agency: 'Agency',
  walk_in: 'Walk-in',
};

const PAYMENT_LABELS = {
  cash: 'Cash',
  credit_card: 'Credit Card',
  transfer: 'Transfer',
  agency: 'Agency',
  none: '-',
};

const CATEGORY_LABELS = {
  kahvalti: 'Breakfast',
  temizlik: 'Cleaning',
  market: 'Market',
  bakim: 'Maintenance',
  personel: 'Staff',
  diger: 'Other',
};

function xmlEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function excelDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function excelDayStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function cellText(value, style = 'Text') {
  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${xmlEsc(value)}</Data></Cell>`;
}

function cellNumber(value, style = 'Number') {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${safe}</Data></Cell>`;
}

function cellFormula(formula, style = 'Number') {
  return `<Cell ss:StyleID="${style}" ss:Formula="=${xmlEsc(formula)}"><Data ss:Type="Number">0</Data></Cell>`;
}

function row(cells, height) {
  const h = height ? ` ss:Height="${height}"` : '';
  return `<Row${h}>${cells.join('')}</Row>`;
}

function sheetXml(name, rowsXml, widths) {
  const cols = widths.map((w, i) =>
    `<Column ss:Index="${i + 1}" ss:AutoFitWidth="0" ss:Width="${w}"/>`
  ).join('');
  return `
<Worksheet ss:Name="${xmlEsc(name)}">
  <Table>${cols}${rowsXml}</Table>
</Worksheet>`;
}

function txTypeLabel(t) {
  if (t.type === 'agency') {
    return Number(t.amount) > 0 ? 'Agency (pay at door)' : 'Agency (unpaid)';
  }
  return TX_TYPE_LABELS[t.type] || t.type || '-';
}

function paymentLabel(method) {
  return PAYMENT_LABELS[method] || method || '-';
}

function buildWorkbookXml(data) {
  const shift = data.shift || {};
  const stats = data.stats || {};
  const txs = data.transactions || [];
  const exps = data.expenses || [];
  const byMethod = stats.income_by_method || [];
  const cashDiff = shift.closing_cash == null
    ? null
    : (Number(shift.closing_cash) || 0) - (Number(shift.opening_cash) || 0);

  const summaryRows = [
    row([cellText('Golden Gate İstanbul - Shift Report', 'Title')], 24),
    row([cellText('Exported'), cellText(excelDate(new Date().toISOString()))]),
    row([]),
    row([cellText('SUMMARY', 'Section')]),
    row([cellText('Staff'), cellText(data.user_name || '-')]),
    row([cellText('Status'), cellText(shift.status === 'open' ? 'Open' : 'Closed')]),
    row([cellText('Started'), cellText(excelDate(shift.started_at))]),
    row([cellText('Ended'), cellText(shift.ended_at ? excelDate(shift.ended_at) : 'In progress')]),
    row([cellText('Cash opening (₺)'), cellNumber(shift.opening_cash ?? 0, 'Money')]),
    row([
      cellText('Cash closing (₺)'),
      shift.closing_cash == null ? cellText('-') : cellNumber(shift.closing_cash, 'Money'),
    ]),
    row([cellText('Closing notes'), cellText(shift.closing_notes || '-')]),
    row([]),
    row([cellText('FINANCIAL SUMMARY', 'Section')]),
    row([cellText('Total income (₺)'), cellNumber(stats.income_total ?? 0, 'Money')]),
    row([cellText('Total expenses (₺)'), cellNumber(stats.expense_total ?? 0, 'Money')]),
    row([cellText('Net (income − expenses) (₺)'), cellNumber(stats.net ?? 0, 'MoneyBold')]),
    row([
      cellText('Cash difference (closing − opening) (₺)'),
      cashDiff == null ? cellText('-') : cellNumber(cashDiff, 'Money'),
    ]),
    row([]),
    row([cellText('COUNT SUMMARY', 'Section')]),
    row([cellText('Agency unpaid'), cellNumber(stats.agency_count ?? 0)]),
    row([cellText('Agency pay at door'), cellNumber(stats.agency_pay_at_door_count ?? 0)]),
    row([cellText('Walk-in'), cellNumber(stats.walk_in_count ?? 0)]),
    row([cellText('Expense records'), cellNumber(stats.expense_count ?? 0)]),
    row([cellText('Income / entry records'), cellNumber(txs.length)]),
    row([]),
    row([cellText('INCOME BY PAYMENT METHOD', 'Section')]),
    row([cellText('Method', 'Header'), cellText('Count', 'Header'), cellText('Amount (₺)', 'Header')]),
  ];

  if (byMethod.length) {
    byMethod.forEach((m) => {
      summaryRows.push(row([
        cellText(paymentLabel(m.payment_method)),
        cellNumber(m.count ?? 0),
        cellNumber(m.total ?? 0, 'Money'),
      ]));
    });
  } else {
    summaryRows.push(row([cellText('-'), cellNumber(0), cellNumber(0, 'Money')]));
  }

  const incomeRows = [
    row([
      cellText('Date / Time', 'Header'),
      cellText('Type', 'Header'),
      cellText('Room', 'Header'),
      cellText('Guest first name', 'Header'),
      cellText('Guest last name', 'Header'),
      cellText('Agency', 'Header'),
      cellText('Description', 'Header'),
      cellText('Payment', 'Header'),
      cellText('Amount (₺)', 'Header'),
      cellText('Recorded by', 'Header'),
      cellText('Notes', 'Header'),
    ]),
  ];

  txs.forEach((t) => {
    incomeRows.push(row([
      cellText(excelDate(t.created_at)),
      cellText(txTypeLabel(t)),
      cellText(t.room_number || '-'),
      cellText(t.guest_name || '-'),
      cellText(t.guest_surname || '-'),
      cellText(t.agency_name || '-'),
      cellText(t.description || '-'),
      cellText(paymentLabel(t.payment_method)),
      cellNumber(t.amount ?? 0, 'Money'),
      cellText(t.created_by_name || t.created_by_username || '-'),
      cellText(t.notes || ''),
    ]));
  });

  if (txs.length) {
    const firstData = 2;
    const lastData = txs.length + 1;
    incomeRows.push(row([
      cellText('TOTAL', 'Header'),
      cellText(''), cellText(''), cellText(''), cellText(''), cellText(''), cellText(''), cellText(''),
      cellFormula(`SUM(I${firstData}:I${lastData})`, 'MoneyBold'),
      cellText(''), cellText(''),
    ]));
  } else {
    incomeRows.push(row([cellText('No records')]));
  }

  const expenseRows = [
    row([
      cellText('Date / Time', 'Header'),
      cellText('Category', 'Header'),
      cellText('Description', 'Header'),
      cellText('Vendor', 'Header'),
      cellText('Payment', 'Header'),
      cellText('Amount (₺)', 'Header'),
      cellText('Recorded by', 'Header'),
      cellText('Notes', 'Header'),
    ]),
  ];

  exps.forEach((e) => {
    expenseRows.push(row([
      cellText(excelDate(e.created_at)),
      cellText(CATEGORY_LABELS[e.category] || e.category || '-'),
      cellText(e.description || '-'),
      cellText(e.vendor || '-'),
      cellText(paymentLabel(e.payment_method)),
      cellNumber(e.amount ?? 0, 'Money'),
      cellText(e.created_by_name || e.created_by_username || '-'),
      cellText(e.notes || ''),
    ]));
  });

  if (exps.length) {
    const firstData = 2;
    const lastData = exps.length + 1;
    expenseRows.push(row([
      cellText('TOTAL', 'Header'),
      cellText(''), cellText(''), cellText(''), cellText(''),
      cellFormula(`SUM(F${firstData}:F${lastData})`, 'MoneyBold'),
      cellText(''), cellText(''),
    ]));
  } else {
    expenseRows.push(row([cellText('No records')]));
  }

  const styles = `
<Styles>
  <Style ss:ID="Default" ss:Name="Normal">
    <Alignment ss:Vertical="Center"/>
    <Font ss:FontName="Calibri" ss:Size="11"/>
  </Style>
  <Style ss:ID="Text"><Font ss:FontName="Calibri" ss:Size="11"/></Style>
  <Style ss:ID="Title">
    <Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1"/>
  </Style>
  <Style ss:ID="Section">
    <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#1D4ED8"/>
  </Style>
  <Style ss:ID="Header">
    <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
    <Interior ss:Color="#E5E7EB" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Number">
    <NumberFormat ss:Format="0"/>
  </Style>
  <Style ss:ID="Money">
    <NumberFormat ss:Format="#,##0.00"/>
  </Style>
  <Style ss:ID="MoneyBold">
    <Font ss:Bold="1"/>
    <NumberFormat ss:Format="#,##0.00"/>
  </Style>
</Styles>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${styles}
${sheetXml('Summary', summaryRows.join(''), [36, 18, 16])}
${sheetXml('Income', incomeRows.join(''), [20, 22, 10, 14, 14, 16, 24, 12, 12, 16, 24])}
${sheetXml('Expenses', expenseRows.join(''), [20, 14, 28, 16, 12, 12, 16, 24])}
</Workbook>`;
}

function safeFilePart(value) {
  return String(value || 'shift')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shift';
}

export function downloadShiftExcel(data) {
  const xml = buildWorkbookXml(data);
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = excelDayStamp(data.shift?.started_at);
  const who = safeFilePart(data.user_name);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shift-${stamp}-${who}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return a.download;
}

function buildMonthlyWorkbookXml(data) {
  const stats = data.stats || {};
  const txs = data.transactions || [];
  const exps = data.expenses || [];
  const byMethod = stats.income_by_method || [];
  const byCategory = stats.expense_by_category || [];

  const summaryRows = [
    row([cellText('Golden Gate İstanbul - Monthly Report', 'Title')], 24),
    row([cellText('Period'), cellText(data.label || data.year_month || '-')]),
    row([cellText('Exported'), cellText(excelDate(new Date().toISOString()))]),
    row([]),
    row([cellText('FINANCIAL SUMMARY', 'Section')]),
    row([cellText('Total income (₺)'), cellNumber(stats.income_total ?? 0, 'Money')]),
    row([cellText('Total expenses (₺)'), cellNumber(stats.expense_total ?? 0, 'Money')]),
    row([cellText('Net (income − expenses) (₺)'), cellNumber(stats.net ?? 0, 'MoneyBold')]),
    row([]),
    row([cellText('COUNT SUMMARY', 'Section')]),
    row([cellText('Income / entry records'), cellNumber(stats.transaction_count ?? txs.length)]),
    row([cellText('Expense records'), cellNumber(stats.expense_count ?? exps.length)]),
    row([cellText('Agency unpaid'), cellNumber(stats.agency_count ?? 0)]),
    row([cellText('Agency pay at door'), cellNumber(stats.agency_pay_at_door_count ?? 0)]),
    row([cellText('Walk-in'), cellNumber(stats.walk_in_count ?? 0)]),
    row([]),
    row([cellText('INCOME BY PAYMENT METHOD', 'Section')]),
    row([cellText('Method', 'Header'), cellText('Count', 'Header'), cellText('Amount (₺)', 'Header')]),
  ];

  if (byMethod.length) {
    byMethod.forEach((m) => {
      summaryRows.push(row([
        cellText(paymentLabel(m.payment_method)),
        cellNumber(m.count ?? 0),
        cellNumber(m.total ?? 0, 'Money'),
      ]));
    });
  } else {
    summaryRows.push(row([cellText('-'), cellNumber(0), cellNumber(0, 'Money')]));
  }

  summaryRows.push(row([]));
  summaryRows.push(row([cellText('EXPENSES BY CATEGORY', 'Section')]));
  summaryRows.push(row([cellText('Category', 'Header'), cellText('Count', 'Header'), cellText('Amount (₺)', 'Header')]));
  if (byCategory.length) {
    byCategory.forEach((cat) => {
      summaryRows.push(row([
        cellText(CATEGORY_LABELS[cat.category] || cat.category || '-'),
        cellNumber(cat.count ?? 0),
        cellNumber(cat.total ?? 0, 'Money'),
      ]));
    });
  } else {
    summaryRows.push(row([cellText('-'), cellNumber(0), cellNumber(0, 'Money')]));
  }

  const incomeRows = [
    row([
      cellText('Date / Time', 'Header'),
      cellText('Type', 'Header'),
      cellText('Room', 'Header'),
      cellText('Guest first name', 'Header'),
      cellText('Guest last name', 'Header'),
      cellText('Agency', 'Header'),
      cellText('Description', 'Header'),
      cellText('Payment', 'Header'),
      cellText('Amount (₺)', 'Header'),
      cellText('Recorded by', 'Header'),
      cellText('Notes', 'Header'),
    ]),
  ];

  txs.forEach((t) => {
    incomeRows.push(row([
      cellText(excelDate(t.created_at)),
      cellText(txTypeLabel(t)),
      cellText(t.room_number || '-'),
      cellText(t.guest_name || '-'),
      cellText(t.guest_surname || '-'),
      cellText(t.agency_name || '-'),
      cellText(t.description || '-'),
      cellText(paymentLabel(t.payment_method)),
      cellNumber(t.amount ?? 0, 'Money'),
      cellText(t.created_by_name || t.created_by_username || '-'),
      cellText(t.notes || ''),
    ]));
  });

  if (txs.length) {
    const firstData = 2;
    const lastData = txs.length + 1;
    incomeRows.push(row([
      cellText('TOTAL', 'Header'),
      cellText(''), cellText(''), cellText(''), cellText(''), cellText(''), cellText(''), cellText(''),
      cellFormula(`SUM(I${firstData}:I${lastData})`, 'MoneyBold'),
      cellText(''), cellText(''),
    ]));
  } else {
    incomeRows.push(row([cellText('No records')]));
  }

  const expenseRows = [
    row([
      cellText('Date / Time', 'Header'),
      cellText('Category', 'Header'),
      cellText('Description', 'Header'),
      cellText('Vendor', 'Header'),
      cellText('Payment', 'Header'),
      cellText('Amount (₺)', 'Header'),
      cellText('Recorded by', 'Header'),
      cellText('Notes', 'Header'),
    ]),
  ];

  exps.forEach((e) => {
    expenseRows.push(row([
      cellText(excelDate(e.created_at)),
      cellText(CATEGORY_LABELS[e.category] || e.category || '-'),
      cellText(e.description || '-'),
      cellText(e.vendor || '-'),
      cellText(paymentLabel(e.payment_method)),
      cellNumber(e.amount ?? 0, 'Money'),
      cellText(e.created_by_name || e.created_by_username || '-'),
      cellText(e.notes || ''),
    ]));
  });

  if (exps.length) {
    const firstData = 2;
    const lastData = exps.length + 1;
    expenseRows.push(row([
      cellText('TOTAL', 'Header'),
      cellText(''), cellText(''), cellText(''), cellText(''),
      cellFormula(`SUM(F${firstData}:F${lastData})`, 'MoneyBold'),
      cellText(''), cellText(''),
    ]));
  } else {
    expenseRows.push(row([cellText('No records')]));
  }

  const styles = `
<Styles>
  <Style ss:ID="Default" ss:Name="Normal">
    <Alignment ss:Vertical="Center"/>
    <Font ss:FontName="Calibri" ss:Size="11"/>
  </Style>
  <Style ss:ID="Text"><Font ss:FontName="Calibri" ss:Size="11"/></Style>
  <Style ss:ID="Title">
    <Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1"/>
  </Style>
  <Style ss:ID="Section">
    <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#1D4ED8"/>
  </Style>
  <Style ss:ID="Header">
    <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
    <Interior ss:Color="#E5E7EB" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Number">
    <NumberFormat ss:Format="0"/>
  </Style>
  <Style ss:ID="Money">
    <NumberFormat ss:Format="#,##0.00"/>
  </Style>
  <Style ss:ID="MoneyBold">
    <Font ss:Bold="1"/>
    <NumberFormat ss:Format="#,##0.00"/>
  </Style>
</Styles>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${styles}
${sheetXml('Summary', summaryRows.join(''), [36, 18, 16])}
${sheetXml('Income', incomeRows.join(''), [20, 22, 10, 14, 14, 16, 24, 12, 12, 16, 24])}
${sheetXml('Expenses', expenseRows.join(''), [20, 14, 28, 16, 12, 12, 16, 24])}
</Workbook>`;
}

export function downloadMonthlyExcel(data) {
  const xml = buildMonthlyWorkbookXml(data);
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = safeFilePart(data.year_month || 'month');
  const a = document.createElement('a');
  a.href = url;
  a.download = `monthly-report-${stamp}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return a.download;
}
