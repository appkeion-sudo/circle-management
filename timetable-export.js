"use strict";
const TimetableExport = (() => {
  const enc = new TextEncoder();
  function download(data, type, name) {
    const url = URL.createObjectURL(new Blob([data], {type}));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function grid(plan) {
    const name = id => plan.people.find(p => p.id === id)?.name || '未割り当て';
    return [
      ['時刻', '内容', 'ローディー1', 'ローディー2', 'タイムキーパー1', 'タイムキーパー2'],
      [TimetableCore.time(plan.pa), 'PA集合', '', '', '', ''],
      [TimetableCore.time(plan.gather), '一般集合', '', '', '', ''],
      ...TimetableCore.rows(plan).map(r => [
        `${TimetableCore.time(r.start)}〜${TimetableCore.time(r.end)}`,
        r.kind === 'performance' ? r.name : r.kind === 'break' ? '休憩' : '転換',
        ...(r.kind === TimetableCore.staffKind(plan) ? r.staff.map(name) : ['', '', '', ''])
      ])
    ];
  }
  function canvases(plan, title, paginate) {
    const data = grid(plan), chunks = [];
    const perPage = paginate ? 26 : data.length;
    for (let offset = 1; offset < data.length; offset += perPage) {
      const body = data.slice(offset, offset + perPage), canvas = document.createElement('canvas');
      canvas.width = 1800; canvas.height = 180 + (body.length + 1) * 68;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#172b42'; ctx.font = 'bold 32px sans-serif'; ctx.fillText(title.slice(0,65), 28, 45);
      ctx.font = '24px sans-serif'; ctx.fillText(`${plan.date}  OD開始 ${TimetableCore.time(plan.start)}  終了 ${TimetableCore.time(TimetableCore.rows(plan).at(-1).end)}`, 28, 92);
      [data[0], ...body].forEach((row, ri) => {
        const y = 125 + ri * 68, widths = [220, 420, 280, 280, 280, 280]; let x = 20;
        row.forEach((cell, ci) => {
          ctx.fillStyle = ri === 0 ? '#e6edf5' : '#fff'; ctx.fillRect(x,y,widths[ci],68);
          ctx.strokeStyle = '#94a3b8'; ctx.strokeRect(x,y,widths[ci],68);
          ctx.fillStyle = '#172b42'; ctx.font = '24px sans-serif';
          // Wrap Japanese names to retain every character in long labels.
          const lines = []; let line = '';
          for (const char of String(cell)) {
            if (ctx.measureText(line + char).width > widths[ci] - 18) {lines.push(line); line = char;} else line += char;
          }
          lines.push(line);
          const size = lines.length > 2 ? Math.max(8, Math.floor(48 / lines.length)) : 24;
          ctx.font = `${size}px sans-serif`;
          lines.forEach((v, k) => ctx.fillText(v, x + 8, y + 25 + k * size));
          x += widths[ci];
        });
      });
      chunks.push(canvas);
    }
    return chunks;
  }
  async function png(plan, title) {
    const canvas = canvases(plan, title, false)[0];
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('PNGの生成に失敗しました');
    download(blob, 'image/png', 'ODタイムテーブル.png');
  }
  function pdf(plan, title) {
    // Japanese is rendered by the browser's canvas font, avoiding missing PDF glyphs.
    const pages = canvases(plan,title,true), parts = [], offsets = [0]; let length = 0;
    const push = data => {const bytes = typeof data === 'string' ? enc.encode(data) : data; parts.push(bytes); length += bytes.length;};
    const obj = (n, text) => {offsets[n] = length; push(`${n} 0 obj\n${text}\nendobj\n`);};
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i) => `${3+i*3} 0 R`).join(' ')}] >>`);
    pages.forEach((canvas, i) => {
      const n = 3+i*3, raw = atob(canvas.toDataURL('image/jpeg',0.94).split(',')[1]);
      const bytes = Uint8Array.from(raw,c => c.charCodeAt(0));
      const height = Math.min(790, canvas.height * 802 / canvas.width), width = canvas.width * height / canvas.height;
      obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 842] /Resources << /XObject << /Im ${n+2} 0 R >> >> /Contents ${n+1} 0 R >>`);
      const stream = `q ${width} 0 0 ${height} 20 ${822-height} cm /Im Do Q`;
      obj(n+1, `<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`);
      offsets[n+2] = length;
      push(`${n+2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      push(bytes); push('\nendstream\nendobj\n');
    });
    const start = length;
    push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    offsets.slice(1).forEach(o => push(`${String(o).padStart(10,'0')} 00000 n \n`));
    push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
    download(new Blob(parts), 'application/pdf', 'ODタイムテーブル.pdf');
  }
  function zip(files) {
    const chunks = [], central = []; let offset = 0, centralLength = 0;
    const header = (size, values) => {const a = new Uint8Array(size), v = new DataView(a.buffer); values.forEach(([p,n,s]) => s === 2 ? v.setUint16(p,n,true) : v.setUint32(p,n,true)); return a;};
    for (const [path, value] of Object.entries(files)) {
      const name = enc.encode(path), data = enc.encode(value); let crc = 0xffffffff;
      for (const byte of data) {crc ^= byte; for (let i=0;i<8;i++) crc = (crc>>>1) ^ (crc&1 ? 0xedb88320 : 0);}
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = header(30, [[0,0x04034b50,4],[4,20,2],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,name.length,2]]);
      chunks.push(local,name,data);
      const entry = header(46, [[0,0x02014b50,4],[4,20,2],[6,20,2],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,name.length,2],[42,offset,4]]);
      central.push(entry,name); centralLength += 46+name.length; offset += 30+name.length+data.length;
    }
    return new Blob([...chunks,...central,header(22,[[0,0x06054b50,4],[8,central.length/2,2],[10,central.length/2,2],[12,centralLength,4],[16,offset,4]])]);
  }
  function excel(plan, title) {
    const xml = s => String(s).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
    const data = [[title,plan.date],...grid(plan)];
    const sheet = data.map((row,i) => `<row r="${i+1}">${row.map((v,j) => `<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join('')}</row>`).join('');
    const files = {
      '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="ODタイムテーブル" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="6" width="30" customWidth="1"/></cols><sheetData>${sheet}</sheetData></worksheet>`
    };
    download(zip(files), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ODタイムテーブル.xlsx');
  }
  return {png,pdf,excel};
})();
