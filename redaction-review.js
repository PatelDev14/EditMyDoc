/* Review draft boxes in page-relative coordinates before changing any pixels. */
function reviewRedactions(pdf, drafts, searched) {
  const dialog = $('#redactionReview');
  const content = $('#redactionReviewContent');
  const surface = $('#redactionSurface');
  const message = $('#redactionReviewStatus');
  const apply = $('#redactionApply');
  const remove = $('#redactionRemove');
  const undo = $('#redactionUndo');
  const redo = $('#redactionRedo');
  const previous = $('#redactionPrevious');
  const next = $('#redactionNext');
  const events = new AbortController();
  const history = [];
  const future = [];
  let pageNumber = 1;
  let selected = -1;
  let pageBusy = false;
  let pageError = '';
  let pageRender;
  let overlay;
  let gesture;

  const listen = (element, event, fn) => element.addEventListener(event, fn, { signal: events.signal });
  const pageBoxes = () => drafts.get(pageNumber) || [];
  const boxCount = () => [...drafts.values()].reduce((total, boxes) => total + boxes.length, 0);

  function updateControls() {
    const count = boxCount();
    $('#redactionPage').textContent = `${pageNumber} / ${pdf.numPages}`;
    previous.disabled = pageBusy || pageNumber === 1;
    next.disabled = pageBusy || pageNumber === pdf.numPages;
    apply.disabled = pageBusy || !count || Boolean(gesture);
    remove.disabled = pageBusy || selected < 0 || Boolean(gesture);
    undo.disabled = pageBusy || !history.length || Boolean(gesture);
    redo.disabled = pageBusy || !future.length || Boolean(gesture);
    message.textContent = pageError || (pageBusy ? 'Rendering page…'
      : !count && searched ? 'No boxes marked. Draw a box to redact manually.'
      : `${pageBoxes().length} on this page · ${count} total`);
  }

  function place(element, box) {
    element.style.left = box.x * 100 + '%';
    element.style.top = box.y * 100 + '%';
    element.style.width = (box.right - box.x) * 100 + '%';
    element.style.height = (box.bottom - box.y) * 100 + '%';
  }

  function select(index) {
    selected = index;
    overlay?.querySelectorAll('button').forEach((button, position) => {
      button.setAttribute('aria-pressed', String(position === selected));
      const handle = button.querySelector('.redaction-corner');
      handle.hidden = position !== selected;
    });
    updateControls();
  }

  function paintBoxes() {
    if (overlay) {
      const buttons = pageBoxes().map((box, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'redaction-box';
        button.dataset.box = index;
        button.setAttribute('aria-label', `Redaction box ${index + 1}`);
        const handle = document.createElement('span');
        handle.className = 'redaction-corner';
        handle.setAttribute('aria-hidden', 'true');
        button.append(handle);
        place(button, box);
        return button;
      });
      overlay.replaceChildren(...buttons);
    }
    select(selected);
  }

  function setBoxes(number, boxes) {
    if (boxes.length) drafts.set(number, boxes);
    else drafts.delete(number);
  }

  function record(boxes, selection) {
    history.push({ number: pageNumber, before: pageBoxes(), after: boxes });
    future.length = 0;
    setBoxes(pageNumber, boxes);
    selected = selection;
    paintBoxes();
  }

  function step(from, to, key) {
    if (pageBusy || gesture || !from.length) return;
    const edit = from.pop();
    to.push(edit);
    setBoxes(edit.number, edit[key]);
    selected = -1;
    if (edit.number === pageNumber) paintBoxes();
    else void showPage(edit.number);
  }

  function removeSelected() {
    if (pageBusy || gesture || selected < 0) return;
    record(pageBoxes().filter((_, index) => index !== selected), -1);
  }

  async function showPage(number) {
    if (pageBusy || gesture || number < 1 || number > pdf.numPages) return;
    pageNumber = number;
    selected = -1;
    pageError = '';
    pageBusy = true;
    overlay = undefined;
    surface.replaceChildren();
    updateControls();
    try {
      const page = await pdf.getPage(number);
      if (events.signal.aborted) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, Math.max(1, content.clientWidth - 24) / original.width,
        Math.max(1, content.clientHeight - 24) / original.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      pageRender = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await pageRender.promise;
      if (events.signal.aborted) return;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`);
      overlay = document.createElement('div');
      overlay.className = 'redaction-overlay';
      surface.style.width = viewport.width + 'px';
      surface.append(canvas, overlay);
      content.scrollTo(0, 0);
      paintBoxes();
    } catch (error) {
      if (!events.signal.aborted) pageError = 'Could not display page: ' + error.message;
    } finally {
      if (!events.signal.aborted) {
        pageRender = undefined;
        pageBusy = false;
        updateControls();
      }
    }
  }

  function point(event) {
    const bounds = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    };
  }

  function updateGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const { start, original, mode, element } = gesture;
    const end = point(event);
    let box;
    if (mode === 'move') {
      const dx = Math.max(-original.x, Math.min(1 - original.right, end.x - start.x));
      const dy = Math.max(-original.y, Math.min(1 - original.bottom, end.y - start.y));
      box = { x: original.x + dx, y: original.y + dy, right: original.right + dx, bottom: original.bottom + dy };
    } else if (mode === 'resize') {
      const minX = Math.min(.005, 1 - original.x);
      const minY = Math.min(.005, 1 - original.y);
      box = { ...original, right: Math.max(original.x + minX, original.right + end.x - start.x),
        bottom: Math.max(original.y + minY, original.bottom + end.y - start.y) };
      box.right = Math.min(1, box.right);
      box.bottom = Math.min(1, box.bottom);
    } else {
      box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
        right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
    }
    gesture.box = box;
    place(element, box);
  }

  listen(surface, 'pointerdown', event => {
    if (!overlay || gesture || event.button !== 0 || !overlay.contains(event.target)) return;
    event.preventDefault();
    const button = event.target.closest('[data-box]');
    const index = button ? Number(button.dataset.box) : -1;
    const element = button || document.createElement('div');
    const mode = !button ? 'draw' : event.target.classList.contains('redaction-corner') ? 'resize' : 'move';
    if (!button) {
      element.className = 'redaction-box redaction-drawing';
      overlay.append(element);
    } else {
      button.focus({ preventScroll: true });
    }
    gesture = { pointer: event.pointerId, start: point(event), original: pageBoxes()[index], element, index, mode };
    select(index);
    overlay.setPointerCapture(event.pointerId);
    updateGesture(event);
  });

  listen(surface, 'pointermove', updateGesture);
  function endGesture(event, commit) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (commit) updateGesture(event);
    const { mode, index, box, original } = gesture;
    gesture = undefined;
    const bounds = overlay.getBoundingClientRect();
    const isLargeEnough = box && Math.min((box.right - box.x) * bounds.width, (box.bottom - box.y) * bounds.height) >= 3;
    const changed = box && (!original || Object.keys(box).some(key => Math.abs(box[key] - original[key]) > .0005));
    if (!commit || !changed || (mode === 'draw' && !isLargeEnough)) {
      paintBoxes();
      return;
    }
    const boxes = [...pageBoxes()];
    if (mode === 'draw') boxes.push(box);
    else boxes[index] = box;
    record(boxes, mode === 'draw' ? boxes.length - 1 : index);
  }
  listen(surface, 'pointerup', event => endGesture(event, true));
  listen(surface, 'pointercancel', event => endGesture(event, false));
  listen(surface, 'lostpointercapture', event => endGesture(event, false));
  listen(surface, 'click', event => {
    const button = event.target.closest('[data-box]');
    if (button && !event.detail) select(Number(button.dataset.box));
  });

  listen(previous, 'click', () => void showPage(pageNumber - 1));
  listen(next, 'click', () => void showPage(pageNumber + 1));
  listen(remove, 'click', removeSelected);
  listen(undo, 'click', () => step(history, future, 'before'));
  listen(redo, 'click', () => step(future, history, 'after'));
  listen(document, 'keydown', event => {
    if (!dialog.open) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) step(future, history, 'after');
      else step(history, future, 'before');
    } else if (event.key === 'Delete' && selected >= 0) {
      event.preventDefault();
      removeSelected();
    } else {
      const step = pdfPageKeyStep(event);
      if (!step) return;
      event.preventDefault();
      void showPage(pageNumber + step);
    }
  });

  return new Promise(resolve => {
    function finish(result) {
      events.abort();
      pageRender?.cancel();
      if (dialog.open) dialog.close();
      surface.replaceChildren();
      resolve(result);
    }
    listen($('#redactionCancel'), 'click', () => finish(null));
    listen(dialog, 'cancel', event => { event.preventDefault(); finish(null); });
    listen(apply, 'click', () => {
      if (!apply.disabled) finish(drafts);
    });
    dialog.showModal();
    content.focus({ preventScroll: true });
    void showPage(1);
  });
}
