// Drag-to-reorder for grids and lists. Touch: long-press then drag (iOS Safari friendly). Mouse: press and drag.
export function enableDragSort(container, { itemSel = '.tile', onDrop, vertical = false, scroller = null, holdMs = 350 }) {
  let st = null;      // active gesture
  let justDragged = false;

  const items = () => [...container.querySelectorAll(itemSel)];

  container.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('button, a, input, select')) return;
    const item = e.target.closest(itemSel); if (!item || item.parentElement !== container) return;
    st = { item, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== 'mouse', timer: null, startOrder: null, raf: 0 };
    if (st.touch) st.timer = setTimeout(() => begin(), holdMs);
  });

  window.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    st.x = e.clientX; st.y = e.clientY;
    if (!st.active) {
      const d = Math.hypot(st.x - st.sx, st.y - st.sy);
      if (st.touch) { if (d > 10) cancel(); }                     // finger moved: it's a scroll
      else if (d > 6) begin();
      return;
    }
    e.preventDefault(); move();
  }, { passive: false });

  // Once a long-press drag is active, stop iOS from scrolling the page.
  window.addEventListener('touchmove', (e) => { if (st && st.active) e.preventDefault(); }, { passive: false });
  container.addEventListener('contextmenu', (e) => { if (st) e.preventDefault(); });

  const end = (e) => {
    if (!st || (e && e.pointerId !== st.id)) return;
    const was = st.active; finish(e && e.type === 'pointercancel');
    if (was) { justDragged = true; setTimeout(() => { justDragged = false; }, 80); }
  };
  window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  container.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);

  function begin() {
    if (!st) return;
    clearTimeout(st.timer); st.active = true;
    const { item } = st; const r = item.getBoundingClientRect();
    st.offX = st.sx - r.left; st.offY = st.sy - r.top;
    st.ghost = item.cloneNode(true);
    Object.assign(st.ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: 9999, pointerEvents: 'none', transform: 'scale(1.06)', boxShadow: '0 12px 30px rgba(0,0,0,.35)', opacity: '.95', transition: 'transform .12s' });
    document.body.append(st.ghost);
    item.classList.add('drag-placeholder'); container.classList.add('sorting'); document.body.classList.add('dragging-now');
    st.startOrder = items().map((i) => i.dataset.key).join('|');
    if (navigator.vibrate) navigator.vibrate(12);
    tick();
  }

  function move() {
    const { ghost } = st;
    ghost.style.left = (st.x - st.offX) + 'px'; ghost.style.top = (st.y - st.offY) + 'px';
    ghost.style.display = 'none';
    const under = document.elementFromPoint(st.x, st.y);
    ghost.style.display = '';
    const target = under && under.closest(itemSel);
    if (!target || target === st.item || target.parentElement !== container) return;
    const r = target.getBoundingClientRect();
    const before = vertical ? st.y < r.top + r.height / 2 : st.x < r.left + r.width / 2;
    if (before) container.insertBefore(st.item, target); else container.insertBefore(st.item, target.nextSibling);
  }

  function tick() {   // auto-scroll while dragging near the edges
    if (!st || !st.active) return;
    const sc = scroller || container.closest('#view') || document.scrollingElement;
    const r = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
    const edge = 70; let dy = 0;
    if (st.y < r.top + edge) dy = -Math.ceil((r.top + edge - st.y) / 6);
    else if (st.y > r.bottom - edge) dy = Math.ceil((st.y - (r.bottom - edge)) / 6);
    if (dy) { sc.scrollTop += dy; move(); }
    st.raf = requestAnimationFrame(tick);
  }

  function cancel() { if (st) { clearTimeout(st.timer); st = null; } }

  function finish(cancelled) {
    if (!st) return;
    clearTimeout(st.timer); cancelAnimationFrame(st.raf);
    if (st.active) {
      st.ghost.remove(); st.item.classList.remove('drag-placeholder'); container.classList.remove('sorting'); document.body.classList.remove('dragging-now');
      const keys = items().map((i) => i.dataset.key);
      if (!cancelled && keys.join('|') !== st.startOrder) onDrop(keys);
    }
    st = null;
  }
}
