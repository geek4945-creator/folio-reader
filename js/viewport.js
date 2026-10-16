// iPhone home-screen / Safari: keep the page from zooming into odd positions. Safari ignores user-scalable=no (accessibility), so pinch and
// double-tap zoom is turned off with touch-action: manipulation, pinch with the gesture / multi-touch handlers, and the page is put back at 0,0 after the keyboard closes. The reader's text size is a setting, not a pinch.
const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];
/** Block pinch / multi-touch zoom inside a document (the main page, and each EPUB iframe). */
export function blockZoom(doc) {
  if (!doc || doc.__noZoom) return; doc.__noZoom = true;
  for (const t of GESTURES) doc.addEventListener(t, (e) => { e.preventDefault(); }, { passive: false });
  doc.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
}
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
export function resetScroll() {
  if (typing()) return;
  window.scrollTo(0, 0); const se = document.scrollingElement; if (se) { se.scrollTop = 0; se.scrollLeft = 0; } document.body.scrollTop = 0;
}
export function initViewport() {
  blockZoom(document);
  document.addEventListener('focusout', (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '')) setTimeout(resetScroll, 60); setTimeout(resetScroll, 350); }, true);   // keyboard closed: iOS can leave the page shifted
  const vv = window.visualViewport;
  if (vv) { const fix = () => { if (!typing() && (vv.offsetTop || vv.offsetLeft || vv.pageTop || vv.pageLeft)) resetScroll(); }; vv.addEventListener('resize', fix); vv.addEventListener('scroll', fix); }
  window.addEventListener('orientationchange', () => setTimeout(resetScroll, 300));
  window.addEventListener('scroll', () => { if (!typing()) resetScroll(); }, { passive: true });
}
