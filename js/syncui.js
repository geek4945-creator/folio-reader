// Settings → Sync (v0.5.5): status, what to sync, this device's name, other devices, device-specific settings.
import { h, toast, confirmDlg, sheet } from './util.js';
import { deviceId } from './device.js';
import * as G from './google.js';
import { SETTING_GROUPS, deviceOnlyGroups, setDeviceOnlyGroups } from './settings.js';
import { deviceName, setDeviceName, guessDeviceName } from './device.js';
import { askAlways, setAskAlways, conflictCount, ago } from './positions.js';
import { missingBooks, openMissing, maybeShowConflict } from './syncfetch.js';

let refreshed = false, optionsOpen = false;   // the panel redraws on every sync status change: remember whether it was open
const WHAT = { positions: 'positions', library: 'library', settings: 'settings' };
export function statusLine(st) {
  switch (st.state) {
    case 'syncing': return 'Syncing…';
    case 'offline': return st.message;
    case 'error': return 'Sync error: ' + st.message;
    case 'needs-reauth': return st.message;
    case 'conflict': return st.message;
    case 'connected': return st.lastSync ? 'Last synced ' + new Date(st.lastSync).toLocaleString() + (G.isDirty() ? ' · changes waiting to upload' : '') : 'Connected';
    default: return '';
  }
}
export function syncDetails(redraw) {
  const st = G.getStatus(); const box = h('div', { class: 'sync-details', id: 'sync-details' });
  const last = st.last || (() => { try { return JSON.parse(localStorage.getItem('folio.sync.last') || 'null'); } catch { return null; } })();
  const lastTxt = last ? `Last sync (${ago(last.at)}): ${last.downloaded.length ? 'received ' + last.downloaded.map((d) => WHAT[d]).join(', ') : 'nothing new from other devices'}${last.uploaded.length ? '; sent ' + last.uploaded.map((d) => WHAT[d]).join(', ') : ''}.` : '';
  const toggles = G.SYNC_DOMAINS.map((d) => h('label', { class: 'check', style: { display: 'block', margin: '6px 0' } }, h('input', { type: 'checkbox', id: 'sync-on-' + d.id, checked: G.domainEnabled(d.id), onchange: (e) => { G.setDomainEnabled(d.id, e.target.checked); if (e.target.checked) G.scheduleSync(500); } }), ' ', h('span', { style: { fontWeight: '600' } }, d.name), h('div', { class: 'muted small' }, d.hint)));
  const groups = SETTING_GROUPS.map((g) => h('label', { class: 'check', style: { display: 'block', margin: '4px 0' } }, h('input', { type: 'checkbox', id: 'dev-only-' + g.id, checked: deviceOnlyGroups().includes(g.id), onchange: (e) => { const s = new Set(deviceOnlyGroups()); e.target.checked ? s.add(g.id) : s.delete(g.id); setDeviceOnlyGroups([...s]); G.scheduleSync(500); } }), ' ', g.name, h('span', { class: 'muted small' }, ' — ' + g.hint)));
  const devList = h('div', { id: 'sync-devices', class: 'list' }, h('p', { class: 'muted small' }, 'Loading devices…'));
  const paintDevices = async (refresh) => {
    const devs = await G.listDevices({ refresh });
    devList.replaceChildren(...(devs.length ? devs.map((d) => h('div', { class: 'list-item', style: { display: 'flex', gap: '8px', alignItems: 'center' }, dataset: { device: d.id } },
      h('div', { class: 'grow' }, h('strong', null, d.name + (d.me ? ' (this device)' : '')), h('div', { class: 'muted small' }, (d.platform || '') + ' · v' + (d.version || '?') + ' · last seen ' + (d.lastSeen ? ago(d.lastSeen) : '?'))),
      d.me ? null : h('button', { class: 'btn small', onclick: async () => { if (await confirmDlg('Forget ' + d.name + '?', 'Removes it from this list. It reappears the next time that device syncs.', 'Forget', true)) { try { await G.forgetDevice(d.id); } catch (e) { toast(e.message); } paintDevices(false); } } }, 'Forget'))) : [h('p', { class: 'muted small' }, 'No devices yet — sync once.')]));
  };
  paintDevices(!refreshed).catch(() => {}); refreshed = true;
  const nm = h('input', { class: 'field', id: 'device-name', value: deviceName(), placeholder: guessDeviceName(), maxlength: 40, onchange: (e) => { setDeviceName(e.target.value); G.scheduleSync(500); toast('Device name saved'); } });
  const counts = G.syncCounts(); const miss = missingBooks();
  const pref = G.conflictPref(); const PREF = { merge: 'Merge both', local: 'Keep this device', cloud: 'Use the other device' };
  const skew = G.clockSkew();
  box.append(...[
    h('p', { class: 'small', id: 'sync-counts' }, counts ? `This device: ${counts.local} book${counts.local === 1 ? '' : 's'} · Synced library: ${counts.cloud}` + (miss.count ? ` · ${miss.count} not on this device` : '') : 'Book counts appear after the first sync.'),
    coverLine(),
    miss.count ? h('div', { class: 'row-actions wrap' }, h('button', { class: 'btn small', id: 'sync-get-missing', onclick: () => openMissing(redraw) }, `Get ${miss.count} missing book${miss.count === 1 ? '' : 's'}`)) : null,
    G.pendingConflict() ? h('div', { class: 'plib-warn', id: 'sync-conflict-pending' }, 'Sync is paused: this device and another one disagree about many things. ', h('button', { class: 'btn small primary', id: 'sync-conflict-open', onclick: () => maybeShowConflict(true) }, 'Choose')) : null,
    pref ? h('p', { class: 'muted small', id: 'sync-conflict-pref' }, `Big disagreements between devices: always “${PREF[pref] || pref}”. `, h('button', { class: 'btn-text', id: 'sync-conflict-ask', onclick: () => { G.setConflictPref(''); toast('Folio will ask next time'); redraw(); } }, 'Ask again')) : null,
    Math.abs(skew) > 120000 ? h('p', { class: 'plib-warn', id: 'sync-skew' }, `This device’s clock is about ${Math.round(Math.abs(skew) / 60000)} min ${skew > 0 ? 'behind' : 'ahead'}. Turn on “Set automatically” in the system date settings so the newest change always wins.`) : null,
    lastTxt ? h('p', { class: 'muted small', id: 'sync-last' }, lastTxt) : null,
    bookInfoBox(),
    conflictCount() ? h('p', { class: 'plib-warn', id: 'sync-conflicts' }, `${conflictCount()} book${conflictCount() > 1 ? 's were' : ' was'} read on another device too — you’ll be asked which place to continue from when you open ${conflictCount() > 1 ? 'them' : 'it'}.`) : null,
    h('details', { open: optionsOpen, id: 'sync-options', ontoggle: (e) => { optionsOpen = e.target.open; } }, h('summary', null, 'What to sync & devices'),
      h('h4', null, 'What to sync'), ...toggles,
      h('label', { class: 'check', style: { display: 'block', margin: '8px 0' } }, h('input', { type: 'checkbox', id: 'ask-continue', checked: askAlways(), onchange: (e) => setAskAlways(e.target.checked) }), ' Always ask before jumping to another device’s position', h('div', { class: 'muted small' }, 'Off: if this device hasn’t moved, it quietly continues from where you left off elsewhere; if you read here too, you’re asked.')),
      h('h4', null, 'Keep on this device only'), h('p', { class: 'muted small' }, 'Ticked groups of settings are not shared (each device keeps its own).'), ...groups,
      h('h4', null, 'This device'), nm, h('p', { class: 'muted small' }, 'Shown to your other devices in “Continue from …”.'),
      h('h4', null, 'Your devices'), devList, h('button', { class: 'btn small', id: 'devices-refresh', onclick: () => paintDevices(true) }, 'Refresh'))].filter(Boolean));
  return box;
}

/* ---------- v0.5.21: covers waiting, source of truth, restore ---------- */
function coverLine() {
  if (!G.isSignedIn()) return null; const c = G.coverQueue.counts(); if (!c.up && !c.down) return null;
  return h('p', { class: 'muted small', id: 'sync-covers' }, 'Covers: ' + [c.up ? `${c.up} waiting to upload` : '', c.down ? `${c.down} waiting to download` : ''].filter(Boolean).join(' · ') + ' — retried on every sync.');
}
const localDT = (t) => { const d = new Date(t); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
function bookInfoBox() {
  if (!G.isSignedIn()) return null; const tr = G.sourceOfTruth();
  return h('div', { id: 'sync-bookinfo', class: 'list-item' },
    h('strong', null, 'Book info (titles, authors, sets, order, covers)'),
    h('p', { class: 'muted small' }, 'Each edit you make is kept per field and wins over the info inside the book file. When two devices edited the same field, the newer edit wins.'),
    tr ? h('p', { class: 'muted small', id: 'sync-truth-info' }, `Last made the reference: ${tr.dev === deviceId() ? 'this device' : (tr.name || 'another device')}, ${new Date(tr.at).toLocaleString()}.`) : null,
    h('div', { class: 'row-actions wrap' },
      h('button', { class: 'btn small', id: 'sync-truth', onclick: openTruth }, 'Make this device the source of truth for book info'),
      h('button', { class: 'btn small', id: 'sync-restore', onclick: openRestore }, 'Restore book info from an earlier sync')));
}
function openTruth() {
  sheet('Use this device’s book info everywhere?', (close) => [h('div', { id: 'truth-sheet' },
    h('p', null, 'Every title, author, set, order in set and chosen cover on this device replaces the one on your other devices the next time they sync. Reading progress, shelves and settings are not touched.'),
    h('p', { class: 'muted small' }, 'Use it on the device whose book info is right. Check a few books first.'),
    h('button', { class: 'btn primary', id: 'truth-go', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Working…';
      try { const n = await G.makeSourceOfTruth(); close(); toast(`This device is now the source of truth for book info (${n} book${n === 1 ? '' : 's'})`, 8000); }
      catch (err) { e.target.disabled = false; e.target.textContent = 'Try again'; toast(err.message, 5000); }
    } }, 'Make this device the source of truth'))]);
}
function openRestore() {
  const list = h('div', { id: 'rs-list', class: 'list' }); const prev = h('p', { id: 'rs-preview', class: 'small' }); let point = null;
  const apply = h('button', { class: 'btn primary', id: 'rs-apply', disabled: true, onclick: async () => {
    if (!point) return; apply.disabled = true; apply.textContent = 'Restoring…';
    try { const n = await G.applyRestore(point); prev.textContent = `Restored ${n} book${n === 1 ? '' : 's'}. Your other devices follow on their next sync.`; apply.textContent = 'Done'; toast(`Restored ${n} book${n === 1 ? '' : 's'}`, 6000); }
    catch (e) { prev.textContent = 'Couldn’t restore: ' + e.message; apply.disabled = false; apply.textContent = 'Restore'; }
  } }, 'Restore');
  const pick = async (p, btn) => {
    point = null; apply.disabled = true; prev.textContent = 'Checking…'; for (const b of list.querySelectorAll('button')) b.classList.toggle('primary', b === btn);
    try { const r = await G.previewRestore(p); prev.textContent = r.text; if (r.count) { point = p; apply.disabled = false; } } catch (e) { prev.textContent = 'Couldn’t read it: ' + e.message; }
  };
  const date = h('input', { type: 'datetime-local', class: 'field', id: 'rs-date', step: 1, value: localDT(Date.now()), onchange: () => paint() });
  let seq = 0;
  const paint = async () => {
    const my = ++seq; list.replaceChildren(h('p', { class: 'muted small' }, 'Looking for earlier versions…')); prev.textContent = ''; point = null; apply.disabled = true;
    const t = Date.parse(date.value); const until = Number.isFinite(t) ? t + 999 : Date.now();
    let pts = []; try { pts = await G.listRestorePoints(until); } catch { /* none */ } if (my !== seq) return;
    list.replaceChildren(...(pts.length ? pts.map((p) => { const b = h('button', { class: 'btn small', style: { display: 'block', margin: '4px 0', textAlign: 'left' }, dataset: { src: p.src, id: p.id }, onclick: () => pick(p, b) }, p.label + (p.src === 'local' ? ' (this device)' : ' (Google Drive)')); return b; })
      : [h('p', { class: 'muted small' }, 'No earlier versions before that time. Google Drive keeps earlier versions of the synced library for about 30 days (up to 100 versions).')]));
  };
  sheet('Restore book info', () => [h('div', { id: 'restore-sheet' },
    h('p', null, 'Pick a time before the unwanted change. Folio lists the versions saved up to then — this device’s own history and the copies Google Drive kept — and shows what would change before anything is touched.'),
    date, list, prev, apply,
    h('p', { class: 'muted small' }, 'Only titles, authors, sets, order in set, descriptions, years and languages are restored, as new edits from this device. Reading progress and shelves are not touched.'))], { tall: true });
  paint();
}
