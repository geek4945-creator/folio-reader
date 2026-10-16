// DOM helpers, toast, bottom sheets, dialogs.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let toastTimer;
export function toast(msg, ms = 2600, action = null) {
  const t = $('#toast');
  t.replaceChildren(document.createTextNode(msg)); t.classList.toggle('has-act', !!action); t.hidden = false;
  if (action) t.append(' ', h('button', { class: 'toast-act', id: 'toast-action', onclick: () => { t.hidden = true; clearTimeout(toastTimer); action.onClick(); } }, action.label));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function hashHue(s) {
  let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360;
}

export function fmtPct(p) { return Math.round((p || 0) * 100) + '%'; }

/* Open sheets, topmost last. Escape closes the topmost one (capture phase, so readers underneath don't also react). */
const sheetStack = [];
let escBound = false;
function bindEscape() {
  if (escBound) return; escBound = true;
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape' || !sheetStack.length) return; e.preventDefault(); e.stopPropagation(); sheetStack[sheetStack.length - 1].close(); }, true);
}
/** Show a bottom sheet. build(close) returns an element/array. Returns {close}.
 *  Every sheet has a ✕ at the top, a Done / Back button at the bottom (opts.closeLabel; opts.noFooter hides it for dialogs that carry their own buttons),
 *  closes on a tap outside (unless opts.noDim) and on Escape, keeps clear of the iOS notch / home indicator and scrolls inside when long. */
export function sheet(title, build, opts = {}) {
  const ov = $('#overlay'); bindEscape();
  const wrap = h('div', { class: 'sheet-wrap' + (opts.noDim ? ' nodim' : ''), onclick: (e) => { if (e.target === wrap) close(); } });
  const box = h('div', { class: 'sheet' + (opts.tall ? ' tall' : ''), role: 'dialog', 'aria-modal': opts.noDim ? 'false' : 'true', 'aria-label': title });
  let closed = false;
  const close = () => { if (closed) return; closed = true; const k = sheetStack.findIndex((x) => x.close === close); if (k >= 0) sheetStack.splice(k, 1); wrap.remove(); if (!ov.children.length) ov.hidden = true; opts.onClose && opts.onClose(); };
  box.append(h('div', { class: 'sheet-head' },
    h('strong', null, title), h('button', { class: 'sheet-x', 'aria-label': 'Close', title: 'Close', onclick: close }, '✕')));
  const body = h('div', { class: 'sheet-body' });
  body.append(...[].concat(build(close)));
  box.append(body);
  if (!opts.noFooter) box.append(h('div', { class: 'sheet-foot' }, h('button', { class: 'btn-text sheet-done', onclick: close }, opts.closeLabel || 'Done')));
  wrap.append(box); ov.append(wrap); ov.hidden = false; sheetStack.push({ close });
  return { close, body };
}

export function confirmDlg(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet(title, (close) => [
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => { done = true; close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; close(); resolve(true); } }, okLabel)),
    ], { closeLabel: 'Cancel', noFooter: true, onClose: () => { if (!done) resolve(false); } });
    return s;
  });
}

export function promptDlg(title, value = '', placeholder = '', okLabel = 'Save') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, placeholder, class: 'field', autocapitalize: 'words' });
    sheet(title, (close) => [
      input,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => { done = true; close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { done = true; close(); resolve(input.value.trim() || null); } }, okLabel)),
    ], { closeLabel: 'Cancel', noFooter: true, onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; $('#overlay .sheet-wrap:last-child')?.remove(); if (!$('#overlay').children.length) $('#overlay').hidden = true; resolve(input.value.trim() || null); } });
  });
}

/** Action sheet: items = [{label, onClick, danger, checked}] */
export function actionSheet(title, items) {
  return sheet(title, (close) => h('div', { class: 'list' }, items.map((it) =>
    h('button', { class: 'list-item' + (it.danger ? ' danger-text' : '') + (it.primary ? ' primary-item' : ''), id: it.id, onclick: async () => { if (!it.keepOpen) close(); await it.onClick?.(); } },
      h('span', null, it.label), it.checked != null ? h('span', { class: 'check' }, it.checked ? '✓' : '') : null))));
}

/** append() that skips null/false (native append stringifies them). */
export function put(parent, ...kids) { parent.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return parent; }
