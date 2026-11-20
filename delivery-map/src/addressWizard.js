import { loadZones } from './config.js';
import { createApi } from './api.js';
import { renderZones, boundsForRadiusKm, outerRadiusKm } from './zones.js';
import { createDeliveryGeocoder } from './geocode/deliveryGeocoder.js';

const DEFAULT_ZONES_URL = '/data/sample-zones.json';
let stylesReady = false;

function ensureStyles() {
  if (stylesReady && document.getElementById('aw-styles')) return;
  if (!document.getElementById('aw-styles')) {
    const style = document.createElement('style');
    style.id = 'aw-styles';
    style.textContent = `
      .aw-wizard { max-width:760px; margin:0 auto; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        color:#1b1b1b; font-size:18px; line-height:1.45; }
      .aw-wizard * { box-sizing:border-box; }
      .aw-step { display:none; }
      .aw-step.is-active { display:block; }
      .aw-question { font-size:30px; line-height:1.2; margin:0 0 8px; font-weight:800; }
      .aw-hint { font-size:19px; color:#444; margin:0 0 18px; }
      .aw-status { min-height:30px; padding:12px 14px; margin:14px 0; border-radius:10px;
        background:#fff7e6; font-size:19px; }
      .aw-status:empty { background:transparent; padding:0; min-height:0; }
      .aw-status.ok { background:#e8f7ec; color:#17662f; }
      .aw-status.err { background:#fdeaea; color:#a11; }
      .aw-btn { display:inline-block; min-height:54px; padding:12px 22px; margin:8px 8px 8px 0;
        font:inherit; font-size:19px; border:2px solid #b9b9b9; border-radius:12px;
        background:#fff; color:#202020; cursor:pointer; }
      .aw-btn:hover { background:#f2f2f2; }
      .aw-btn:disabled { opacity:.5; cursor:default; }
      .aw-btn.primary { background:#2d8a4e; border-color:#2d8a4e; color:#fff; font-weight:800;
        min-width:270px; font-size:21px; }
      .aw-btn.primary:hover:not(:disabled) { background:#247a41; }
      .aw-address-card { font-size:25px; font-weight:800; background:#eef5ff; border:2px solid #cfe0f7;
        border-radius:12px; padding:16px 18px; margin-bottom:12px; }
      .aw-delivery { font-size:22px; font-weight:800; padding:10px 0; }
      .aw-delivery.ok { color:#17662f; }
      .aw-delivery.bad { color:#a11; }
      .aw-map { width:100%; height:440px; border:2px solid #c9c9c9; border-radius:12px; margin:14px 0; }
      .aw-summary { font-size:21px; background:#f5f8fc; border:2px solid #dbe5f2; border-radius:12px;
        padding:18px 20px; margin-bottom:18px; }
      .aw-summary div { margin:8px 0; }
      .aw-pin-icon { background:transparent; border:0; }
      .aw-pin { font-size:44px; line-height:44px; width:56px; height:56px; text-align:center;
        filter:drop-shadow(0 3px 3px rgba(0,0,0,.4)); cursor:grab; }
      .aw-search .leaflet-control-geocoder { display:block; float:none; width:100%; max-width:none;
        margin:0; border-radius:12px; }
      .aw-search .leaflet-control-geocoder-icon { display:none; }
      .aw-search .leaflet-control-geocoder-form { display:block; width:100%; }
      .aw-search .leaflet-control-geocoder-form input { width:100%; font:inherit; font-size:21px;
        padding:14px 16px; height:60px; border-radius:12px; border:2px solid #9a9a9a; }
      .aw-search .leaflet-control-geocoder-alternatives { border-radius:12px; overflow:hidden;
        border:2px solid #9a9a9a; }
      .aw-search .leaflet-control-geocoder-alternatives li { font-size:19px; padding:14px 16px;
        border-bottom:1px solid #eee; }
      .aw-result-main { font-size:20px; font-weight:700; }
      .aw-result-sub { font-size:15px; color:#555; margin-top:2px; }
      .aw-note { font-size:16px; color:#555; margin-top:10px; }
      .aw-note summary { cursor:pointer; font-size:17px; }
      .aw-note input, .aw-note textarea { font:inherit; font-size:18px; width:100%; padding:10px;
        border-radius:10px; border:1px solid #bbb; }
    `;
    document.head.appendChild(style);
  }
  stylesReady = true;
}

function resolveContainer(container) {
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error('Address wizard container not found: ' + container);
    return el;
  }
  if (container && container.nodeType === 1) return container;
  throw new Error('createAddressWizard requires a container element or selector');
}

/**
 * A simple, three-step address wizard: find the address, confirm the pin,
 * done. Built on leaflet-control-geocoder with zone filtering.
 *
 * @param {object} options
 * @param {HTMLElement|string} options.container
 * @param {object} [options.L] - Leaflet module (defaults to window.L / bundled source).
 * @param {string} [options.zonesUrl]
 * @param {object} [options.zonesConfig]
 * @param {object} [options.api] - must provide checkDelivery(lat, lng).
 * @param {Function} [options.Geocoder] - control class (defaults to L.Control.Geocoder).
 * @param {object} [options.geocoders] - provider classes (defaults to Geocoder's statics).
 * @param {number} [options.mapHeight=440]
 * @param {Function} [options.onComplete] - receives { state, check }.
 */
export async function createAddressWizard(options = {}) {
  ensureStyles();
  const container = resolveContainer(options.container);
  const L = options.L || (typeof window !== 'undefined' && window.L);
  if (!L) throw new Error('Address wizard needs Leaflet (pass options.L)');
  const config = options.zonesConfig || await loadZones(options.zonesUrl || DEFAULT_ZONES_URL);
  const api = options.api || createApi(config);

  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'aw-wizard';
  root.innerHTML = `
    <section class="aw-step is-active" data-step="1">
      <h2 class="aw-question">Where do you live?</h2>
      <p class="aw-hint">Type your street and house number, for example <b>12 High Street</b>. Pick the address from the list.</p>
      <div class="aw-search" data-role="search"></div>
      <div class="aw-status" data-role="search-status" role="status" aria-live="polite"></div>
      <button type="button" class="aw-btn ghost" data-role="manual">I can't find my address — let me put the pin on the map</button>
    </section>
    <section class="aw-step" data-step="2">
      <h2 class="aw-question">Is this the right spot?</h2>
      <div class="aw-address-card" data-role="address"></div>
      <div class="aw-delivery" data-role="delivery"></div>
      <div class="aw-status" data-role="pin-status" role="status" aria-live="polite"></div>
      <div class="aw-map" data-role="map" style="height:${options.mapHeight || 440}px"></div>
      <button type="button" class="aw-btn primary" data-role="confirm" disabled>Yes, that's my house</button>
      <button type="button" class="aw-btn ghost" data-role="different">Different address</button>
      <button type="button" class="aw-btn ghost" data-role="gps">Use my location (GPS)</button>
      <details class="aw-note">
        <summary>Add a note for the driver (optional)</summary>
        <input type="text" data-role="instructions" placeholder="Gate code, landmark, ..." />
      </details>
    </section>
    <section class="aw-step" data-step="3">
      <h2 class="aw-question">All done</h2>
      <div class="aw-summary" data-role="summary"></div>
      <button type="button" class="aw-btn primary" data-role="finish">Continue</button>
      <button type="button" class="aw-btn ghost" data-role="restart">Start again</button>
    </section>`;
  container.appendChild(root);

  const $ = (name) => root.querySelector(`[data-role="${name}"]`);
  const state = {
    step: 1,
    address: null,
    pin: null,
    check: null,
    instructions: '',
    manual: false,
  };
  let marker = null;
  let line = null;
  let currentStep = 1;

  function status(role, text, cls = '') {
    const el = $(role);
    el.textContent = text || '';
    el.className = 'aw-status' + (cls ? ' ' + cls : '');
  }

  function showStep(n) {
    currentStep = n;
    state.step = n;
    root.querySelectorAll('.aw-step').forEach((s) => {
      s.classList.toggle('is-active', s.dataset.step === String(n));
    });
    if (n === 2) {
      later(() => {
        map.invalidateSize();
        try { map.setMinZoom(Math.max(8, map.getBoundsZoom(bounds, true))); } catch (_) {}
      }, 60);
    }
  }

  // ------------------------------------------------------------ map + zones
  const shopLL = new L.LatLng(config.shop.lat, config.shop.lng);
  const bounds = boundsForRadiusKm(L, shopLL, outerRadiusKm(config.zones));
  const map = new L.Map($('map'), { maxBounds: bounds, maxBoundsViscosity: 1.0 });
  new L.TileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
  }).addTo(map);
  new L.Marker(shopLL).addTo(map).bindPopup('Our shop');
  renderZones(map, shopLL, config.zones, L);
  map.setView(shopLL, 11);

  // ------------------------------------------------------------ address search
  const GeocoderClass = options.Geocoder || L.Control?.Geocoder;
  if (!GeocoderClass) throw new Error('Address wizard needs the geocoder control (pass options.Geocoder)');
  const providerClasses = options.geocoders || (typeof window !== 'undefined' && window['leaflet-control-geocoder']?.geocoders) || GeocoderClass;
  const geocoder = createDeliveryGeocoder({
    L, api, config, geocoders: providerClasses, streetEntries: options.streetEntries || [],
  });
  const control = new GeocoderClass({
    geocoder,
    collapsed: false,
    defaultMarkGeocode: false,
    showUniqueResult: true,
    placeholder: 'Type your street and house number',
    queryMinLength: 3,
    suggestMinLength: 3,
    suggestTimeout: 250,
    position: 'topright',
    errorMessage: '',
  });
  control.addTo(map);
  $('search').appendChild(control.getContainer());

  control.on('startsuggest startgeocode', () => {
    status('search-status', 'Looking for your address…');
  });
  control.on('finishsuggest finishgeocode', (e) => {
    if (!e.results || !e.results.length) {
      status('search-status',
        "We couldn't find that address. Try just the street name, or put the pin on the map yourself.",
        'err');
    } else {
      status('search-status', 'Tap the address you want.');
    }
  });
  control.on('errorsuggest errorgeocode', () => {
    status('search-status',
      "Address search isn't working right now. You can still put the pin on the map yourself.",
      'err');
  });
  control.on('markgeocode', (e) => selectAddress(e.geocode));

  // ------------------------------------------------------------ pin handling
  function clearPin() {
    if (marker) { map.removeLayer(marker); marker = null; }
    if (line) { map.removeLayer(line); line = null; }
    state.pin = null;
    state.check = null;
    $('confirm').disabled = true;
  }

  function updateDeliveryUI() {
    const el = $('delivery');
    if (!state.check) { el.textContent = ''; el.className = 'aw-delivery'; return; }
    const c = state.check;
    el.textContent = c.inArea
      ? (c.fee === 0 ? 'Good news — delivery is free.' : `Delivery costs R${c.fee}.`)
      : "Sorry, we don't deliver to this spot. Please move the pin or try another address.";
    el.className = 'aw-delivery ' + (c.inArea ? 'ok' : 'bad');
  }

  async function setPin(latlng, message) {
    state.pin = { lat: latlng.lat, lng: latlng.lng };
    if (!marker) {
      marker = new L.Marker(latlng, {
        draggable: true,
        icon: new L.DivIcon({
          className: 'aw-pin-icon',
          html: '<div class="aw-pin">📍</div>',
          iconSize: [56, 56],
          iconAnchor: [28, 52],
        }),
      }).addTo(map);
      marker.on('dragend', () => setPin(marker.getLatLng()));
    } else {
      marker.setLatLng(latlng);
    }
    state.check = await api.checkDelivery(latlng.lat, latlng.lng);
    updateDeliveryUI();
    $('confirm').disabled = !state.check.inArea;
    status('pin-status', message || (state.check.inArea
      ? 'You can drag the big pin if it needs to move.'
      : "That's outside our delivery area. Move the pin or choose a different address."),
      state.check.inArea ? 'ok' : 'err');
    if (line) map.removeLayer(line);
    line = new L.Polyline([shopLL, latlng], { color: '#3388ff', weight: 4, dashArray: '8,8' }).addTo(map);
    map.setView(latlng, Math.max(map.getZoom(), 16));
  }

  function selectAddress(result) {
    const p = (result.properties && result.properties.address) || {};
    state.address = {
      label: result.name,
      number: p.number || '',
      street: p.street || '',
      area: p.area || '',
    };
    state.manual = false;
    $('address').textContent = result.name;
    showStep(2);
    const msg = p.number
      ? 'We found your address. Drag the pin if it is not exactly right.'
      : 'We found the street. Drag the big pin to your house, then confirm.';
    setPin(result.center, msg);
  }

  function goManual() {
    state.address = null;
    state.manual = true;
    clearPin();
    $('address').textContent = 'Tap your house on the map';
    showStep(2);
    status('pin-status', 'Tap the map near your house. Then drag the big pin to the right spot.');
    map.setView(shopLL, 11);
  }

  map.on('click', (e) => {
    if (currentStep === 2) {
      if (state.manual) $('address').textContent = 'Check the pin on the map';
      setPin(e.latlng);
    }
  });

  // ------------------------------------------------------------ buttons
  $('manual').addEventListener('click', goManual);
  $('different').addEventListener('click', () => {
    clearPin();
    control.setQuery('');
    status('search-status', '');
    showStep(1);
  });
  $('gps').addEventListener('click', () => {
    if (!navigator.geolocation) {
      status('pin-status', 'This device cannot share its location. Tap the map instead.', 'err');
      return;
    }
    status('pin-status', 'Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (state.manual) $('address').textContent = 'Check the pin on the map';
        setPin(new L.LatLng(pos.coords.latitude, pos.coords.longitude));
      },
      (err) => status('pin-status', 'Could not find your location. Tap the map instead. (' + err.message + ')', 'err'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
  $('confirm').addEventListener('click', () => {
    if (!state.pin || !state.check || !state.check.inArea) return;
    state.instructions = $('instructions').value.trim();
    const a = state.address || {};
    $('summary').innerHTML =
      `<div><b>We'll deliver to:</b> ${a.label || 'The pin on the map'}</div>` +
      `<div><b>Distance:</b> ${state.check.distanceKm} km</div>` +
      `<div><b>Delivery:</b> ${state.check.inArea
        ? (state.check.fee === 0 ? 'Free' : 'R' + state.check.fee)
        : 'Not available'}</div>` +
      (state.instructions ? `<div><b>Note for driver:</b> ${state.instructions.replace(/[<>&]/g, '')}</div>` : '');
    showStep(3);
  });
  $('finish').addEventListener('click', () => {
    if (typeof options.onComplete === 'function') {
      options.onComplete({ state: { ...state }, check: state.check });
    }
  });
  $('restart').addEventListener('click', () => {
    clearPin();
    control.setQuery('');
    $('instructions').value = '';
    $('address').textContent = '';
    $('delivery').textContent = '';
    status('search-status', '');
    status('pin-status', '');
    showStep(1);
  });

  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }

  return {
    container,
    root,
    map,
    control,
    config,
    api,
    getState: () => ({ ...state }),
    goToStep: showStep,
    destroy: () => {
      timers.forEach(clearTimeout);
      timers.clear();
      try { control.remove(); } catch (_) {}
      try { map.remove(); } catch (_) {}
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
