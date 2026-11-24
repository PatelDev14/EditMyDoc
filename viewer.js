/* Interactive PDF viewer. Loaded after app.js and before the initial tool is selected. */
TOOLS.unshift({
  id: 'viewer', cat: 'Workspace', icon: '▤', name: 'PDF Viewer',
  desc: 'Open a PDF to browse its pages, zoom in, and jump between thumbnails.',
  accept: '.pdf', multi: false, opts: []
});

const pdfViewer = (() => {
  const root = $('#viewer');
  const viewport = $('#viewerViewport');
  const thumbs = $('#viewerThumbs');
  const pageInput = $('#viewerPage');
  const zoom = $('#viewerZoom');
  const previous = $('#viewerPrevious');
  const next = $('#viewerNext');

  let loadingTask;
  let pdf;
  let pageNumber = 1;
  let documentVersion = 0;
  let renderVersion = 0;
  let pageRender;
  let displayedPage;
  let observer;
  const thumbnailRenders = new Set();

  function close() {
    documentVersion++;
    renderVersion++;
    observer?.disconnect();
    pageRender?.cancel();
    pageRender = undefined;
    thumbnailRenders.forEach(task => task.cancel());
    thumbnailRenders.clear();
    loadingTask?.destroy().catch(console.error);
    loadingTask = undefined;
    pdf = undefined;
    displayedPage = undefined;
    root.hidden = true;
    $('#app').classList.remove('pdf-open');
    viewport.removeAttribute('aria-busy');
    thumbs.replaceChildren();
    viewport.replaceChildren();
  }

  function render(page, scale, density) {
    const dimensions = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    // Bound canvas allocation for unusually large pages and high-DPI displays.
    const ratio = Math.min(density, 8192 / Math.max(dimensions.width, dimensions.height),
      Math.sqrt(12_000_000 / (dimensions.width * dimensions.height)));
    canvas.width = Math.max(1, Math.floor(dimensions.width * ratio));
    canvas.height = Math.max(1, Math.floor(dimensions.height * ratio));
    canvas.style.width = dimensions.width + 'px';
    canvas.style.height = dimensions.height + 'px';
    const task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: dimensions,
      transform: [ratio, 0, 0, ratio, 0, 0]
    });
    return { canvas, task };
  }

  async function renderThumbnail(button, pdfDocument, version) {
    let task;
    try {
      const page = await pdfDocument.getPage(Number(button.dataset.page));
      if (version !== documentVersion) return;
      const size = page.getViewport({ scale: 1 });
      const preview = render(page, Math.min(76 / size.width, 90 / size.height), 1.5);
      task = preview.task;
      thumbnailRenders.add(task);
      await task.promise;
      if (version !== documentVersion) return;
      preview.canvas.setAttribute('aria-hidden', 'true');
      button.prepend(preview.canvas);
    } catch (error) {
      if (version === documentVersion && error.name !== 'RenderingCancelledException') {
        console.warn('Could not render thumbnail', error);
      }
    } finally {
      if (task) thumbnailRenders.delete(task);
    }
  }

  function createThumbnails(pdfDocument, version) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || version !== documentVersion) continue;
        observer.unobserve(entry.target);
        void renderThumbnail(entry.target, pdfDocument, version);
      }
    }, { root: thumbs, rootMargin: '100px' });

    const buttons = document.createDocumentFragment();
    for (let number = 1; number <= pdfDocument.numPages; number++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.page = number;
      button.setAttribute('aria-label', 'Page ' + number);
      button.textContent = number;
      buttons.append(button);
      observer.observe(button);
    }
    thumbs.append(buttons);
  }

  async function renderCurrentPage() {
    if (!pdf) return;
    const version = ++renderVersion;
    pageRender?.cancel();
    pageRender = undefined;
    viewport.setAttribute('aria-busy', 'true');
    try {
      const page = await pdf.getPage(pageNumber);
      if (version !== renderVersion) return;
      const size = page.getViewport({ scale: 1 });
      const scale = zoom.value === 'fit' || zoom.value === 'page'
        ? fitScale(size)
        : Number(zoom.value) * 96 / 72;
      const { canvas, task } = render(page, scale, Math.min(devicePixelRatio || 1, 2));
      pageRender = task;
      await task.promise;
      if (version !== renderVersion) return;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Page ' + pageNumber + ' of ' + pdf.numPages);
      viewport.replaceChildren(canvas);
      if (displayedPage !== pageNumber) viewport.scrollTo(0, 0);
      displayedPage = pageNumber;
      status('');
    } catch (error) {
      if (version === renderVersion) {
        viewport.replaceChildren();
        status('Could not display this page: ' + error.message, 'err');
      }
    } finally {
      if (version === renderVersion) {
        pageRender = undefined;
        viewport.removeAttribute('aria-busy');
      }
    }
  }

  function fitScale(page) {
    const style = getComputedStyle(viewport);
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const widthScale = Math.max(1, viewport.clientWidth - horizontalPadding) / page.width;
    if (zoom.value === 'fit') return widthScale;
    const heightScale = Math.max(1, viewport.clientHeight - verticalPadding) / page.height;
    return Math.min(widthScale, heightScale);
  }

  function revealThumbnail(button) {
    const item = button.getBoundingClientRect();
    const rail = thumbs.getBoundingClientRect();
    thumbs.scrollBy(
      Math.min(0, item.left - rail.left) || Math.max(0, item.right - rail.right),
      Math.min(0, item.top - rail.top) || Math.max(0, item.bottom - rail.bottom)
    );
  }

  function goToPage(number) {
    if (!pdf) return;
    pageNumber = Math.max(1, Math.min(pdf.numPages, Math.trunc(number) || pageNumber));
    pageInput.value = pageNumber;
    previous.disabled = pageNumber === 1;
    next.disabled = pageNumber === pdf.numPages;
    thumbs.querySelector('[aria-current]')?.removeAttribute('aria-current');
    const selected = thumbs.querySelector('[data-page="' + pageNumber + '"]');
    selected.setAttribute('aria-current', 'page');
    revealThumbnail(selected);
    void renderCurrentPage();
  }

  async function open(file) {
    close();
    const version = documentVersion;
    status('Opening PDF…');
    try {
      const data = await file.arrayBuffer();
      if (version !== documentVersion) return;
      loadingTask = loadPdfJs(data);
      const loaded = await loadingTask.promise;
      if (version !== documentVersion) return;
      pdf = loaded;
      if (!pdf.numPages) throw new Error('This PDF has no pages.');
      pageInput.max = pdf.numPages;
      $('#viewerCount').textContent = '/ ' + pdf.numPages;
      zoom.value = 'page';
      $('#app').classList.add('pdf-open');
      $('#viewerFilename').textContent = file.name;
      root.hidden = false;
      createThumbnails(pdf, version);
      goToPage(1);
    } catch (error) {
      if (version !== documentVersion) return;
      close();
      status(error.name === 'PasswordException'
        ? 'This PDF is password-protected. Open a copy without a password.'
        : 'Could not open PDF: ' + error.message, 'err');
    }
  }

  previous.addEventListener('click', () => goToPage(pageNumber - 1));
  next.addEventListener('click', () => goToPage(pageNumber + 1));
  pageInput.addEventListener('change', () => goToPage(pageInput.valueAsNumber));
  zoom.addEventListener('change', renderCurrentPage);
  root.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  root.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  });
  thumbs.addEventListener('click', event => {
    const button = event.target.closest('button[data-page]');
    if (button) goToPage(Number(button.dataset.page));
  });
  viewport.addEventListener('mousedown', event => {
    if (event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
    // Let the document receive keyboard navigation without revealing its top edge.
    event.preventDefault();
    viewport.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (root.hidden || $('#resultPreview').open) return;
    const step = pdfPageKeyStep(event);
    if (!step) return;
    event.preventDefault();
    goToPage(pageNumber + step);
  });
  let availableWidth;
  let availableHeight;
  new ResizeObserver(() => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width === availableWidth && height === availableHeight) return;
    availableWidth = width;
    availableHeight = height;
    if (width && height && (zoom.value === 'fit' || zoom.value === 'page')) void renderCurrentPage();
  }).observe(viewport);

  return { open, close };
})();
