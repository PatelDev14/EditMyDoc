/* Acrobat-style add-on tools. Load AFTER app.js. All processing stays local. */
const COLS = { black: rgb(0, 0, 0), red: rgb(.8, .1, .1), blue: rgb(.1, .3, .75), gray: rgb(.4, .4, .4) };
const POS = [['bc', 'Bottom center'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['mc', 'Middle'], ['tc', 'Top center'], ['tr', 'Top right'], ['tl', 'Top left']];
const place = (pos, w, h, bw, bh, m = 30) => ({
  x: pos[1] === 'c' ? (w - bw) / 2 : pos[1] === 'r' ? w - bw - m : m,
  y: pos[0] === 'b' ? m : pos[0] === 't' ? h - bh - m : (h - bh) / 2
});

TOOLS.push(
  {
    id: 'reorder', cat: 'Acrobat', icon: '⇅', name: 'Reorder pages',
    desc: 'Type the new page order (e.g. 3,1,2,4-6) or reverse the whole document. Pages you leave out are dropped.',
    accept: '.pdf', multi: false, opts: [
      { id: 'mode', label: 'Mode', type: 'select', options: [['custom', 'Custom order'], ['reverse', 'Reverse all pages']] },
      { id: 'order', label: 'Order', type: 'text', value: '2,1', hint: 'Ignored when reversing' }
    ],
    async run([f], o) {
      const src = await loadPdf(f), n = src.getPageCount();
      const idx = o.mode === 'reverse' ? src.getPageIndices().reverse() : parseRanges(o.order, n);
      if (!idx.length) throw new Error('No valid pages in order.');
      const d = await PDFDocument.create();
      (await d.copyPages(src, idx)).forEach(p => d.addPage(p));
      return [{ name: `${base(f)}-reordered.pdf`, blob: pdfBlob(await savePdf(d)), note: `${idx.length} pages` }];
    }
  },
  {
    id: 'crop', cat: 'Acrobat', icon: '⛶', name: 'Crop pages',
    desc: 'Trim margins (in points, 72 = 1 inch) from every page or selected pages.',
    accept: '.pdf', multi: false, opts: [
      { id: 't', label: 'Top', type: 'number', value: 20 }, { id: 'r', label: 'Right', type: 'number', value: 20 },
      { id: 'b', label: 'Bottom', type: 'number', value: 20 }, { id: 'l', label: 'Left', type: 'number', value: 20 },
      { id: 'pages', label: 'Pages (blank = all)', type: 'text', value: '' }
    ],
    async run([f], o) {
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      const n = d.getPageCount();
      const idx = o.pages.trim() ? parseRanges(o.pages, n) : d.getPageIndices();
      if (!idx.length) throw new Error('No valid pages selected.');
      const [t, r, b, l] = [o.t, o.r, o.b, o.l].map(v => Math.max(0, +v || 0));
      idx.forEach(i => {
        const p = d.getPage(i), { x, y, width: w, height: h } = p.getCropBox();
        if (w - l - r < 20 || h - t - b < 20) throw new Error('Margins are larger than the page.');
        p.setCropBox(x + l, y + b, w - l - r, h - t - b);
      });
      return [{ name: `${base(f)}-cropped.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'addtext', cat: 'Acrobat', icon: 'T', name: 'Add text',
    desc: 'Stamp custom text (notes, dates, labels) onto pages.',
    accept: '.pdf', multi: false, opts: [
      { id: 'text', label: 'Text', type: 'text', value: 'Approved' },
      { id: 'pos', label: 'Position', type: 'select', options: POS },
      { id: 'size', label: 'Font size', type: 'number', value: 16 },
      { id: 'color', label: 'Color', type: 'select', options: [['black', 'Black'], ['red', 'Red'], ['blue', 'Blue'], ['gray', 'Gray']] },
      { id: 'pages', label: 'Pages (blank = all)', type: 'text', value: '' }
    ],
    async run([f], o) {
      if (!o.text) throw new Error('Enter some text.');
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      const font = await d.embedFont(StandardFonts.Helvetica);
      const idx = o.pages.trim() ? parseRanges(o.pages, d.getPageCount()) : d.getPageIndices();
      if (!idx.length) throw new Error('No valid pages selected.');
      const size = Math.max(4, +o.size || 16), tw = font.widthOfTextAtSize(o.text, size);
      idx.forEach(i => {
        const p = d.getPage(i), { width: w, height: h } = p.getSize();
        p.drawText(o.text, { ...place(o.pos, w, h, tw, size), size, font, color: COLS[o.color] });
      });
      return [{ name: `${base(f)}-text.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'sign', cat: 'Acrobat', icon: '✍', name: 'Sign / add image',
    desc: 'Select one PDF and one image (PNG signature, logo or stamp). The image is placed on the chosen page.',
    accept: '*/*', multi: true, min: 2, opts: [
      { id: 'page', label: 'Page (0 = last)', type: 'number', value: 0 },
      { id: 'pos', label: 'Position', type: 'select', options: POS, value: 'br' },
      { id: 'wd', label: 'Image width (pt)', type: 'number', value: 140 }
    ],
    async run(fs, o) {
      const pdf = fs.find(isPdf), im = fs.find(isImage);
      if (!pdf || !im) throw new Error('Choose one PDF and one image.');
      const src = await loadPdf(pdf);
      const d = await clonePdf(src);
      const n = d.getPageCount();
      const raw = new Uint8Array(await im.arrayBuffer());
      const isJ = /jpe?g/i.test(im.type) || /\.jpe?g$/i.test(im.name);
      const isP = /png/i.test(im.type) || /\.png$/i.test(im.name);
      const img = isJ ? await d.embedJpg(raw) : await d.embedPng(isP ? raw : await toPngBytes(im));
      const pageIdx = Math.min(n, Math.max(1, +o.page || n)) - 1;
      const p = d.getPage(pageIdx), { width: w, height: h } = p.getSize();
      const bw = Math.max(10, +o.wd || 140), bh = bw * img.height / img.width;
      p.drawImage(img, { ...place(o.pos, w, h, bw, bh), width: bw, height: bh });
      return [{ name: `${base(pdf)}-signed.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'flatten', cat: 'Acrobat', icon: '▤', name: 'Flatten forms',
    desc: 'Lock fillable form fields into the page so they can no longer be edited.',
    accept: '.pdf', multi: false, opts: [],
    async run([f]) {
      const d = await loadPdf(f);
      const form = d.getForm();
      if (!form.getFields().length) throw new Error('This PDF has no fillable fields.');
      form.flatten();
      return [{ name: `${base(f)}-flattened.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'sanitize', cat: 'Acrobat', icon: '🧹', name: 'Remove metadata',
    desc: 'Strip title, author, subject, keywords and creator info before sharing.',
    accept: '.pdf', multi: false, opts: [],
    async run([f]) {
      const src = await loadPdf(f);
      const d = await clonePdf(src);
      d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]);
      d.setCreator(''); d.setProducer('Private PDF Toolbox');
      return [{ name: `${base(f)}-clean.pdf`, blob: pdfBlob(await savePdf(d)) }];
    }
  },
  {
    id: 'grayscale', cat: 'Acrobat', icon: '◐', name: 'Grayscale PDF',
    desc: 'Convert pages to black & white for printing. Pages become images (text not selectable).',
    accept: '.pdf', multi: false, opts: [],
    async run([f]) {
      const pdf = await openPdfJs(f), out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        status(`Page ${i}/${pdf.numPages}`); setProgress((i / pdf.numPages) * 95);
        const p = await pdf.getPage(i), vp = p.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: x, viewport: vp }).promise;
        const im = x.getImageData(0, 0, c.width, c.height), a = im.data;
        for (let k = 0; k < a.length; k += 4) a[k] = a[k + 1] = a[k + 2] = .299 * a[k] + .587 * a[k + 1] + .114 * a[k + 2];
        x.putImageData(im, 0, 0);
        const jpg = await out.embedJpg(await (await toBlob(c, 'image/jpeg', .85)).arrayBuffer());
        out.addPage([vp.width / 2, vp.height / 2]).drawImage(jpg, { x: 0, y: 0, width: vp.width / 2, height: vp.height / 2 });
      }
      setProgress(100);
      return [{ name: `${base(f)}-gray.pdf`, blob: pdfBlob(await savePdf(out)) }];
    }
  }
);

