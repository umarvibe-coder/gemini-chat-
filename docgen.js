/* docgen.js — PDF, Word (.docx) va Excel (.xlsx) fayllarni brauzerning o'zida yasaydi.
   Tashqi kutubxona yo'q. Manba matn: pdf/docx uchun Markdown, xlsx uchun CSV.
   Foydalanish: await DocGen.build("pdf" | "docx" | "xlsx", fayl_nomi, matn) -> Uint8Array */
(function (root) {
  "use strict";
  const enc = new TextEncoder();
  const clean = s => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/\r\n?/g, "\n");
  const xesc = s => clean(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\ud800-\udfff]/g, "");

  /* ---------- Markdown -> bloklar ---------- */
  function inline(s) {
    const runs = []; let b = false, i = false;
    const push = (t, o) => { if (t) runs.push(Object.assign({ t, b, i, c: false }, o || {})); };
    s = String(s).replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (m, a, u) => (a ? a + (/^https?:/i.test(u) ? " (" + u + ")" : "") : u));
    const re = /(\*\*|__)|(`[^`]+`)|(\*|_)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m[3]) {
        const prev = s[m.index - 1], next = s[m.index + 1];
        if (m[3] === "_" && prev && /\w/.test(prev)) continue; // snake_case
        if (!i && (!next || /\s/.test(next))) continue;       // ochuvchi * dan keyin bo'sh joy bo'lmasin
        if (i && prev && /\s/.test(prev)) continue;           // yopuvchi * dan oldin bo'sh joy bo'lmasin
      }
      push(s.slice(last, m.index));
      if (m[1]) b = !b; else if (m[2]) push(m[2].slice(1, -1), { c: true }); else i = !i;
      last = m.index + m[0].length;
    }
    push(s.slice(last));
    return runs;
  }
  function parseMd(src) {
    const lines = clean(src).split("\n"), out = [];
    let k = 0, para = [];
    const flush = () => { if (para.length) { out.push({ t: "p", runs: inline(para.join(" ")) }); para = []; } };
    const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(x => x.trim());
    while (k < lines.length) {
      const ln = lines[k], tr = ln.trim();
      let m;
      if (/^```/.test(tr)) {
        flush(); const code = []; k++;
        while (k < lines.length && !/^```/.test(lines[k].trim())) code.push(lines[k++]);
        k++; out.push({ t: "code", lines: code }); continue;
      }
      if (!tr) { flush(); k++; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(tr))) { flush(); out.push({ t: "h", l: Math.min(m[1].length, 3), runs: inline(m[2].replace(/\s#+\s*$/, "")) }); k++; continue; }
      if (/^([-*_])(\s*\1){2,}$/.test(tr)) { flush(); out.push({ t: "hr" }); k++; continue; }
      if (tr.includes("|") && k + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[k + 1])) {
        flush(); const rows = [cells(tr).map(inline)]; k += 2;
        while (k < lines.length && lines[k].trim() && lines[k].includes("|")) rows.push(cells(lines[k++]).map(inline));
        const n = Math.max(...rows.map(r => r.length));
        rows.forEach(r => { while (r.length < n) r.push([]); r.length = n; });
        out.push({ t: "tbl", rows }); continue;
      }
      if ((m = /^(\s*)([-*+•])\s+(.*)$/.exec(ln))) { flush(); out.push({ t: "li", ord: 0, lvl: Math.min(Math.floor(m[1].replace(/\t/g, "  ").length / 2), 3), runs: inline(m[3]) }); k++; continue; }
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(ln))) { flush(); out.push({ t: "li", ord: +m[2], lvl: Math.min(Math.floor(m[1].replace(/\t/g, "  ").length / 2), 3), runs: inline(m[3]) }); k++; continue; }
      if ((m = /^>\s?(.*)$/.exec(tr))) { flush(); out.push({ t: "p", runs: inline(m[1]).map(r => Object.assign(r, { i: true })) }); k++; continue; }
      para.push(tr); k++;
    }
    flush();
    return out;
  }
  const plain = runs => runs.map(r => r.t).join("");

  /* ---------- ZIP (siqmasdan) ---------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const chunks = [], central = []; let off = 0;
    const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
      const head = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
      chunks.push(head, name, data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
      off += head.length + name.length + data.length;
    }
    let csz = 0; central.forEach(c => { csz += c.length; });
    const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(csz), ...u32(off), 0, 0]);
    return concat([...chunks, ...central, end]);
  }
  function concat(parts) {
    let n = 0; parts.forEach(p => { n += p.length; });
    const o = new Uint8Array(n); let p = 0; parts.forEach(a => { o.set(a, p); p += a.length; });
    return o;
  }

  /* ---------- DOCX ---------- */
  function docx(name, md) {
    const blocks = parseMd(md);
    const W = 9638; // A4, 2 sm chekka
    const run = (r, extra) => {
      let pr = "";
      if (r.c) pr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
      if (r.b || (extra && extra.b)) pr += "<w:b/>";
      if (r.i) pr += "<w:i/>";
      if (r.c) pr += '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>';
      return "<w:r>" + (pr ? "<w:rPr>" + pr + "</w:rPr>" : "") + '<w:t xml:space="preserve">' + xesc(r.t) + "</w:t></w:r>";
    };
    const para = (runs, o) => {
      o = o || {};
      let pp = "";
      if (o.style) pp += '<w:pStyle w:val="' + o.style + '"/>';
      if (o.keep) pp += "<w:keepNext/>";
      if (o.shd) pp += '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shd + '"/>';
      if (o.border) pp += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>';
      if (o.sp != null) pp += '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + o.sp + '"/>';
      if (o.ind != null) pp += '<w:ind w:left="' + o.ind + '" w:hanging="' + (o.hang || 0) + '"/>';
      return "<w:p>" + (pp ? "<w:pPr>" + pp + "</w:pPr>" : "") + runs + "</w:p>";
    };
    let body = "";
    for (const b of blocks) {
      if (b.t === "h") body += para(b.runs.map(r => run(r)).join(""), { style: "Heading" + b.l });
      else if (b.t === "p") body += para(b.runs.map(r => run(r)).join(""), { sp: 120 });
      else if (b.t === "li") {
        const mark = b.ord ? b.ord + "." : "•", ind = 360 + b.lvl * 360;
        body += para(run({ t: mark + "\t" }) + b.runs.map(r => run(r)).join(""), { ind: ind + 360, hang: 360, sp: 60 })
          .replace("<w:pPr>", '<w:pPr><w:tabs><w:tab w:val="left" w:pos="' + (ind + 360) + '"/></w:tabs>');
      } else if (b.t === "hr") body += para("", { border: true, sp: 120 });
      else if (b.t === "code") body += (b.lines.length ? b.lines : [""]).map(l => para(run({ t: l || " ", c: false }).replace("<w:rPr>", "").replace("<w:r>", '<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>'), { shd: "F2F2F2", sp: 0 })).join("") + para("", { sp: 60 });
      else if (b.t === "tbl") {
        const n = b.rows[0].length, cw = Math.floor(W / n);
        const bd = ["top", "left", "bottom", "right", "insideH", "insideV"].map(s => "<w:" + s + ' w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>').join("");
        body += '<w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders>' + bd + '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + "<w:gridCol w:w=\"" + cw + "\"/>".repeat(n) + "</w:tblGrid>" +
          b.rows.map((row, ri) => "<w:tr>" + (ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "") + row.map(c =>
            '<w:tc><w:tcPr><w:tcW w:w="' + cw + '" w:type="dxa"/>' + (ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/>' : "") + "</w:tcPr>" +
            para(c.map(r => run(r, { b: ri === 0 })).join(""), { sp: 0 }) + "</w:tc>").join("") + "</w:tr>").join("") + "</w:tbl>" + para("", { sp: 80 });
      }
    }
    if (!body) body = para("");
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const hs = (id, sz, bef) => '<w:style w:type="paragraph" w:styleId="Heading' + id + '"><w:name w:val="heading ' + id + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="' + bef + '" w:after="100"/><w:outlineLvl w:val="' + (id - 1) + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + sz + '"/></w:rPr></w:style>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="uz-Latn-UZ"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' + hs(1, 40, 360) + hs(2, 32, 280) + hs(3, 26, 200) + "</w:styles>";
    return zip([
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: "word/_rels/document.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "word/styles.xml", data: styles },
      { name: "word/document.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + "><w:body>" + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>' }
    ]);
  }

  /* ---------- XLSX ---------- */
  function parseCsv(src) {
    let s = clean(src).replace(/^﻿/, "");
    const first = s.split("\n")[0] || "";
    const cnt = ch => first.split(ch).length - 1;
    const d = [[",", cnt(",")], [";", cnt(";")], ["\t", cnt("\t")]].sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"' && cur === "") q = true;
      else if (c === d) { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every(x => x === "")) rows.pop();
    return rows;
  }
  const colName = n => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  function xlsx(name, csv) {
    const rows = parseCsv(csv), ncol = Math.max(1, ...rows.map(r => r.length));
    const wid = Array(ncol).fill(8);
    rows.forEach(r => r.forEach((v, c) => { const l = Math.max(...String(v).split("\n").map(x => x.length)); wid[c] = Math.max(wid[c], Math.min(60, l + 3)); }));
    let sd = "";
    rows.forEach((r, ri) => {
      sd += '<row r="' + (ri + 1) + '">';
      for (let c = 0; c < ncol; c++) {
        const v = r[c] == null ? "" : r[c], ref = colName(c) + (ri + 1), st = ri === 0 ? 1 : 2;
        if (v === "") sd += '<c r="' + ref + '" s="' + st + '"/>';
        else if (ri > 0 && /^-?\d{1,15}(\.\d+)?$/.test(v.trim()) && !/^-?0\d/.test(v.trim())) sd += '<c r="' + ref + '" s="' + (/\./.test(v) ? 4 : 3) + '"><v>' + v.trim() + "</v></c>";
        else if (ri > 0 && /^=.+/.test(v.trim())) sd += '<c r="' + ref + '" s="3"><f>' + xesc(v.trim().slice(1)) + "</f></c>";
        else sd += '<c r="' + ref + '" s="' + st + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(v) + "</t></is></c>";
      }
      sd += "</row>";
    });
    const sheet = (String(name).replace(/\.[^.]*$/, "").replace(/[\\\/?*\[\]:]/g, " ").trim() || "Sheet1").slice(0, 31);
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6E6E6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB0B0B0"/></left><right style="thin"><color rgb="FFB0B0B0"/></right><top style="thin"><color rgb="FFB0B0B0"/></top><bottom style="thin"><color rgb="FFB0B0B0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    return zip([
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ' + NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xesc(sheet) + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/styles.xml", data: styles },
      { name: "xl/worksheets/sheet1.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ' + NS + '><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' + wid.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols><sheetData>" + sd + "</sheetData></worksheet>" }
    ]);
  }

  /* ---------- PDF ---------- */
  function parseTtf(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), tb = {};
    const n = dv.getUint16(4);
    for (let i = 0; i < n; i++) { const o = 12 + i * 16; tb[String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) }; }
    const head = tb.head.off, hhea = tb.hhea.off;
    const upm = dv.getUint16(head + 18), nHM = dv.getUint16(hhea + 34), nG = dv.getUint16(tb.maxp.off + 4);
    const bbox = [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)];
    const adv = new Array(nG);
    for (let g = 0; g < nG; g++) adv[g] = dv.getUint16(tb.hmtx.off + 4 * Math.min(g, nHM - 1));
    // cmap, format 4
    const cm = tb.cmap.off, nt = dv.getUint16(cm + 2); let sub = -1;
    for (let i = 0; i < nt; i++) { const pid = dv.getUint16(cm + 4 + i * 8), eid = dv.getUint16(cm + 6 + i * 8), o = dv.getUint32(cm + 8 + i * 8); if (dv.getUint16(cm + o) === 4 && (pid === 3 || pid === 0)) { sub = cm + o; if (pid === 3 && eid === 1) break; } }
    const map = new Map();
    if (sub >= 0) {
      const sc = dv.getUint16(sub + 6) / 2, ends = sub + 14, starts = ends + sc * 2 + 2, deltas = starts + sc * 2, ros = deltas + sc * 2;
      for (let s = 0; s < sc; s++) {
        const e = dv.getUint16(ends + s * 2), st = dv.getUint16(starts + s * 2), d = dv.getInt16(deltas + s * 2), ro = dv.getUint16(ros + s * 2);
        for (let c = st; c <= e && c < 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + d) & 0xffff; else { g = dv.getUint16(ros + s * 2 + ro + (c - st) * 2); if (g) g = (g + d) & 0xffff; }
          if (g) map.set(c, g);
        }
      }
    }
    return { upm, nG, adv, map, bbox, asc: dv.getInt16(hhea + 4), desc: dv.getInt16(hhea + 6), data: buf };
  }

  const loadFont = async url => { const r = await fetch(url); if (!r.ok) throw new Error("Shrift yuklanmadi: " + url); return new Uint8Array(await r.arrayBuffer()); };

  async function pdf(name, md, opt) {
    const fontsDir = (opt && opt.fontsDir) || "fonts/";
    const load = (opt && opt.loadFont) || loadFont;
    const F = { r: parseTtf(await load(fontsDir + "dv-regular.ttf")), b: parseTtf(await load(fontsDir + "dv-bold.ttf")) };
    const used = { r: new Map(), b: new Map() };
    const PW = 595.28, PH = 841.89, M = 56, CW = PW - 2 * M;
    const gidOf = (f, ch) => {
      const cp = ch.codePointAt(0);
      let g = F[f].map.get(cp);
      if (!g) { g = F[f].map.get(cp === 0xa0 ? 32 : 63); }
      return g || 0;
    };
    const sanitize = s => clean(s).replace(/[​-‏️]/g, "").replace(/[\u{10000}-\u{10ffff}]/gu, "").replace(/\t/g, "    ");
    const wOf = (txt, f, size) => { let w = 0; for (const ch of txt) w += F[f].adv[gidOf(f, ch)]; return w * size / F[f].upm; };

    // sahifalar
    const pages = []; let ops = null, y = 0;
    const newPage = () => { ops = []; pages.push(ops); y = PH - M; };
    newPage();
    const hex = (txt, f) => {
      let h = "";
      for (const ch of txt) { const g = gidOf(f, ch); const cp = F[f].map.get(ch.codePointAt(0)) ? ch.codePointAt(0) : (ch === " " ? 32 : 63); used[f].set(g, cp); h += g.toString(16).padStart(4, "0"); }
      return "<" + h + ">";
    };
    const fmt = v => (Math.round(v * 100) / 100).toString();
    const text = (x, yy, txt, f, size, o) => {
      o = o || {}; if (!txt) return;
      const col = o.color || "0.1 0.1 0.12";
      ops.push("BT " + col + " rg /" + (f === "b" ? "F2" : "F1") + " " + fmt(size) + " Tf " + (o.it ? "1 0 0.2 1 " : "1 0 0 1 ") + fmt(x) + " " + fmt(yy) + " Tm " + hex(txt, f) + " Tj ET");
    };
    const rect = (x, yy, w, h, rgb) => ops.push(rgb + " rg " + fmt(x) + " " + fmt(yy) + " " + fmt(w) + " " + fmt(h) + " re f");
    const line = (x1, y1, x2, y2, wd, rgb) => ops.push(rgb + " RG " + wd + " w " + fmt(x1) + " " + fmt(y1) + " m " + fmt(x2) + " " + fmt(y2) + " l S");

    // runs -> so'zlar -> qatorlar
    function layout(runs, width, size, baseBold, indentFirst) {
      const toks = [];
      for (const r of runs) {
        const f = (r.b || baseBold) ? "b" : "r";
        const color = r.c ? "0.55 0.12 0.1" : null;
        for (const p of sanitize(r.t).split(/(\s+)/)) { if (p === "") continue; toks.push({ w: p, sp: /^\s+$/.test(p), f, it: r.i, color }); }
      }
      const lines = []; let cur = [], x = 0;
      const avail = width - (indentFirst || 0);
      const endLine = () => { while (cur.length && cur[cur.length - 1].sp) cur.pop(); lines.push(cur); cur = []; x = 0; };
      for (let t of toks) {
        if (t.sp) { if (cur.length) { t = Object.assign({}, t, { w: " ", wd: wOf(" ", t.f, size) }); cur.push(t); x += t.wd; } continue; }
        let wd = wOf(t.w, t.f, size);
        if (x + wd > avail + 0.01 && cur.length) { endLine(); }
        if (wd > avail) { // juda uzun so'z: belgi bo'yicha bo'lamiz
          let part = "";
          for (const ch of t.w) {
            if (wOf(part + ch, t.f, size) > avail - x && part) { cur.push(Object.assign({}, t, { w: part, wd: wOf(part, t.f, size) })); endLine(); part = ""; }
            part += ch;
          }
          t = Object.assign({}, t, { w: part }); wd = wOf(part, t.f, size);
        }
        cur.push(Object.assign({}, t, { wd })); x += wd;
      }
      if (cur.length || !lines.length) endLine();
      return lines;
    }
    const drawLines = (lines, x0, yTop, size, lh, indentFirst) => {
      lines.forEach((ln, li) => {
        let x = x0 + (li === 0 ? (indentFirst || 0) : 0); const yy = yTop - li * lh - size;
        for (const t of ln) { if (!t.sp) text(x, yy, t.w, t.f, size, { it: t.it, color: t.color }); x += t.wd; }
      });
    };
    const ensure = h => { if (y - h < M + 14) newPage(); };

    const SZ = { 1: 20, 2: 16, 3: 13 };
    let prevList = false;
    for (const b of parseMd(md)) {
      if (b.t === "h") {
        const s = SZ[b.l], lh = s * 1.25, lines = layout(b.runs, CW, s, true);
        ensure(lines.length * lh + 40); if (y < PH - M) y -= s * 0.5;
        drawLines(lines, M, y, s, lh); y -= lines.length * lh + 6;
        if (b.l === 1) { line(M, y + 2, PW - M, y + 2, 0.6, "0.8 0.8 0.84"); y -= 6; }
      } else if (b.t === "p") {
        const s = 11, lh = 15.5, lines = layout(b.runs, CW, s);
        let i = 0;
        while (i < lines.length) {
          ensure(lh * Math.min(2, lines.length - i)); const fit = Math.max(1, Math.floor((y - M - 14) / lh)), n = Math.min(fit, lines.length - i);
          drawLines(lines.slice(i, i + n), M, y, s, lh); y -= n * lh; i += n;
        }
        y -= 6;
      } else if (b.t === "li") {
        const s = 11, lh = 15.5, ind = 16 + b.lvl * 16, mark = b.ord ? b.ord + "." : "•";
        const lines = layout(b.runs, CW - ind - 14, s);
        ensure(lh * Math.min(2, lines.length));
        text(M + ind, y - s, mark, "r", s);
        let i = 0;
        while (i < lines.length) {
          ensure(lh); const fit = Math.max(1, Math.floor((y - M - 14) / lh)), n = Math.min(fit, lines.length - i);
          drawLines(lines.slice(i, i + n), M + ind + 14, y, s, lh); y -= n * lh; i += n;
        }
        y -= 3;
      } else if (b.t === "hr") { ensure(16); y -= 6; line(M, y, PW - M, y, 0.8, "0.75 0.75 0.78"); y -= 10; }
      else if (b.t === "code") {
        const s = 9.5, lh = 13;
        let all = []; (b.lines.length ? b.lines : [""]).forEach(l => { all = all.concat(layout([{ t: sanitize(l) || " ", b: false, i: false, c: false }], CW - 16, s)); });
        let i = 0;
        while (i < all.length) {
          ensure(lh * 2 + 8); const fit = Math.max(1, Math.floor((y - M - 14 - 8) / lh)), n = Math.min(fit, all.length - i);
          rect(M, y - n * lh - 8, CW, n * lh + 8, "0.95 0.95 0.96");
          drawLines(all.slice(i, i + n), M + 8, y - 4, s, lh); y -= n * lh + 8; i += n;
        }
        y -= 8;
      } else if (b.t === "tbl") {
        const n = b.rows[0].length, s = 9.5, lh = 13, pad = 4;
        const len = Array(n).fill(4);
        b.rows.forEach(r => r.forEach((c, k) => { len[k] = Math.max(len[k], Math.min(40, plain(c).length)); }));
        const tot = len.reduce((a, c) => a + c, 0), minW = Math.min(46, CW / n);
        let cw = len.map(l => Math.max(minW, CW * l / tot)); const sc = CW / cw.reduce((a, c) => a + c, 0); cw = cw.map(w => w * sc);
        for (let ri = 0; ri < b.rows.length; ri++) {
          const cells = b.rows[ri].map((c, k) => layout(c, cw[k] - 2 * pad, s, ri === 0));
          const rh = Math.max(...cells.map(l => l.length)) * lh + 2 * pad;
          ensure(rh);
          let x = M;
          cells.forEach((ln, k) => {
            if (ri === 0) rect(x, y - rh, cw[k], rh, "0.92 0.92 0.94");
            drawLines(ln, x + pad, y - pad, s, lh);
            x += cw[k];
          });
          // katak chiziqlari
          x = M; ops.push("0.72 0.72 0.76 RG 0.5 w " + fmt(M) + " " + fmt(y) + " " + fmt(CW) + " " + fmt(-rh) + " re S");
          for (let k = 0; k < n - 1; k++) { x += cw[k]; line(x, y, x, y - rh, 0.5, "0.72 0.72 0.76"); }
          y -= rh;
        }
        y -= 10;
      }
    }

    // sahifa raqamlari
    const total = pages.length;
    pages.forEach((p, i) => {
      ops = p; const lbl = (i + 1) + " / " + total, w = wOf(lbl, "r", 9);
      text((PW - w) / 2, 28, lbl, "r", 9, { color: "0.5 0.5 0.55" });
    });

    // PDF obyektlari
    const objs = []; // har biri: string yoki Uint8Array parts
    const add = parts => { objs.push(parts); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const fontObjs = {};
    const toUni = m => {
      const ent = [...m.entries()].sort((a, b) => a[0] - b[0]); let s = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n";
      for (let i = 0; i < ent.length; i += 100) { const ch = ent.slice(i, i + 100); s += ch.length + " beginbfchar\n" + ch.map(e => "<" + e[0].toString(16).padStart(4, "0") + "> <" + e[1].toString(16).padStart(4, "0") + ">").join("\n") + "\nendbfchar\n"; }
      return s + "endcmap CMapName currentdict /CMap defineresource pop end end";
    };
    const stream = (dict, data) => { const d = typeof data === "string" ? enc.encode(data) : data; return [dict + "/Length " + d.length + ">>\nstream\n", d, "\nendstream"]; };
    for (const f of ["r", "b"]) {
      const T = F[f], sc = 1000 / T.upm;
      const file = add(stream("<</Length1 " + T.data.length, T.data));
      const desc = add("<</Type/FontDescriptor/FontName/" + (f === "b" ? "DejaVuSans-Bold" : "DejaVuSans") + "/Flags 32/FontBBox[" + T.bbox.map(v => Math.round(v * sc)).join(" ") + "]/ItalicAngle 0/Ascent " + Math.round(T.asc * sc) + "/Descent " + Math.round(T.desc * sc) + "/CapHeight " + Math.round(T.asc * sc * 0.73) + "/StemV " + (f === "b" ? 140 : 80) + "/FontFile2 " + file + " 0 R>>");
      const cid = add("<</Type/Font/Subtype/CIDFontType2/BaseFont/" + (f === "b" ? "DejaVuSans-Bold" : "DejaVuSans") + "/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor " + desc + " 0 R/CIDToGIDMap/Identity/DW 600/W[0[" + T.adv.map(a => Math.round(a * sc)).join(" ") + "]]>>");
      const tu = add(stream("<<", toUni(used[f])));
      fontObjs[f] = add("<</Type/Font/Subtype/Type0/BaseFont/" + (f === "b" ? "DejaVuSans-Bold" : "DejaVuSans") + "/Encoding/Identity-H/DescendantFonts[" + cid + " 0 R]/ToUnicode " + tu + " 0 R>>");
    }
    const kids = [];
    pages.forEach(p => {
      const c = add(stream("<<", p.join("\n")));
      kids.push(add("<</Type/Page/Parent " + pagesObj + " 0 R/MediaBox[0 0 " + PW + " " + PH + "]/Resources<</Font<</F1 " + fontObjs.r + " 0 R/F2 " + fontObjs.b + " 0 R>>>>/Contents " + c + " 0 R>>"));
    });
    objs[catalog - 1] = "<</Type/Catalog/Pages " + pagesObj + " 0 R>>";
    objs[pagesObj - 1] = "<</Type/Pages/Kids[" + kids.map(k => k + " 0 R").join(" ") + "]/Count " + kids.length + ">>";
    const title = clean(String(name).replace(/\.pdf$/i, ""));
    let th = "FEFF"; for (let i = 0; i < title.length; i++) th += title.charCodeAt(i).toString(16).padStart(4, "0");
    const info = add("<</Title<" + th + ">/Producer(Gemini Chat)>>");

    const parts = [enc.encode("%PDF-1.5\n%\u00e2\u00e3\u00cf\u00d3\n")];
    let off = parts[0].length; const offs = [];
    objs.forEach((o, i) => {
      offs.push(off);
      const ps = Array.isArray(o) ? o : [o], chunk = [enc.encode((i + 1) + " 0 obj\n")];
      ps.forEach(p => chunk.push(typeof p === "string" ? enc.encode(p) : p));
      chunk.push(enc.encode("\nendobj\n"));
      const c = concat(chunk); parts.push(c); off += c.length;
    });
    let x = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    x += "trailer\n<</Size " + (objs.length + 1) + "/Root " + catalog + " 0 R/Info " + info + " 0 R>>\nstartxref\n" + off + "\n%%EOF\n";
    parts.push(enc.encode(x));
    return concat(parts);
  }

  /* ---------- Markdown -> HTML (ilova ichidagi ko'rish uchun, kutubxonasiz) ---------- */
  function toHtml(src) {
    const h = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const rn = runs => runs.map(r => { let t = h(r.t); if (r.c) t = "<code>" + t + "</code>"; if (r.b) t = "<strong>" + t + "</strong>"; if (r.i) t = "<em>" + t + "</em>"; return t; }).join("");
    let out = "", list = null;
    const close = () => { if (list) { out += "</" + list + ">"; list = null; } };
    for (const b of parseMd(src)) {
      if (b.t === "li") { const tag = b.ord ? "ol" : "ul"; if (list !== tag) { close(); out += "<" + tag + ">"; list = tag; } out += '<li style="margin-left:' + b.lvl * 18 + 'px">' + rn(b.runs) + "</li>"; continue; }
      close();
      if (b.t === "h") out += "<h" + b.l + ">" + rn(b.runs) + "</h" + b.l + ">";
      else if (b.t === "p") out += "<p>" + rn(b.runs) + "</p>";
      else if (b.t === "hr") out += "<hr>";
      else if (b.t === "code") out += "<pre>" + h(b.lines.join("\n")) + "</pre>";
      else if (b.t === "tbl") out += '<div class="tw"><table><thead><tr>' + b.rows[0].map(c => "<th>" + rn(c) + "</th>").join("") + "</tr></thead><tbody>" + b.rows.slice(1).map(r => "<tr>" + r.map(c => "<td>" + rn(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    }
    close();
    return out;
  }
  const MIME = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };
  async function build(format, name, content, opt) {
    if (format === "pdf") return pdf(name, content, opt);
    if (format === "docx") return docx(name, content);
    if (format === "xlsx") return xlsx(name, content);
    throw new Error("Noma'lum format: " + format);
  }
  root.DocGen = { build, MIME, parseMd, parseCsv, toHtml };
  if (typeof module !== "undefined") module.exports = root.DocGen;
})(typeof window !== "undefined" ? window : globalThis);
