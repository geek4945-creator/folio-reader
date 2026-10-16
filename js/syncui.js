// Settings → Sync (v0.5.5): status, what to sync, this device's name, other devices, device-specific settings.
import { h, toast, confirmDlg } from './util.js';
import * as G from './google.js';
import { SETTING_GROUPS, deviceOnlyGroups, setDeviceOnlyGroups } from './settings.js';
import { deviceName, setDeviceName, guessDeviceName } from './device.js';
import { askAlways, setAskAlways, conflictCount, ago } from './positions.js';

let refreshed = false, optionsOpen = false;   // the panel redraws on every sync status change: remember whether it was open
const WHAT = { positions: 'positions', library: 'library', settings: 'settings' };
export function statusLine(st) {
  switch (st.state) {
    case 'syncing': return 'Syncing…';
    case 'offline': return st.message;
    case 'error': return 'Sync error: ' + st.message;
    case 'needs-reauth': return st.message;
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
  box.append(...[
    lastTxt ? h('p', { class: 'muted small', id: 'sync-last' }, lastTxt) : null,
    conflictCount() ? h('p', { class: 'plib-warn', id: 'sync-conflicts' }, `${conflictCount()} book${conflictCount() > 1 ? 's were' : ' was'} read on another device too — you’ll be asked which place to continue from when you open ${conflictCount() > 1 ? 'them' : 'it'}.`) : null,
    h('details', { open: optionsOpen, id: 'sync-options', ontoggle: (e) => { optionsOpen = e.target.open; } }, h('summary', null, 'What to sync & devices'),
      h('h4', null, 'What to sync'), ...toggles,
      h('label', { class: 'check', style: { display: 'block', margin: '8px 0' } }, h('input', { type: 'checkbox', id: 'ask-continue', checked: askAlways(), onchange: (e) => setAskAlways(e.target.checked) }), ' Always ask before jumping to another device’s position', h('div', { class: 'muted small' }, 'Off: if this device hasn’t moved, it quietly continues from where you left off elsewhere; if you read here too, you’re asked.')),
      h('h4', null, 'Keep on this device only'), h('p', { class: 'muted small' }, 'Ticked groups of settings are not shared (each device keeps its own).'), ...groups,
      h('h4', null, 'This device'), nm, h('p', { class: 'muted small' }, 'Shown to your other devices in “Continue from …”.'),
      h('h4', null, 'Your devices'), devList, h('button', { class: 'btn small', id: 'devices-refresh', onclick: () => paintDevices(true) }, 'Refresh'))].filter(Boolean));
  return box;
}
