/* Pro add-on. Load AFTER app.js and acrobat.js. Everything stays local. */

TOOLS.splice(TOOLS.findIndex(t => t.id === 'sign'), 1);

TOOLS.push(
  {
    id: 'sign', cat: 'Acrobat', icon: '✍', name: 'Sign / add image',
    desc: 'Select one PDF and one image (signature, logo, stamp). Place it on the last, first, all or chosen pages.',
    accept: '*/*', multi: true, min: 2, opts: [
      { id: 'mode', label: 'Pages', type: 'select', options: [['last', 'Last page'], ['first', 'First page'], ['all', 'All pages'], ['range', 'Page range…']] },
      { id: 'range', label: 'Range (if selected)', type: 'text', value: '1-2', hint: 'e.g. 1-3, 5' },
      { id: 'pos', label: 'Position', type: 'select', options: POS, value: 'br' },
      { id: 'wd', label: 'Image width (pt)', type: 'number', value: 140 },
      { id: 'op', label: 'Opacity (0.1 – 1)', type: 'number', value: 1 }
    ],
    async run(fs, o) {
      const pdf = fs.find(isPdf), im = fs.find(isImage);
      if (fs.length !== 2 || !pdf || !im || pdf === im) throw new Error('Choose exactly one PDF and one image.');
      const src = await loadPdf(pdf);
      const d = await clonePdf(src);
      const n = d.getPageCount();
      const raw = new Uint8Array(await im.arrayBuffer());
      const isJ = /jpe?g/i.test(im.type) || /\.jpe?g$/i.test(im.name);
      const isP = /png/i.test(im.type) || /\.png$/i.test(im.name);
      const img = isJ ? await d.embedJpg(raw) : await d.embedPng(isP ? raw : await toPngBytes(im));
      const idx = o.mode === 'first' ? [0]
        : o.mode === 'all' ? d.getPageIndices()
        : o.mode === 'range' ? parseRanges(o.range, n)
        : [n - 1];
      if (!idx.length) throw new Error(`No valid pages (document has ${n}).`);
      const bw = Math.max(10, +o.wd || 140), bh = bw * img.height / img.width;
      const opacity = Math.min(1, Math.max(0.1, +o.op || 1));
      idx.forEach(i => {
        const p = d.getPage(i);
        const { width: w, height: h } = p.getSize();
        const { x, y } = place(o.pos, w, h, bw, bh);
        p.drawImage(img, { x, y, width: bw, height: bh, opacity });
      });
      return [{ name: `${base(pdf)}-signed.pdf`, blob: pdfBlob(await savePdf(d)), note: `${idx.length} page(s)` }];
    }
  },
  {
    id: 'highlight', cat: 'Acrobat', icon: '🖍', name: 'Highlight text',
    desc: 'Highlight every text block containing your words. Text stays selectable and searchable.',
    accept: '.pdf', multi: false, opts: [
      { id: 'terms', label: 'Words / phrases (comma-separated)', type: 'text', value: '' }
    ],
    async run([f], o) {
      const terms = o.terms.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!terms.length) throw new Error('Enter at least one word.');
      const src = await loadPdf(f);
      const pj = await openPdfJs(f);
      const d = await clonePdf(src);
      let hits = 0;
      for (let i = 1; i <= pj.numPages; i++) {
        status(`Page ${i}/${pj.numPages}`); setProgress((i / pj.numPages) * 95);
        const page = d.getPage(i - 1);
        (await (await pj.getPage(i)).getTextContent()).items.forEach(it => {
          if (typeof it.str !== 'string' || !terms.some(t => it.str.toLowerCase().includes(t))) return;
          page.drawRectangle({
            x: it.transform[4],
            y: it.transform[5] - it.height * .2,
            width: it.width,
            height: it.height * 1.2,
            color: rgb(1, .9, 0),
            opacity: .4
          });
          hits++;
        });
      }
      if (!hits) throw new Error('No matches found.');
      setProgress(100);
      return [{ name: `${base(f)}-highlighted.pdf`, blob: pdfBlob(await savePdf(d)), note: `${hits} highlight(s)` }];
    }
  },
  {
    id: 'fillform', cat: 'Acrobat', icon: '☑', name: 'Fill form',
    desc: 'Fill fillable PDF forms. Leave the box empty first to get a list of the field names.',
    accept: '.pdf', multi: false, opts: [
      { id: 'vals', label: 'Values — one per line: fieldName=value', type: 'textarea', value: '', hint: 'Checkboxes: true / false' }
    ],
    async run([f], o) {
      const d = await loadPdf(f);
      const form = d.getForm(), fields = form.getFields();
      if (!fields.length) throw new Error('This PDF has no fillable fields.');
      if (!o.vals.trim()) {
        const t = fields.map(x => `${x.getName()}  (${x.constructor.name.replace('PDF', '')})`).join('\n');
        return [{ name: `${base(f)}-fields.txt`, blob: new Blob([t], { type: 'text/plain' }), note: `${fields.length} fields` }];
      }
      let set = 0; const miss = [];
      o.vals.split(/\r?\n/).forEach(line => {
        const k = line.indexOf('='); if (k < 1) return;
        const name = line.slice(0, k).trim(), v = line.slice(k + 1).trim();
        const fld = fields.find(x => x.getName() === name);
        if (!fld) return miss.push(name);
        try {
          if (fld.setText) fld.setText(v);
          else if (fld.check) /^(true|yes|1|on|x)$/i.test(v) ? fld.check() : fld.uncheck();
          else if (fld.select) fld.select(v);
          else return miss.push(name);
          set++;
        } catch (e) { miss.push(name); }
      });
      if (!set) throw new Error(miss.length ? `Could not set: ${miss.join(', ')}` : 'Enter at least one fieldName=value line.');
      form.updateFieldAppearances();
      const note = miss.length ? `${set} filled. Could not set: ${miss.join(', ')}` : `${set} filled`;
      return [{ name: `${base(f)}-filled.pdf`, blob: pdfBlob(await savePdf(d)), note }];
    }
  }
);
