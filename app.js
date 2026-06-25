/* The Forever Winter — interactive map atlas (offline wrapper around the
   wiki.gg DataMaps data). Vanilla JS + Leaflet. */
'use strict';

const WIKI_BASE = 'https://theforeverwinter.wiki.gg';
const IMG_BASE = 'assets/img/';
const ICON_BASE_PX = 30;      // screen px for a group whose size is [100,100]
const ICON_MIN = 14, ICON_MAX = 60;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Image references in the data use either spaces or underscores; the on-disk
   files use underscores with the first letter capitalised. */
function imgFile(ref) {
  let f = String(ref).trim().replace(/ /g, '_');
  return f.charAt(0).toUpperCase() + f.slice(1);
}
const imgUrl = ref => IMG_BASE + encodeURIComponent(imgFile(ref));
function wikiUrl(article) {
  // article may contain an #anchor; keep it.
  const [page, hash] = String(article).split('#');
  return WIKI_BASE + '/wiki/' + encodeURIComponent(page.replace(/ /g, '_')) + (hash ? '#' + hash : '');
}

/* Pixel (x,y, y-down) -> Leaflet latlng. We negate y so the image is upright. */
const pt = (x, y) => L.latLng(-y, x);

const State = {
  manifest: null,
  map: null,
  current: null,        // current map id
  data: null,           // current map json
  groupLayers: {},      // groupId -> L.layerGroup
  bgLayers: [],         // background L.layerGroup list
  bgGroup: null,        // currently shown bg layer
  searchIndex: [],      // {text, group, marker ref, latlng}
  markerRefs: [],       // {marker(Leaflet), groupId, latlng, popupZoom}
};

/* ---------------- bootstrap ---------------- */
async function init() {
  State.manifest = await fetch('manifest.json').then(r => r.json());
  buildMapsPanel();
  wireUI();
  registerSW();

  // pick map from hash or default to first surface map
  const fromHash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  const found = State.manifest.maps.find(m => m.id === fromHash);
  loadMap(found ? found.id : State.manifest.maps[0].id);
}

function buildMapsPanel() {
  const list = $('#maps-list');
  list.innerHTML = '';
  const labels = { surface: 'Surface regions', tunnel: 'Tunnels', aerial: 'Aerial reference' };
  const byType = { surface: [], tunnel: [], aerial: [] };
  State.manifest.maps.forEach(m => (byType[m.type] || (byType[m.type] = [])).push(m));
  $('#maps-count').textContent = State.manifest.maps.length + ' maps';
  for (const type of ['surface', 'tunnel', 'aerial']) {
    if (!byType[type] || !byType[type].length) continue;
    list.appendChild(el('div', 'map-group-title', labels[type] || type));
    byType[type].forEach(m => {
      const item = el('div', 'map-item');
      item.dataset.id = m.id;
      item.innerHTML = `<span>${esc(m.name)}</span><span class="mk">${m.markers}</span>`;
      item.onclick = () => { loadMap(m.id); if (isMobile()) closePanels(); };
      list.appendChild(item);
    });
  }
}

/* ---------------- map loading ---------------- */
async function loadMap(id) {
  const meta = State.manifest.maps.find(m => m.id === id);
  if (!meta) return;
  showLoading(`Loading ${meta.name}…`);
  State.current = id;
  location.hash = id;
  document.querySelectorAll('.map-item').forEach(n => n.classList.toggle('active', n.dataset.id === id));
  $('#current-map').innerHTML = `${esc(meta.name)} <span class="type">· ${meta.type}</span>`;

  try {
    const data = await fetch(meta.file).then(r => r.json());
    State.data = data;
    await renderMap(data, meta);
  } catch (err) {
    console.error('renderMap failed:', err);
    $('#loading-text').textContent = 'Error: ' + err.message;
  }
  hideLoading();
}

function freshMap() {
  if (State.map) { State.map.remove(); State.map = null; }
  $('#map').innerHTML = '';
  State.map = L.map('map', {
    crs: L.CRS.Simple, minZoom: -8, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5,
    attributionControl: false, zoomControl: true, preferCanvas: false,
    maxBoundsViscosity: 0.7,
    fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false,
  });
  // dedicated pane so backgrounds always sit beneath markers
  State.map.createPane('fwBackground');
  State.map.getPane('fwBackground').style.zIndex = 180;
  State.groupLayers = {}; State.bgLayers = []; State.bgGroup = null;
  State.searchIndex = []; State.markerRefs = [];
}

/* derive pixel extent {w,h} from a background (tiled or single-image) */
function tileSizeOf(bg) {
  const ts = bg.tileSize;
  if (Array.isArray(ts)) return [ts[0], ts[1]];
  if (typeof ts === 'number') return [ts, ts];
  return [1000, 1000];
}
function extentFromTiles(bg) {
  const [tw, th] = tileSizeOf(bg);
  let maxc = 0, maxr = 0;
  (bg.tiles || []).forEach(t => { maxc = Math.max(maxc, t.position[0]); maxr = Math.max(maxr, t.position[1]); });
  return { w: (maxc + 1) * tw, h: (maxr + 1) * th };
}
function loadImageSize(url) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res(null);
    im.src = url;
  });
}

/* build a Leaflet layer for one background entry */
function makeBgLayer(bg, extent) {
  const lg = L.layerGroup();
  const [tw, th] = tileSizeOf(bg);
  const opt = { pane: 'fwBackground' };
  if (bg.tiles && bg.tiles.length) {
    bg.tiles.forEach(t => {
      const x0 = t.position[0] * tw, y0 = t.position[1] * th;
      L.imageOverlay(imgUrl(t.image), [pt(x0, y0), pt(x0 + tw, y0 + th)], opt).addTo(lg);
    });
  } else if (bg.image) {
    L.imageOverlay(imgUrl(bg.image), [pt(0, 0), pt(extent.w, extent.h)], opt).addTo(lg);
  }
  return lg;
}

async function renderMap(data, meta) {
  freshMap();
  const map = State.map;
  const backgrounds = data.backgrounds || (data.background ? [data.background] : []);

  // Determine canvas extent from the first background.
  let extent;
  const first = backgrounds[0] || {};
  if (first.tiles && first.tiles.length) extent = extentFromTiles(first);
  else if (first.image) extent = (await loadImageSize(imgUrl(first.image))) || { w: 2000, h: 2000 };
  else extent = { w: 2000, h: 2000 };
  State.extent = extent;

  const world = L.latLngBounds(pt(0, 0), pt(extent.w, extent.h));
  map.setMaxBounds(world.pad(0.25));

  // Background layers (+ switcher when >1)
  State.bgLayers = backgrounds.map(bg => ({ name: bg.name, layer: makeBgLayer(bg, extent) }));
  showBackground(0);
  buildBgSwitch(backgrounds);

  // Groups & markers
  buildMarkers(data);
  buildLayersPanel(data, meta);

  map.fitBounds(world, { padding: [10, 10] });
  // a sensible "focus" zoom for search jumps
  State.focusZoom = Math.min(map.getZoom() + 2.5, map.getMaxZoom());
}

function showBackground(idx) {
  if (State.bgGroup) State.map.removeLayer(State.bgGroup);
  const entry = State.bgLayers[idx];
  if (!entry) return;
  State.bgGroup = entry.layer.addTo(State.map);
}

function buildBgSwitch(backgrounds) {
  const box = $('#bg-switch');
  box.innerHTML = '';
  if (backgrounds.length <= 1) { box.hidden = true; return; }
  box.hidden = false;
  backgrounds.forEach((bg, i) => {
    const id = 'bg-' + i;
    const lab = el('label');
    lab.innerHTML = `<input type="radio" name="bgsel" id="${id}" ${i === 0 ? 'checked' : ''}><span>${esc(bg.name || ('View ' + (i + 1)))}</span>`;
    lab.querySelector('input').onchange = () => showBackground(i);
    box.appendChild(lab);
  });
}

/* ---------------- markers ---------------- */
function iconPx(group, m) {
  const s0 = (group && Array.isArray(group.size)) ? group.size[0] : 100;
  let px = ICON_BASE_PX * (s0 / 100) * (m.scale || 1);
  return Math.round(Math.max(ICON_MIN, Math.min(ICON_MAX, px)));
}

function popupHtml(m, group, categories) {
  let h = '<div class="fw-pop">';
  if (categories && categories.length) h += `<div class="fw-pop-cat">${esc(categories.join(' · '))}</div>`;
  h += `<div class="fw-pop-title">${esc(m.name || (group && group.name) || 'Marker')}</div>`;
  if (m.image) h += `<img class="fw-pop-img" src="${imgUrl(m.image)}" alt="" loading="lazy">`;
  if (m.description) h += `<div class="fw-pop-desc">${esc(m.description)}</div>`;
  const article = (group && group.article);
  if (article) h += `<a class="fw-pop-link" href="${wikiUrl(article)}" target="_blank" rel="noopener">Open wiki article ↗</a>`;
  h += '</div>';
  return h;
}

function buildMarkers(data) {
  const groups = data.groups || {};
  const counts = {};
  for (const key in (data.markers || {})) {
    const parts = key.split(' ');
    const gid = parts[0];
    const categories = parts.slice(1);
    const group = groups[gid];
    const lg = State.groupLayers[gid] || (State.groupLayers[gid] = L.layerGroup());
    (data.markers[key] || []).forEach(m => {
      const px = iconPx(group, m);
      const iconRef = m.icon || (group && group.icon) || 'Map_icon_Insertion.png';
      const icon = L.icon({ iconUrl: imgUrl(iconRef), iconSize: [px, px], iconAnchor: [px / 2, px / 2], className: 'fw-marker', popupAnchor: [0, -px / 2] });
      const marker = L.marker(pt(m.x, m.y), { icon, riseOnHover: true });
      const title = m.name || (group && group.name) || gid;
      marker.bindTooltip(esc(title), { direction: 'top', offset: [0, -px / 2 + 2] });
      marker.bindPopup(popupHtml(m, group, categories), { maxWidth: 270, autoPanPadding: [40, 60] });
      marker.addTo(lg);
      counts[gid] = (counts[gid] || 0) + 1;
      State.searchIndex.push({
        text: ((title) + ' ' + (m.searchKeywords || '') + ' ' + (group ? group.name : '') + ' ' + (m.description || '')).toLowerCase(),
        title, gid, iconRef, latlng: pt(m.x, m.y), marker,
      });
    });
  }
  State.counts = counts;

  // Show default groups on the map.
  for (const gid in State.groupLayers) {
    const g = groups[gid];
    if (!g || g.isDefault !== false) State.groupLayers[gid].addTo(State.map);
  }
}

/* ---------------- layers panel ---------------- */
function buildLayersPanel(data, meta) {
  const groups = data.groups || {};
  const list = $('#layers-list');
  list.innerHTML = '';
  // preserve the data's group order, but only show groups that have markers
  const order = Object.keys(groups).filter(g => State.counts[g]);
  // include any marker group not declared in groups{}
  for (const g in State.counts) if (!order.includes(g)) order.push(g);

  $('#layers-count').textContent = order.length + ' layers';
  order.forEach(gid => {
    const g = groups[gid] || { name: gid, icon: 'Map_icon_Insertion.png' };
    const on = State.map.hasLayer(State.groupLayers[gid]);
    const row = el('label', 'layer-item' + (on ? '' : ' off'));
    row.innerHTML =
      `<input type="checkbox" ${on ? 'checked' : ''}>` +
      `<img src="${imgUrl(g.icon || 'Map_icon_Insertion.png')}" alt="">` +
      `<span class="name">${esc(g.name || gid)}</span>` +
      `<span class="cnt">${State.counts[gid]}</span>`;
    const cb = row.querySelector('input');
    cb.onchange = () => {
      if (cb.checked) State.groupLayers[gid].addTo(State.map);
      else State.map.removeLayer(State.groupLayers[gid]);
      row.classList.toggle('off', !cb.checked);
    };
    list.appendChild(row);
  });
}

function setAllLayers(mode) {
  // mode: 'all' | 'none' | 'default'
  const groups = (State.data && State.data.groups) || {};
  for (const gid in State.groupLayers) {
    const g = groups[gid];
    let want = mode === 'all' ? true : mode === 'none' ? false : (!g || g.isDefault !== false);
    const has = State.map.hasLayer(State.groupLayers[gid]);
    if (want && !has) State.groupLayers[gid].addTo(State.map);
    if (!want && has) State.map.removeLayer(State.groupLayers[gid]);
  }
  // resync checkboxes
  buildLayersPanel(State.data, null);
}

/* ---------------- search ---------------- */
let searchActiveIdx = -1, searchMatches = [];
function runSearch(q) {
  const box = $('#search-results');
  q = q.trim().toLowerCase();
  if (!q) { box.classList.remove('show'); box.innerHTML = ''; return; }
  searchMatches = State.searchIndex.filter(e => e.text.includes(q)).slice(0, 40);
  if (!searchMatches.length) {
    box.innerHTML = '<div class="sr-item"><span class="g">No matches on this map</span></div>';
    box.classList.add('show'); return;
  }
  box.innerHTML = '';
  searchMatches.forEach((e, i) => {
    const it = el('div', 'sr-item');
    it.innerHTML = `<img src="${imgUrl(e.iconRef)}" alt=""><span class="t">${esc(e.title)}</span><span class="g">${esc((State.data.groups[e.gid] || {}).name || e.gid)}</span>`;
    it.onclick = () => gotoMatch(e);
    box.appendChild(it);
  });
  searchActiveIdx = -1;
  box.classList.add('show');
}
function gotoMatch(e) {
  if (!State.map.hasLayer(State.groupLayers[e.gid])) {
    State.groupLayers[e.gid].addTo(State.map);
    buildLayersPanel(State.data, null);
  }
  State.map.flyTo(e.latlng, State.focusZoom || State.map.getZoom(), { duration: .4 });
  e.marker.openPopup();
  $('#search-results').classList.remove('show');
}

/* ---------------- UI wiring ---------------- */
function isMobile() { return window.matchMedia('(max-width: 760px)').matches; }
function openPanel(which) {
  const p = $('#' + which + '-panel');
  p.classList.remove('collapsed');
  if (isMobile()) { $('#scrim').classList.add('show'); }
  $('#toggle-' + which).classList.add('active');
}
function closePanels() {
  $('#maps-panel').classList.add('collapsed');
  $('#layers-panel').classList.add('collapsed');
  $('#scrim').classList.remove('show');
  $('#toggle-maps').classList.remove('active');
  $('#toggle-layers').classList.remove('active');
}
function togglePanel(which) {
  const p = $('#' + which + '-panel');
  if (p.classList.contains('collapsed')) { if (isMobile()) closePanels(); openPanel(which); }
  else closePanels();
}

function wireUI() {
  $('#toggle-maps').onclick = () => togglePanel('maps');
  $('#toggle-layers').onclick = () => togglePanel('layers');
  $('#close-maps').onclick = closePanels;
  $('#close-layers').onclick = closePanels;
  $('#scrim').onclick = closePanels;
  $('#reset-view').onclick = () => State.map && State.map.fitBounds(L.latLngBounds(pt(0, 0), pt(State.extent.w, State.extent.h)), { padding: [10, 10] });
  $('#layers-all').onclick = () => setAllLayers('all');
  $('#layers-none').onclick = () => setAllLayers('none');
  $('#layers-default').onclick = () => setAllLayers('default');

  const search = $('#search');
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(() => runSearch(search.value), 120); };
  search.onfocus = () => { if (search.value) runSearch(search.value); };
  document.addEventListener('click', e => { if (!e.target.closest('#search-wrap')) $('#search-results').classList.remove('show'); });
  search.onkeydown = e => {
    const box = $('#search-results');
    if (e.key === 'Escape') { search.value = ''; box.classList.remove('show'); return; }
    if (!searchMatches.length) return;
    if (e.key === 'ArrowDown') { searchActiveIdx = Math.min(searchActiveIdx + 1, searchMatches.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { searchActiveIdx = Math.max(searchActiveIdx - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') { gotoMatch(searchMatches[Math.max(0, searchActiveIdx)]); return; }
    else return;
    box.querySelectorAll('.sr-item').forEach((n, i) => n.classList.toggle('active', i === searchActiveIdx));
  };

  // keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'm' || e.key === 'M') togglePanel('maps');
    if (e.key === 'l' || e.key === 'L') togglePanel('layers');
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  });

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (id && id !== State.current) loadMap(id);
  });
}

function showLoading(txt) { $('#loading-text').textContent = txt || 'Loading…'; $('#loading').classList.add('show'); }
function hideLoading() { $('#loading').classList.remove('show'); }

function registerSW() {
  // Skip on localhost so dev edits aren't shadowed by the cache.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const btn = $('#save-offline'), status = $('#offline-status');
  if (!('serviceWorker' in navigator) || local) {
    if (btn) { btn.disabled = true; status.textContent = local ? 'Offline save disabled on localhost' : 'Not supported in this browser'; }
    return;
  }
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'SAVE_PROGRESS') status.textContent = `Saving… ${d.done}/${d.total}`;
    if (d.type === 'SAVE_DONE') { status.textContent = `✓ ${d.total} images saved — works fully offline`; btn.disabled = false; btn.textContent = '⤓ Save all maps offline'; }
  });
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Saving…'; status.textContent = 'Preparing…';
    try {
      const list = await fetch('assets/img-list.json').then(r => r.json());
      const reg = await navigator.serviceWorker.ready;
      reg.active.postMessage({ type: 'SAVE_ALL', urls: list.images });
    } catch (err) {
      status.textContent = 'Failed: ' + err.message; btn.disabled = false; btn.textContent = '⤓ Save all maps offline';
    }
  };
}

window.FW = State; // expose for debugging
init();
