// Makes the sample files the upload flow picks (a PDF, a PNG, an Excel sheet, a CSV) and writes them to the folder given.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });

// One-page PDF with a line of text; byte offsets in the xref table are computed.
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  null,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const text = 'BT /F1 18 Tf 30 100 Td (Maestro invoice M-1) Tj ET';
objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
let pdf = '%PDF-1.4\n';
const at = objs.map((o, i) => {
  const off = pdf.length;
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  return off;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(dir, 'cd-invoice.pdf'), pdf);

// 120x80 orange PNG.
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
};
const [w, h] = [120, 80];
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [255, 106, 51]).flat()])));
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(dir, 'cd-scan.png'), png);

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Items');
ws.addRows([['Item', 'Qty', 'Price'], ['Cement', 40, 12.5], ['Steel', 7, 410]]);
await wb.xlsx.writeFile(path.join(dir, 'cd-sheet.xlsx'));

fs.writeFileSync(path.join(dir, 'cd-list.csv'), 'Item,Qty\nSand,12\nGravel,30\n');
console.log(`sample files in ${dir}: ${fs.readdirSync(dir).join(', ')}`);
