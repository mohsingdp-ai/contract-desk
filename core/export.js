// Excel export workbook, shared by the desktop server and the phone app (no files embedded).
// Kept apart from rules.js so the phone's database worker does not have to load ExcelJS.
import ExcelJS from 'exceljs';

// Download name for the export, stamped with today's date.
export const exportFileName = () => `contract-desk-export-${new Date().toISOString().slice(0, 10)}.xlsx`;

export function exportWorkbook({ scope, contracts, nocs, docs, categories }) {
  const perCategory = new Map();
  for (const d of docs) if (d.contract_id) perCategory.set(`${d.contract_id}|${d.category}`, (perCategory.get(`${d.contract_id}|${d.category}`) || 0) + 1);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Contract Desk';
  wb.created = new Date();
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B1A16' } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  };

  if (scope !== 'nocs') {
    sheet(
      'Contracts',
      [
        { header: 'Contract No.', key: 'contract_no', width: 20 },
        { header: 'Project Name', key: 'project_name', width: 28 },
        { header: 'Firm Name', key: 'firm_name', width: 28 },
        { header: 'Amount', key: 'amount', width: 16, style: { numFmt: '#,##0.00' } },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Attachments', key: 'doc_count', width: 13 },
        ...categories.map((c, i) => ({ header: c, key: `cat${i}`, width: 16 })),
        { header: 'Created', key: 'created_at', width: 22 },
        { header: 'Updated', key: 'updated_at', width: 22 },
      ],
      contracts.map((c) => ({ ...c, ...Object.fromEntries(categories.map((cat, i) => [`cat${i}`, perCategory.get(`${c.id}|${cat}`) || 0])) })),
    );
  }
  if (scope !== 'contracts') {
    sheet(
      'NOCs',
      [
        { header: 'Indent No.', key: 'indent_no', width: 16 },
        { header: 'NOC Name', key: 'noc_name', width: 36 },
        { header: 'Attachments', key: 'doc_count', width: 13 },
        { header: 'Created', key: 'created_at', width: 22 },
        { header: 'Updated', key: 'updated_at', width: 22 },
      ],
      nocs,
    );
  }
  sheet(
    'Documents',
    [
      { header: 'Document ID', key: 'id', width: 12 },
      { header: 'Parent Type', key: 'parent_type', width: 12 },
      { header: 'Contract No. / Indent No.', key: 'parent_no', width: 24 },
      { header: 'Parent Name', key: 'parent_name', width: 28 },
      { header: 'Document Name', key: 'display_name', width: 32 },
      { header: 'Original Filename', key: 'original_name', width: 32 },
      { header: 'Category', key: 'category', width: 26 },
      { header: 'Reference No.', key: 'reference_no', width: 18 },
      { header: 'Tags', key: 'tags', width: 28 },
      { header: 'File Type', key: 'file_type', width: 10 },
      { header: 'Size (bytes)', key: 'size_bytes', width: 13 },
      { header: 'Uploaded', key: 'uploaded_at', width: 22 },
      { header: 'Stored File', key: 'file_path', width: 50 },
    ],
    docs.map((d) => ({
      ...d,
      parent_type: d.parent.type === 'contract' ? 'Contract' : 'NOC',
      parent_no: d.parent.no,
      parent_name: d.parent.name,
      category: d.category || '',
      reference_no: d.reference_no || '',
      tags: d.tags.join(', '),
    })),
  );
  return wb;
}
