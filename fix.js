/* Reliability layer. Load last (after app.js, acrobat.js, pro.js). */

// Ensure loadPdf never uses ignoreEncryption (already fixed in app.js; re-assert here)
loadPdf = async function (f) {
  const buf = await f.arrayBuffer();
  try {
    return await PDFDocument.load(buf, { updateMetadata: false });
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/encrypt|password/i.test(msg))
      throw new Error(`"${f.name}" is password-protected or permission-locked. Use the Unlock tool first.`);
    throw new Error(`"${f.name}" could not be read: ${msg || 'damaged or unsupported file'}`);
  }
};

// Ensure savePdf exists and is strict (in case an older app.js is cached)
if (typeof savePdf !== 'function') {
  savePdf = async function (doc) {
    const bytes = await doc.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false
    });
    try {
      const check = await PDFDocument.load(bytes);
      if (check.getPageCount() !== doc.getPageCount())
        throw new Error('page count mismatch');
    } catch (e) {
      throw new Error('Output failed integrity check (' + (e.message || 'corrupt') + '). No file was produced.');
    }
    return bytes;
  };
}

if (typeof clonePdf !== 'function') {
  clonePdf = async function (src) {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, src.getPageIndices());
    pages.forEach(p => d.addPage(p));
    return d;
  };
}

// Unlock tool — re-renders pages as images so encryption is truly gone
if (!TOOLS.some(t => t.id === 'unlock')) {
  TOOLS.push({
    id: 'unlock', cat: 'Acrobat', icon: '🔓', name: 'Unlock PDF',
    desc: 'Remove password / permission locks from a PDF you own. Pages are re-rendered as images (text not selectable).',
    accept: '.pdf', multi: false, opts: [
      { id: 'pw', label: 'Password (leave blank if none)', type: 'text', value: '' }
    ],
    async run([f], o) {
      let pdf;
      try {
        pdf = await openPdfJs(f, o.pw || undefined);
      } catch (e) {
        if (e && e.name === 'PasswordException')
          throw new Error(o.pw ? 'Wrong password.' : 'This PDF needs a password to open.');
        throw e;
      }
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        status(`Page ${i}/${pdf.numPages}`); setProgress((i / pdf.numPages) * 95);
        const p = await pdf.getPage(i), vp = p.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: x, viewport: vp }).promise;
        const jpg = await out.embedJpg(await (await toBlob(c, 'image/jpeg', .9)).arrayBuffer());
        out.addPage([vp.width / 2, vp.height / 2]).drawImage(jpg, {
          x: 0, y: 0, width: vp.width / 2, height: vp.height / 2
        });
      }
      setProgress(100);
      return [{ name: `${base(f)}-unlocked.pdf`, blob: pdfBlob(await savePdf(out)), note: `${pdf.numPages} pages` }];
    }
  });
}

// Select the initial tool only after all add-ons have registered their tools.
selectTool(location.hash.slice(1) || 'merge');
