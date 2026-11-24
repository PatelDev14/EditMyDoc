/* Private PDF Toolbox — everything runs locally in the browser. Zero uploads. */
const { PDFDocument, degrees, StandardFonts, rgb, PageSizes } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const base = f => f.name.replace(/\.[^.]+$/, '');
const fmt = b => b > 1e6 ? (b / 1e6).toFixed(2) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const toBlob = (c, type, q) => new Promise((resolve, reject) => {
  c.toBlob(blob => {
    if (!blob || blob.type !== type) reject(new Error(`Could not encode image as ${type}.`));
    else resolve(blob);
  }, type, q);
});
const pdfBlob = bytes => new Blob([bytes], { type: 'application/pdf' });
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = f => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name);

function status(m, type) {
  const s = $('#status');
  s.textContent = m || '';
  s.className = type === true || type === 'err' ? 'err' : type === 'ok' ? 'ok' : '';
}

function setProgress(pct) {
  const wrap = $('#progress');
  const bar = $('#progressBar');
  if (pct == null || pct >= 100) {
    wrap.classList.add('hidden');
    bar.style.width = '0%';
    return;
  }
  wrap.classList.remove('hidden');
  bar.style.width = Math.max(2, Math.min(100, pct)) + '%';
}

// "1-3, 5, 8-" -> zero-based page indexes
function parseRanges(str, max) {
  const out = [];
  String(str).split(',').forEach(t => {
    t = t.trim(); if (!t) return;
    const m = t.match(/^(\d*)-(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1, b = m[2] ? Number(m[2]) : max;
      for (let i = Math.max(1, a); i <= Math.min(b, max); i++) out.push(i - 1);
    } else if (/^\d+$/.test(t) && +t >= 1 && +t <= max) out.push(+t - 1);
  });
  return [...new Set(out)];
}

/** Load a PDF. Encrypted files throw a clear error (do not use ignoreEncryption — it produces broken output). */
async function loadPdf(f) {
  const buf = await f.arrayBuffer();
  try {
    return await PDFDocument.load(buf, { updateMetadata: false });
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/encrypt|password/i.test(msg))
      throw new Error(`"${f.name}" is password-protected or permission-locked. Use the Unlock tool first.`);
    throw new Error(`"${f.name}" could not be read: ${msg || 'damaged or unsupported file'}`);
  }
}

/**
 * Copy every page into a brand-new document.
 * Modifying complex PDFs in place often produces files that macOS Preview rejects as "damaged".
 * Working on a fresh copy is the reliable path for numbers, watermark, signature, etc.
 */
async function clonePdf(src) {
  const d = await PDFDocument.create();
  const pages = await d.copyPages(src, src.getPageIndices());
  pages.forEach(p => d.addPage(p));
  return d;
}

/** Save with options that maximize compatibility (especially macOS Preview). */
async function savePdf(doc) {
  const bytes = await doc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false
  });
  // Integrity check: must re-open and keep the same page count
  try {
    const check = await PDFDocument.load(bytes);
    if (check.getPageCount() !== doc.getPageCount())
      throw new Error('page count mismatch after save');
  } catch (e) {
    throw new Error('Output failed integrity check (' + (e.message || 'corrupt') + '). No file was produced.');
  }
  return bytes;
}

function loadPdfJs(data, password) {
  return pdfjsLib.getDocument({ data, password, isEvalSupported: false });
}

async function openPdfJs(f, password) {
  return loadPdfJs(await f.arrayBuffer(), password).promise;
}

function pdfPageKeyStep(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
      event.shiftKey || event.target.closest?.('input, select, textarea, [contenteditable]')) return 0;
  if (event.key === 'PageUp' || event.key === 'ArrowLeft') return -1;
  if (event.key === 'PageDown' || event.key === 'ArrowRight') return 1;
  return 0;
}

async function renderPage(pdf, n, scale, type, q) {
  const p = await pdf.getPage(n);
  const vp = p.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = vp.width;
  c.height = vp.height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: x, viewport: vp }).promise;
  return toBlob(c, type, q);
}

async function loadImage(f) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(f); } catch (e) {}
  }
  return new Promise((res, rej) => {
    const i = new Image();
    const url = URL.createObjectURL(f);
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error(`Could not read image "${f.name}".`));
    };
    i.src = url;
  });
}

async function toPngBytes(f) {
  const img = await loadImage(f);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return new Uint8Array(await (await toBlob(c, 'image/png')).arrayBuffer());
}

async function imageToCanvas(f) {
  const img = await loadImage(f);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

/* ─────────────────────────────────────────────
   TOOL DEFINITIONS
   ───────────────────────────────────────────── */
const TOOLS = [
  /* ── PDF ── */
  {
    id: 'merge', cat: 'PDF', icon: '⊕', name: 'Merge PDF',
    desc: 'Combine multiple PDFs into one file. Use the arrows to set the exact order.',
    accept: '.pdf', multi: true, min: 2, opts: [],
    async run(files) {
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        status(`Merging ${i + 1} of ${files.length}…`);
        setProgress((i / files.length) * 90);
        const d = await loadPdf(files[i]);
        (await out.copyPages(d, d.getPageIndices())).forEach(p => out.addPage(p));
      }
      setProgress(100);
      return [{ name: 'merged.pdf', blob: pdfBlob(await savePdf(out)) }];
    }
  },
  {
    id: 'split', cat: 'PDF', icon: '✂', name: 'Split & extract',
    desc: 'Keep selected pages, remove pages, or split every page into its own PDF.',
    accept: '.pdf', multi: false, opts: [
      { id: 'mode', label: 'Mode', type: 'select', options: [
        ['extract', 'Keep these pages'],
        ['remove', 'Remove these pages'],
        ['each', 'Split every page']
      ]},
      { id: 'pages', label: 'Pages (e.g. 1-3, 5, 8-)', type: 'text', value: '1', hint: 'Leave blank for “every page” when splitting' }
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const n = src.getPageCount();
      const mk = async idx => {
        const d = await PDFDocument.create();
        (await d.copyPages(src, idx)).forEach(p => d.addPage(p));
        return pdfBlob(await savePdf(d));
      };
      if (o.mode === 'each') {
        const r = [];
        for (let i = 0; i < n; i++) {
          status(`Page ${i + 1} of ${n}`);
          setProgress((i / n) * 95);
          r.push({ name: `${base(f)}-page-${i + 1}.pdf`, blob: await mk([i]) });
        }
        setProgress(100);
        return r;
      }
      let idx = parseRanges(o.pages, n);
      if (!idx.length) throw new Error('No valid pages selected.');
      if (o.mode === 'remove') idx = src.getPageIndices().filter(i => !idx.includes(i));
      if (!idx.length) throw new Error('No valid pages selected.');
      return [{ name: `${base(f)}-edited.pdf`, blob: await mk(idx) }];
    }
  },
  {
    id: 'compress', cat: 'PDF', icon: '⇩', name: 'Compress PDF',
    desc: 'Shrink image-heavy or scanned PDFs. Pages are re-rendered as images (text becomes non-selectable).',
    accept: '.pdf', multi: true, opts: [
      { id: 'lvl', label: 'Compression', type: 'select', options: [
        ['0.55|1.0', 'Strong (smallest)'],
        ['0.72|1.4', 'Balanced'],
        ['0.88|2.0', 'Light (best quality)']
      ], value: '0.72|1.4' }
    ],
    async run(files, o) {
      const [q, s] = o.lvl.split('|').map(Number);
      const res = [];
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const pdf = await openPdfJs(f);
        const out = await PDFDocument.create();
        for (let i = 1; i <= pdf.numPages; i++) {
          status(`${f.name}: page ${i}/${pdf.numPages}`);
          setProgress(((fi + i / pdf.numPages) / files.length) * 95);
          const base1 = (await pdf.getPage(i)).getViewport({ scale: 1 });
          const img = await out.embedJpg(await (await renderPage(pdf, i, s, 'image/jpeg', q)).arrayBuffer());
          out.addPage([base1.width, base1.height]).drawImage(img, { x: 0, y: 0, width: base1.width, height: base1.height });
        }
        const blob = pdfBlob(await savePdf(out));
        res.push({ name: `${base(f)}-compressed.pdf`, blob, note: `${fmt(f.size)} → ${fmt(blob.size)}` });
      }
      setProgress(100);
      return res;
    }
  },
  {
    id: 'rotate', cat: 'PDF', icon: '↻', name: 'Rotate PDF',
    desc: 'Rotate every page (or selected pages) by 90°, 180°, or 270°.',
    accept: '.pdf', multi: false, opts: [
      { id: 'deg', label: 'Rotate', type: 'select', options: [
        ['90', '90° clockwise'],
        ['180', '180°'],
        ['270', '90° counter-clockwise']
      ]},
      { id: 'pages', label: 'Pages (blank = all)', type: 'text', value: '', hint: 'e.g. 1-3, 5' }
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      const n = d.getPageCount();
      const idxs = o.pages.trim() ? parseRanges(o.pages, n) : d.getPageIndices();
      if (!idxs.length) throw new Error('No valid pages selected.');
      idxs.forEach(i => {
        const p = d.getPage(i);
        p.setRotation(degrees((p.getRotation().angle + +o.deg) % 360));
      });
      return [{ name: `${base(f)}-rotated.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'numbers', cat: 'PDF', icon: '#', name: 'Page numbers',
    desc: 'Stamp sequential page numbers on every page.',
    accept: '.pdf', multi: false, opts: [
      { id: 'pos', label: 'Position', type: 'select', options: [
        ['bc', 'Bottom center'], ['br', 'Bottom right'], ['bl', 'Bottom left'],
        ['tc', 'Top center'], ['tr', 'Top right'], ['tl', 'Top left']
      ]},
      { id: 'start', label: 'Start at', type: 'number', value: 1 },
      { id: 'fmt', label: 'Format', type: 'select', options: [
        ['n', '1, 2, 3…'],
        ['of', '1 of N'],
        ['page', 'Page 1']
      ]}
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      const font = await d.embedFont(StandardFonts.Helvetica);
      const total = d.getPageCount();
      d.getPages().forEach((p, i) => {
        const { width: w, height: h } = p.getSize();
        let t = String(+o.start + i);
        if (o.fmt === 'of') t = `${+o.start + i} of ${total}`;
        if (o.fmt === 'page') t = `Page ${+o.start + i}`;
        const size = 11;
        const tw = font.widthOfTextAtSize(t, size);
        const x = o.pos[1] === 'c' ? (w - tw) / 2 : o.pos[1] === 'r' ? w - tw - 28 : 28;
        const y = o.pos[0] === 'b' ? 22 : h - 32;
        p.drawText(t, { x, y, size, font, color: rgb(0.25, 0.25, 0.25) });
      });
      return [{ name: `${base(f)}-numbered.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'watermark', cat: 'PDF', icon: '◈', name: 'Watermark',
    desc: 'Add diagonal text watermark across every page.',
    accept: '.pdf', multi: false, opts: [
      { id: 'text', label: 'Text', type: 'text', value: 'CONFIDENTIAL' },
      { id: 'op', label: 'Opacity (0.05 – 1)', type: 'number', value: 0.22 },
      { id: 'color', label: 'Color', type: 'select', options: [
        ['gray', 'Gray'], ['red', 'Red'], ['blue', 'Blue'], ['black', 'Black']
      ]}
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      const font = await d.embedFont(StandardFonts.HelveticaBold);
      const colors = { gray: rgb(0.5, 0.5, 0.5), red: rgb(0.8, 0.15, 0.15), blue: rgb(0.15, 0.3, 0.7), black: rgb(0.1, 0.1, 0.1) };
      const col = colors[o.color] || colors.gray;
      d.getPages().forEach(p => {
        const { width: w, height: h } = p.getSize();
        const size = Math.min(w, h) / 9;
        const tw = font.widthOfTextAtSize(o.text, size);
        p.drawText(o.text, {
          x: w / 2 - (tw / 2) * Math.cos(Math.PI / 4),
          y: h / 2 - (tw / 2) * Math.sin(Math.PI / 4),
          size, font, color: col,
          opacity: Math.min(1, Math.max(0.05, +o.op)),
          rotate: degrees(45)
        });
      });
      return [{ name: `${base(f)}-watermarked.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'metadata', cat: 'PDF', icon: 'ℹ', name: 'Edit metadata',
    desc: 'Change title, author, subject and keywords stored inside the PDF.',
    accept: '.pdf', multi: false, opts: [
      { id: 'title', label: 'Title', type: 'text', value: '' },
      { id: 'author', label: 'Author', type: 'text', value: '' },
      { id: 'subject', label: 'Subject', type: 'text', value: '' },
      { id: 'keywords', label: 'Keywords', type: 'text', value: '', hint: 'Comma-separated' }
    ],
    async run([f], o) {
      const d = await loadPdf(f);
      if (o.title) d.setTitle(o.title);
      if (o.author) d.setAuthor(o.author);
      if (o.subject) d.setSubject(o.subject);
      if (o.keywords) d.setKeywords(o.keywords.split(',').map(s => s.trim()).filter(Boolean));
      d.setModificationDate(new Date());
      d.setProducer('Private PDF Toolbox');
      return [{ name: `${base(f)}-meta.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },

  {
    id: 'blank', cat: 'PDF', icon: '⬜', name: 'Add blank pages',
    desc: 'Insert blank pages at the beginning, end, or after a specific page.',
    accept: '.pdf', multi: false, opts: [
      { id: 'where', label: 'Insert', type: 'select', options: [
        ['start', 'At the beginning'],
        ['end', 'At the end'],
        ['after', 'After page number…']
      ]},
      { id: 'after', label: 'After page (if selected)', type: 'number', value: 1 },
      { id: 'count', label: 'How many blank pages', type: 'number', value: 1 },
      { id: 'size', label: 'Page size', type: 'select', options: [
        ['same', 'Same as first page'],
        ['a4', 'A4'],
        ['letter', 'Letter']
      ]}
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const first = src.getPage(0).getSize();
      let w = first.width, h = first.height;
      if (o.size === 'a4') { w = 595; h = 842; }
      if (o.size === 'letter') { w = 612; h = 792; }
      const count = Math.max(1, Math.min(50, Math.trunc(+o.count) || 1));
      const n = src.getPageCount();
      const out = await PDFDocument.create();
      const insertAt = o.where === 'start' ? 0
        : o.where === 'after' ? Math.max(1, Math.min(n, Math.trunc(+o.after) || 1))
        : n;
      if (insertAt > 0) {
        (await out.copyPages(src, src.getPageIndices().slice(0, insertAt))).forEach(p => out.addPage(p));
      }
      for (let i = 0; i < count; i++) out.addPage([w, h]);
      if (insertAt < n) {
        (await out.copyPages(src, src.getPageIndices().slice(insertAt))).forEach(p => out.addPage(p));
      }
      return [{ name: `${base(f)}-blank.pdf`, blob: pdfBlob(await savePdf(out)) }];
    }
  },
  {
    id: 'info', cat: 'PDF', icon: '📋', name: 'PDF info',
    desc: 'Show page count, size, metadata and basic properties of a PDF.',
    accept: '.pdf', multi: false, opts: [],
    async run([f]) {
      const d = await loadPdf(f);
      const n = d.getPageCount();
      const page0 = d.getPage(0).getSize();
      const title = d.getTitle() || '—';
      const author = d.getAuthor() || '—';
      const subject = d.getSubject() || '—';
      const creator = d.getCreator() || '—';
      const producer = d.getProducer() || '—';
      const created = d.getCreationDate();
      const modified = d.getModificationDate();
      const lines = [
        `File: ${f.name}`,
        `Size: ${fmt(f.size)}`,
        `Pages: ${n}`,
        `First page: ${Math.round(page0.width)} × ${Math.round(page0.height)} pt`,
        `Title: ${title}`,
        `Author: ${author}`,
        `Subject: ${subject}`,
        `Creator: ${creator}`,
        `Producer: ${producer}`,
        `Created: ${created ? created.toLocaleString() : '—'}`,
        `Modified: ${modified ? modified.toLocaleString() : '—'}`
      ];
      const text = lines.join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      return [{ name: `${base(f)}-info.txt`, blob, note: `${n} pages` }];
    }
  },
  {
    id: 'extract-text', cat: 'PDF', icon: '文字', name: 'Extract text',
    desc: 'Pull selectable text out of a PDF into a plain .txt file.',
    accept: '.pdf', multi: false, opts: [],
    async run([f]) {
      const pdf = await openPdfJs(f);
      let full = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        status(`Extracting page ${i}/${pdf.numPages}`);
        setProgress((i / pdf.numPages) * 95);
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const str = content.items.map(it => it.str).join(' ');
        full += `--- Page ${i} ---\n${str}\n\n`;
      }
      setProgress(100);
      const blob = new Blob([full], { type: 'text/plain;charset=utf-8' });
      return [{ name: `${base(f)}.txt`, blob, note: `${pdf.numPages} pages` }];
    }
  },

  /* ── Images ── */
  {
    id: 'img2pdf', cat: 'Images', icon: '▣', name: 'Images to PDF',
    desc: 'Turn JPG, PNG, WebP or GIF images into a single PDF. Use arrows to reorder.',
    accept: 'image/*', multi: true, opts: [
      { id: 'size', label: 'Page size', type: 'select', options: [
        ['fit', 'Fit to image'],
        ['a4', 'A4 portrait'],
        ['a4l', 'A4 landscape'],
        ['letter', 'Letter']
      ]}
    ],
    async run(files, o) {
      const d = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status(`Adding image ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 90);
        const img = /jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name)
          ? await d.embedJpg(await f.arrayBuffer())
          : await d.embedPng(/png$/i.test(f.type) || /\.png$/i.test(f.name) ? await f.arrayBuffer() : await toPngBytes(f));
        if (o.size === 'fit') {
          d.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } else {
          const sizes = { a4: [595, 842], a4l: [842, 595], letter: [612, 792] };
          const [pw, ph] = sizes[o.size] || [595, 842];
          const k = Math.min((pw - 40) / img.width, (ph - 40) / img.height);
          const w = img.width * k, h = img.height * k;
          d.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
      }
      setProgress(100);
      return [{ name: 'images.pdf', blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'pdf2img', cat: 'Images', icon: '⧉', name: 'PDF to images',
    desc: 'Export each PDF page as a high-quality JPG or PNG.',
    accept: '.pdf', multi: false, opts: [
      { id: 'type', label: 'Format', type: 'select', options: [
        ['image/jpeg', 'JPG'],
        ['image/png', 'PNG']
      ]},
      { id: 'scale', label: 'Quality / scale', type: 'select', options: [
        ['1.5', 'Standard'],
        ['2.5', 'High'],
        ['3.5', 'Very high'],
        ['4.5', 'Print quality']
      ], value: '2.5' }
    ],
    async run([f], o) {
      const pdf = await openPdfJs(f);
      const ext = o.type === 'image/png' ? 'png' : 'jpg';
      const r = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        status(`Rendering page ${i} of ${pdf.numPages}`);
        setProgress((i / pdf.numPages) * 95);
        r.push({ name: `${base(f)}-${i}.${ext}`, blob: await renderPage(pdf, i, +o.scale, o.type, 0.92) });
      }
      setProgress(100);
      return r;
    }
  },
  {
    id: 'imgconv', cat: 'Images', icon: '⇄', name: 'Convert images',
    desc: 'Convert between JPG, PNG and WebP. Batch supported.',
    accept: 'image/*', multi: true, opts: [
      { id: 'type', label: 'Convert to', type: 'select', options: [
        ['image/png', 'PNG'],
        ['image/jpeg', 'JPG'],
        ['image/webp', 'WebP']
      ]},
      { id: 'q', label: 'Quality for JPG/WebP (0.1 – 1)', type: 'number', value: 0.9 }
    ],
    async run(files, o) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[o.type];
      const r = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status(`Converting ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 95);
        const img = await loadImage(f);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext('2d');
        if (o.type === 'image/jpeg') {
          x.fillStyle = '#fff';
          x.fillRect(0, 0, c.width, c.height);
        }
        x.drawImage(img, 0, 0);
        const blob = await toBlob(c, o.type, +o.q);
        r.push({ name: `${base(f)}.${ext}`, blob, note: fmt(blob.size) });
      }
      setProgress(100);
      return r;
    }
  },
  {
    id: 'imgresize', cat: 'Images', icon: '⤡', name: 'Resize images',
    desc: 'Resize images by percentage or to a maximum width/height while keeping aspect ratio.',
    accept: 'image/*', multi: true, opts: [
      { id: 'mode', label: 'Mode', type: 'select', options: [
        ['pct', 'Percentage'],
        ['max', 'Max width or height']
      ]},
      { id: 'val', label: 'Value (e.g. 50 or 1200)', type: 'number', value: 50 },
      { id: 'type', label: 'Output format', type: 'select', options: [
        ['image/png', 'PNG'],
        ['image/jpeg', 'JPG'],
        ['image/webp', 'WebP']
      ], value: 'image/jpeg' },
      { id: 'q', label: 'Quality (JPG/WebP)', type: 'number', value: 0.88 }
    ],
    async run(files, o) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[o.type];
      const r = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status(`Resizing ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 95);
        const img = await loadImage(f);
        let w = img.width, h = img.height;
        if (o.mode === 'pct') {
          const p = Math.max(1, Math.min(500, +o.val || 50)) / 100;
          w = Math.round(w * p);
          h = Math.round(h * p);
        } else {
          const max = Math.max(16, +o.val || 1200);
          const k = Math.min(1, max / Math.max(w, h));
          w = Math.round(w * k);
          h = Math.round(h * k);
        }
        w = Math.max(1, w);
        h = Math.max(1, h);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        if (o.type === 'image/jpeg') {
          x.fillStyle = '#fff';
          x.fillRect(0, 0, w, h);
        }
        x.drawImage(img, 0, 0, w, h);
        const blob = await toBlob(c, o.type, +o.q);
        r.push({ name: `${base(f)}-${w}x${h}.${ext}`, blob, note: `${img.width}×${img.height} → ${w}×${h}` });
      }
      setProgress(100);
      return r;
    }
  },
  {
    id: 'imgcompress', cat: 'Images', icon: '📦', name: 'Compress images',
    desc: 'Reduce image file size with adjustable quality. Great for web or email.',
    accept: 'image/*', multi: true, opts: [
      { id: 'q', label: 'Quality (0.1 – 1)', type: 'number', value: 0.7 },
      { id: 'type', label: 'Output', type: 'select', options: [
        ['image/jpeg', 'JPG'],
        ['image/webp', 'WebP']
      ]}
    ],
    async run(files, o) {
      const ext = o.type === 'image/webp' ? 'webp' : 'jpg';
      const r = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status(`Compressing ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 95);
        const img = await loadImage(f);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0);
        const blob = await toBlob(c, o.type, +o.q);
        r.push({ name: `${base(f)}.${ext}`, blob, note: `${fmt(f.size)} → ${fmt(blob.size)}` });
      }
      setProgress(100);
      return r;
    }
  },

  /* ── Office / data ── */
  {
    id: 'xls2pdf', cat: 'Office', icon: '▦', name: 'Excel / CSV to PDF',
    desc: 'Convert .xlsx, .xls or .csv into a clean PDF table. One section per sheet.',
    accept: '.xlsx,.xls,.csv', multi: false, opts: [
      { id: 'orient', label: 'Orientation', type: 'select', options: [
        ['l', 'Landscape'],
        ['p', 'Portrait']
      ]}
    ],
    async run([f], o) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const doc = new jspdf.jsPDF({ orientation: o.orient, unit: 'pt', format: 'a4' });
      let first = true;
      wb.SheetNames.forEach(name => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        if (!rows.length) return;
        if (!first) doc.addPage();
        first = false;
        doc.setFontSize(12);
        doc.text(name, 40, 34);
        const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);
        const body = rows.map(r => Array.from({ length: cols }, (_, i) => String(r[i] ?? '')));
        doc.autoTable({
          head: [body[0]],
          body: body.slice(1),
          startY: 46,
          styles: { fontSize: cols > 10 ? 6 : 8, cellPadding: 3 },
          headStyles: { fillColor: [37, 99, 235] },
          margin: { left: 40, right: 40 }
        });
      });
      if (first) throw new Error('This file has no data.');
      return [{ name: `${base(f)}.pdf`, blob: doc.output('blob') }];
    }
  },
  {
    id: 'xls2csv', cat: 'Office', icon: '📄', name: 'Excel to CSV',
    desc: 'Export each sheet of an Excel workbook as a separate CSV file.',
    accept: '.xlsx,.xls', multi: false, opts: [],
    async run([f]) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const r = [];
      wb.SheetNames.forEach(name => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        r.push({ name: `${base(f)}-${name}.csv`, blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }) });
      });
      if (!r.length) throw new Error('No sheets found.');
      return r;
    }
  },
  {
    id: 'csv2xls', cat: 'Office', icon: '📊', name: 'CSV to Excel',
    desc: 'Convert one or more CSV files into a single .xlsx workbook (one sheet per file).',
    accept: '.csv', multi: true, opts: [],
    async run(files) {
      const wb = XLSX.utils.book_new();
      for (const f of files) {
        const csv = XLSX.read(await f.text(), { type: 'string', raw: true, FS: ',' });
        const ws = csv.Sheets[csv.SheetNames[0]];
        const sheetName = base(f).replace(/[\\/:?*\[\]]/g, '_').slice(0, 31).replace(/^'+|'+$/g, '') || 'Sheet';
        let uniqueName = sheetName;
        for (let i = 2; wb.SheetNames.some(name => name.toLowerCase() === uniqueName.toLowerCase()); i++) {
          const suffix = ` (${i})`;
          uniqueName = sheetName.slice(0, 31 - suffix.length) + suffix;
        }
        XLSX.utils.book_append_sheet(wb, ws, uniqueName);
      }
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return [{ name: 'converted.xlsx', blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) }];
    }
  },

  /* ── Utilities ── */
  {
    id: 'zip', cat: 'Utilities', icon: '🗜️', name: 'Zip files',
    desc: 'Pack any files into a single ZIP archive. Useful for bulk download or backup.',
    accept: '*/*', multi: true, min: 1, opts: [
      { id: 'name', label: 'Archive name', type: 'text', value: 'archive.zip' }
    ],
    async run(files, o) {
      const z = new JSZip();
      for (let i = 0; i < files.length; i++) {
        status(`Adding ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 90);
        addZipEntry(z, files[i].name, files[i]);
      }
      setProgress(100);
      const name = (o.name || 'archive.zip').replace(/\.zip$/i, '') + '.zip';
      return [{ name, blob: await z.generateAsync({ type: 'blob' }), note: `${files.length} files` }];
    }
  },
  {
    id: 'unzip', cat: 'Utilities', icon: '📂', name: 'Unzip',
    desc: 'Extract all files from a ZIP archive. Downloads come as individual files or a new ZIP.',
    accept: '.zip', multi: false, opts: [],
    async run([f]) {
      const z = await JSZip.loadAsync(await f.arrayBuffer());
      const r = [];
      const entries = Object.keys(z.files).filter(n => !z.files[n].dir);
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i];
        status(`Extracting ${i + 1}/${entries.length}`);
        setProgress((i / entries.length) * 95);
        const blob = await z.files[name].async('blob');
        r.push({ name: name.split('/').pop() || name, archivePath: name, blob });
      }
      setProgress(100);
      if (!r.length) throw new Error('ZIP is empty or contains only folders.');
      return r;
    }
  },
  {
    id: 'hash', cat: 'Utilities', icon: '🔑', name: 'File checksum',
    desc: 'Compute SHA-256 (and SHA-1) hashes of any file for integrity checks.',
    accept: '*/*', multi: true, opts: [],
    async run(files) {
      const lines = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status(`Hashing ${i + 1}/${files.length}`);
        setProgress((i / files.length) * 90);
        const buf = await f.arrayBuffer();
        const sha256 = await crypto.subtle.digest('SHA-256', buf);
        const sha1 = await crypto.subtle.digest('SHA-1', buf);
        const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
        lines.push(`${f.name}`);
        lines.push(`  Size:   ${fmt(f.size)}`);
        lines.push(`  SHA-256: ${hex(sha256)}`);
        lines.push(`  SHA-1:   ${hex(sha1)}`);
        lines.push('');
      }
      setProgress(100);
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      return [{ name: 'checksums.txt', blob, note: `${files.length} file(s)` }];
    }
  }
];

/* ─────────────────────────────────────────────
   UI STATE & RENDERING
   ───────────────────────────────────────────── */
let tool = TOOLS[0];
let files = [];
let urls = [];
let thumbUrls = [];
let running = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function addZipEntry(zip, name, data) {
  const stem = base({ name });
  const extension = name.slice(stem.length);
  let uniqueName = name;
  for (let i = 2; Object.hasOwn(zip.files, uniqueName); i++) {
    uniqueName = `${stem} (${i})${extension}`;
  }
  zip.file(uniqueName, data);
}

function getCats() {
  const map = {};
  TOOLS.forEach(t => {
    if (!map[t.cat]) map[t.cat] = [];
    map[t.cat].push(t);
  });
  return map;
}

function renderNav(filter = '') {
  const q = filter.trim().toLowerCase();
  const cats = getCats();
  let html = '';
  for (const [cat, list] of Object.entries(cats)) {
    const filtered = q ? list.filter(t => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || t.id.includes(q)) : list;
    if (!filtered.length) continue;
    html += `<div class="cat-label">${cat}</div>`;
    html += filtered.map(t =>
      `<button type="button" data-id="${t.id}" class="${t.id === tool.id ? 'on' : ''}" title="${t.desc}">
        <i>${t.icon}</i>${t.name}
      </button>`
    ).join('');
  }
  $('#nav').innerHTML = html || '<p style="padding:12px;color:var(--mute);font-size:13px">No tools match.</p>';
}

function selectTool(id) {
  if (tool.id === 'viewer') pdfViewer.close();
  tool = TOOLS.find(t => t.id === id) || TOOLS.find(t => t.id === 'merge');
  $('#app').classList.toggle('viewing-pdf', tool.id === 'viewer');
  files = [];
  location.hash = tool.id;
  $('#title').textContent = tool.name;
  $('#desc').textContent = tool.desc;
  const inp = $('#file');
  inp.accept = tool.accept;
  inp.multiple = !!tool.multi;
  inp.value = '';
  $('#dropText').textContent = tool.multi ? 'Drop files here' : 'Drop a file here';
  $('#run').hidden = tool.id === 'viewer';
  $('#opts').innerHTML = tool.opts.map(o => {
    let field;
    if (o.type === 'select') {
      field = `<select id="o_${o.id}">${o.options.map(([v, l]) =>
        `<option value="${v}" ${v === (o.value ?? '') ? 'selected' : ''}>${l}</option>`
      ).join('')}</select>`;
    } else if (o.type === 'textarea') {
      field = `<textarea id="o_${o.id}" rows="3">${o.value ?? ''}</textarea>`;
    } else {
      field = `<input id="o_${o.id}" type="${o.type}" value="${o.value ?? ''}" ${o.type === 'number' ? 'step="any"' : ''}>`;
    }
    return `<label>${o.label}${field}${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</label>`;
  }).join('');
  clearOut();
  status('');
  setProgress(null);
  renderNav($('#toolSearch').value);
  renderList();
  // close mobile menu
  $('#side').classList.remove('open');
  const ov = document.querySelector('.overlay');
  if (ov) ov.classList.remove('show');
}

function renderList() {
  // revoke old thumbs
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];

  $('#list').innerHTML = files.map((f, i) => {
    let thumb = '';
    if (isImage(f)) {
      const u = URL.createObjectURL(f);
      thumbUrls.push(u);
      thumb = `<img class="thumb" src="${u}" alt="">`;
    } else if (isPdf(f)) {
      thumb = `<span class="thumb" style="display:grid;place-items:center;font-size:18px">📄</span>`;
    } else {
      thumb = `<span class="thumb" style="display:grid;place-items:center;font-size:16px">📎</span>`;
    }
    return `<li>
      ${thumb}
      <span class="n" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="s">${fmt(f.size)}</span>
      ${tool.multi && files.length > 1 ? `
        <button type="button" data-a="up" data-i="${i}" aria-label="Move up">↑</button>
        <button type="button" data-a="down" data-i="${i}" aria-label="Move down">↓</button>
      ` : ''}
      <button type="button" data-a="del" data-i="${i}" aria-label="Remove">✕</button>
    </li>`;
  }).join('');

  const min = tool.min || 1;
  $('#run').disabled = running || files.length < min;
  $('#clear').disabled = !files.length;
  $('#run').textContent = files.length >= min ? (tool.actionLabel || `Run · ${tool.name}`) : `Need ${min}+ file${min > 1 ? 's' : ''}`;
}

function clearOut() {
  resultPreview.close();
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  $('#out').innerHTML = '';
}

function addFiles(list) {
  if (running) return;
  const accept = tool.accept;
  const ok = [...list].filter(f => {
    if (accept === 'image/*') return isImage(f);
    if (accept === '.pdf') return isPdf(f);
    if (accept === '*/*') return true;
    if (accept.startsWith('.')) {
      const exts = accept.split(',').map(s => s.trim().toLowerCase());
      return exts.some(ext => f.name.toLowerCase().endsWith(ext) || (ext === '.csv' && f.type.includes('csv')));
    }
    return true;
  });
  if (ok.length < list.length) status('Some files were skipped (wrong type for this tool).', 'err');
  else status('');
  if (!ok.length) return;
  files = tool.multi ? files.concat(ok) : ok.slice(0, 1);
  clearOut();
  setProgress(null);
  renderList();
  if (tool.id === 'viewer') pdfViewer.open(files[0]);
}

function resultRow({ name, blob, note }) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  const row = document.createElement('article');
  row.className = 'result-row';
  row.innerHTML = `
    <div class="result-details">
      <strong>${escapeHtml(name)}</strong>
      <span>${escapeHtml(note || fmt(blob.size))}</span>
    </div>
    <div class="result-actions">
      <button type="button" class="ghost">View</button>
      <a class="result-download" href="${u}" download="${escapeHtml(name)}">Download</a>
    </div>`;
  row.querySelector('button').addEventListener('click', () => resultPreview.open({ name, blob, url: u }));
  return row;
}

async function run() {
  if (tool.id === 'viewer') return;
  if (running || files.length < (tool.min || 1)) return;
  const o = {};
  tool.opts.forEach(x => {
    const el = $('#o_' + x.id);
    o[x.id] = el ? el.value : (x.value ?? '');
  });
  running = true;
  for (const id of ['#nav', '#drop', '#list', '#opts', '#clear']) $(id).inert = true;
  $('#run').disabled = true;
  if (tool.id !== 'redact') clearOut();
  status('Working…');
  setProgress(5);
  try {
    const res = await tool.run(files, o);
    if (!res.length) {
      status('');
      setProgress(null);
      return;
    }
    if (res.length > 1) {
      const z = new JSZip();
      res.forEach(r => addZipEntry(z, r.archivePath || r.name, r.blob));
      const bundle = await z.generateAsync({ type: 'blob' });
      res.unshift({ name: 'all-files.zip', blob: bundle, note: `${res.length} files` });
    }
    if (tool.id === 'redact') clearOut();
    $('#out').replaceChildren(...res.map(resultRow));
    status('Done. View or download your results.', 'ok');
    setProgress(100);
  } catch (e) {
    console.error(e);
    status('Could not process: ' + (e?.message || 'file may be damaged or password-protected.'), 'err');
    setProgress(null);
  } finally {
    running = false;
    for (const id of ['#nav', '#drop', '#list', '#opts', '#clear']) $(id).inert = false;
    renderList();
  }
}

/* ─────────────────────────────────────────────
   EVENTS
   ───────────────────────────────────────────── */
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]');
  if (b) selectTool(b.dataset.id);
});

$('#file').addEventListener('change', e => {
  addFiles(e.target.files);
  e.target.value = '';
});

$('#run').addEventListener('click', run);
$('#clear').addEventListener('click', () => {
  if (tool.id === 'viewer') pdfViewer.close();
  files = [];
  clearOut();
  status('');
  setProgress(null);
  renderList();
});

$('#list').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +b.dataset.i;
  const a = b.dataset.a;
  if (a === 'del') {
    files.splice(i, 1);
    if (tool.id === 'viewer') pdfViewer.close();
  }
  else {
    const j = a === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]];
  }
  clearOut();
  status('');
  renderList();
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault();
  drop.classList.remove('over');
}));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $('#file').click();
  }
});

$('#toolSearch').addEventListener('input', e => renderNav(e.target.value));

// Theme
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ppt-theme', t); } catch (_) {}
}
(function initTheme() {
  let t = 'light';
  try {
    t = localStorage.getItem('ppt-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (_) {}
  applyTheme(t);
})();
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// Mobile menu
$('#menuBtn').addEventListener('click', () => {
  const side = $('#side');
  side.classList.toggle('open');
  let ov = document.querySelector('.overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'overlay';
    document.body.appendChild(ov);
    ov.addEventListener('click', () => {
      side.classList.remove('open');
      ov.classList.remove('show');
    });
  }
  ov.classList.toggle('show', side.classList.contains('open'));
});
