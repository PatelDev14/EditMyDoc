/* Text redaction uses PDF.js text positions and exports newly rasterized pages. */
const appliedRedactionDrafts = new WeakMap();

function findRedactionRanges(text, terms, scope) {
  const alternatives = [...terms].sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const words = '[\\p{L}\\p{M}\\p{N}_]';
  const pattern = new RegExp(`(?<!${words})(?:${alternatives.join('|')})(?!${words})`, 'giu');
  const matches = Array.from(text.matchAll(pattern), match => ({
    start: match.index, end: match.index + match[0].length
  }));
  if (scope !== 'sentence' || !matches.length) return matches;

  const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const ranges = [];
  let matchIndex = 0;
  for (const { index, segment } of sentences.segment(text)) {
    const end = index + segment.length;
    while (matches[matchIndex]?.end <= index) matchIndex++;
    if (!matches[matchIndex]) break;
    if (matches[matchIndex].start < end) {
      ranges.push({ start: index, end: index + segment.trimEnd().length });
    }
  }
  return ranges;
}

async function findRedactionBoxes(page, viewport, terms, scope) {
  const content = await page.getTextContent();
  const runs = [];
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    runs.push({ item, start: text.length, end: text.length + item.str.length });
    text += item.str;
    if (item.hasEOL) text += ' ';
  }
  const ranges = findRedactionRanges(text, terms, scope);
  if (!ranges.length) return [];

  const layer = document.createElement('div');
  layer.className = 'redaction-text-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.setProperty('--scale-factor', viewport.scale);
  document.body.append(layer);
  try {
    const spans = [];
    await pdfjsLib.renderTextLayer({ textContentSource: content, container: layer, viewport, textDivs: spans }).promise;
    const origin = layer.getBoundingClientRect();
    const selection = document.createRange();
    const boxes = [];
    let rangeIndex = 0;
    for (const [index, { item, start, end }] of runs.entries()) {
      while (ranges[rangeIndex]?.end <= start) rangeIndex++;
      if (!ranges[rangeIndex]) break;
      if (!item.str.trim() || ranges[rangeIndex].start >= end) continue;
      const [a, b, c, d, , baseline] = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const node = spans[index]?.firstChild;
      if (!node || Math.abs(b) > .01 || Math.abs(c) > .01 || a <= 0 || d >= 0 || item.dir === 'ttb') {
        throw new Error(`A match on page ${page.pageNumber} uses text this tool cannot safely locate.`);
      }
      for (let i = rangeIndex; ranges[i]?.start < end; i++) {
        const from = Math.max(0, ranges[i].start - start);
        const to = Math.min(item.str.length, ranges[i].end - start);
        if (!item.str.slice(from, to).trim()) continue;
        selection.setStart(node, from);
        selection.setEnd(node, to);
        const box = selection.getBoundingClientRect();
        if (!box.width || !box.height) throw new Error(`Could not locate a match on page ${page.pageNumber}.`);
        const left = Math.floor(box.left - origin.left - 2);
        const right = Math.ceil(box.right - origin.left + 2);
        const height = Math.abs(d);
        const top = Math.floor(Math.min(box.top - origin.top, baseline - height) - 1);
        const bottom = Math.ceil(Math.max(box.bottom - origin.top, baseline + height * .3) + 1);
        boxes.push({
          x: Math.max(0, left / viewport.width),
          y: Math.max(0, top / viewport.height),
          right: Math.min(1, right / viewport.width),
          bottom: Math.min(1, bottom / viewport.height)
        });
      }
    }
    return boxes.filter(box => box.right > box.x && box.bottom > box.y);
  } finally {
    layer.remove();
  }
}

TOOLS.push({
  id: 'redact', cat: 'Acrobat', icon: '█', name: 'Redact text',
  desc: 'Draw boxes on a PDF or start with matches in selectable text. Review every page before applying redactions.',
  actionLabel: 'Review redactions',
  accept: '.pdf', multi: false, opts: [
    { id: 'scope', label: 'Redact', type: 'select', options: [
      ['match', 'Matching word or phrase'],
      ['sentence', 'Entire sentence containing a match']
    ] },
    { id: 'terms', label: 'Words or phrases (optional, comma-separated)', type: 'text', value: '' }
  ],
  async run([file], options) {
    const terms = [...new Set(options.terms.split(',').map(term => term.trim()).filter(Boolean))];
    const settings = JSON.stringify([options.scope, terms]);
    const lastApplied = appliedRedactionDrafts.get(file);
    const loadingTask = loadPdfJs(await file.arrayBuffer());
    try {
      const pdf = await loadingTask.promise;
      const reuseDraft = lastApplied?.settings === settings;
      const drafts = new Map(reuseDraft ? lastApplied.boxes : undefined);
      if (terms.length && !reuseDraft) {
        for (let number = 1; number <= pdf.numPages; number++) {
          status(`Finding matches on page ${number}/${pdf.numPages}`);
          setProgress(number / pdf.numPages * 95);
          const page = await pdf.getPage(number);
          const matches = await findRedactionBoxes(page, page.getViewport({ scale: 2 }), terms, options.scope);
          if (matches.length) drafts.set(number, matches);
        }
      }
      setProgress(null);
      const boxes = await reviewRedactions(pdf, drafts, Boolean(terms.length));
      if (!boxes) return [];
      const out = await PDFDocument.create();
      let hits = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        status(`Redacting page ${number}/${pdf.numPages}`);
        setProgress(number / pdf.numPages * 95);
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        ctx.fillStyle = 'black';
        for (const box of boxes.get(number) || []) {
          const left = Math.floor(box.x * viewport.width);
          const top = Math.floor(box.y * viewport.height);
          const right = Math.ceil(box.right * viewport.width);
          const bottom = Math.ceil(box.bottom * viewport.height);
          ctx.fillRect(left, top, right - left, bottom - top);
          hits++;
        }
        const image = await out.embedPng(await (await toBlob(canvas, 'image/png')).arrayBuffer());
        const width = viewport.width / 2;
        const height = viewport.height / 2;
        out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      }
      const blob = pdfBlob(await savePdf(out));
      appliedRedactionDrafts.set(file, { settings, boxes });
      return [{ name: `${base(file)}-redacted.pdf`, blob, note: `${hits} redaction box(es) applied` }];
    } finally {
      await loadingTask.destroy();
    }
  }
});
