/* A local preview shared by the result cards. */
const resultPreview = (() => {
  const dialog = $('#resultPreview');
  const pane = $('#previewContent');
  const controls = $('#previewControls');
  const message = $('#previewStatus');
  const download = $('#previewDownload');
  let pdfTask;
  let handlePdfKeys;
  let version = 0;

  function reset() {
    version++;
    pdfTask?.destroy().catch(console.error);
    pdfTask = undefined;
    handlePdfKeys = undefined;
    pane.replaceChildren();
    controls.replaceChildren();
    controls.hidden = true;
    download.removeAttribute('href');
    download.removeAttribute('download');
    $('#previewTitle').textContent = '';
    message.textContent = '';
  }

  function close() {
    if (dialog.open) dialog.close();
    reset();
  }

  function label(text, tag = 'p') {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  async function showPdf(blob, current) {
    const data = await blob.arrayBuffer();
    if (current !== version) return;
    pdfTask = loadPdfJs(data);
    const pdf = await pdfTask.promise;
    if (current !== version) return;

    let pageNumber = 1;
    const previous = label('‹', 'button');
    const next = label('›', 'button');
    const counter = label('', 'span');
    previous.type = next.type = 'button';
    previous.title = 'Previous page';
    next.title = 'Next page';
    previous.setAttribute('aria-label', previous.title);
    next.setAttribute('aria-label', next.title);
    const pagination = document.createElement('div');
    pagination.className = 'viewer-pagination';
    pagination.setAttribute('role', 'group');
    pagination.setAttribute('aria-label', 'Page navigation');
    pagination.append(previous, counter, next);
    controls.append(pagination);
    controls.hidden = pdf.numPages < 2;

    async function drawPage() {
      previous.disabled = next.disabled = true;
      counter.textContent = `${pageNumber} / ${pdf.numPages}`;
      message.textContent = 'Rendering page…';
      try {
        const page = await pdf.getPage(pageNumber);
        if (current !== version) return;
        const size = page.getViewport({ scale: 1 });
        const width = Math.min(900, Math.max(200, pane.clientWidth - 32));
        const viewport = page.getViewport({ scale: Math.min(width / size.width, 2000 / size.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (current !== version) return;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${pageNumber} of ${pdf.numPages}`);
        pane.replaceChildren(canvas);
        pane.scrollTop = 0;
        message.textContent = '';
      } catch (error) {
        if (current !== version) return;
        pane.replaceChildren();
        message.textContent = 'Could not render page: ' + error.message;
      } finally {
        if (current === version) {
          previous.disabled = pageNumber <= 1;
          next.disabled = pageNumber >= pdf.numPages;
        }
      }
    }

    previous.addEventListener('click', () => { pageNumber--; void drawPage(); });
    next.addEventListener('click', () => { pageNumber++; void drawPage(); });
    if (pdf.numPages > 1) {
      handlePdfKeys = event => {
        const step = pdfPageKeyStep(event);
        if (!step) return;
        event.preventDefault();
        if (step < 0) previous.click();
        else next.click();
      };
    }
    await drawPage();
  }

  async function showWorkbook(blob, current) {
    const workbook = XLSX.read(await blob.arrayBuffer(), { sheetRows: 41 });
    if (current !== version) return;
    if (!workbook.SheetNames.length) throw new Error('No sheets found.');
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', 'Worksheet');
    for (const name of workbook.SheetNames) {
      const option = label(name, 'option');
      option.value = name;
      picker.append(option);
    }
    controls.replaceChildren(picker);
    controls.hidden = workbook.SheetNames.length < 2;

    function showSheet() {
      const sheet = workbook.Sheets[picker.value];
      const range = sheet['!ref'] && XLSX.utils.decode_range(sheet['!ref']);
      if (!range) {
        pane.replaceChildren(label('This sheet is empty.'));
        return;
      }
      const table = document.createElement('table');
      table.setAttribute('aria-label', picker.value);
      const body = table.createTBody();
      for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 39); row++) {
        const line = body.insertRow();
        for (let col = range.s.c; col <= Math.min(range.e.c, range.s.c + 19); col++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
          line.insertCell().textContent = cell?.w ?? cell?.v ?? '';
        }
      }
      pane.replaceChildren(label('Showing up to 40 rows and 20 columns.'), table);
    }

    picker.addEventListener('change', showSheet);
    showSheet();
  }

  async function open({ name, blob, url }) {
    reset();
    const current = version;
    $('#previewTitle').textContent = name;
    download.href = url;
    download.download = name;
    dialog.showModal();
    pane.focus({ preventScroll: true });
    message.textContent = 'Opening preview…';
    try {
      if (blob.type === 'application/pdf' || /\.pdf$/i.test(name)) {
        await showPdf(blob, current);
        return;
      }
      if (/^image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)$/i.test(blob.type) ||
          /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) {
        const image = new Image();
        image.alt = name;
        image.src = url;
        await image.decode();
        if (current !== version) return;
        pane.replaceChildren(image);
      } else if (/\.zip$/i.test(name) || blob.type === 'application/zip') {
        const archive = await JSZip.loadAsync(await blob.arrayBuffer());
        if (current !== version) return;
        const entries = Object.values(archive.files).filter(entry => !entry.dir);
        const list = document.createElement('ul');
        for (const entry of entries.slice(0, 200)) list.append(label(entry.name, 'li'));
        const count = entries.length > 200 ? `Showing 200 of ${entries.length} files.` : `${entries.length} files`;
        pane.replaceChildren(label(count), list);
      } else if (/\.xlsx?$/i.test(name)) {
        await showWorkbook(blob, current);
      } else if (blob.type.startsWith('text/') || /\.(txt|csv|tsv|json|md|log)$/i.test(name)) {
        const limit = 128 * 1024;
        const text = await blob.slice(0, limit).text();
        if (current !== version) return;
        pane.replaceChildren(label(text || 'This file is empty.', 'pre'));
        if (blob.size > limit) pane.append(label('Showing the first 128 KB. Download for the full file.'));
      } else {
        pane.replaceChildren(label('Preview is unavailable for this file type. You can still download it.'));
      }
      if (current === version) message.textContent = '';
    } catch (error) {
      if (current === version) message.textContent = 'Could not preview this file: ' + error.message;
    }
  }

  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  document.addEventListener('keydown', event => {
    if (dialog.open) handlePdfKeys?.(event);
  }, { capture: true });
  $('#previewClose').addEventListener('click', close);
  return { open, close };
})();
