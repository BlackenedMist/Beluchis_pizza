/**
 * Master map: shop pin, delivery zone circles and the OSM street list.
 * Designed to mount inside the existing admin "Deliveries" tab; it reads
 * zones/streets from the app's own API and never keeps a second copy of the
 * settings. The host page owns saving the radius/fee fields.
 */
export async function createMasterMap(options = {}) {
  const container = typeof options.container === 'string'
    ? document.querySelector(options.container)
    : options.container;
  if (!container) throw new Error('Master map container not found');
  const L = options.L || window.L;
  if (!L) throw new Error('Master map needs Leaflet');
  const base = options.base || '';

  container.innerHTML = `
    <div class="dm-master" style="font-family:inherit">
      <div data-role="map" style="height:360px;width:100%;border-radius:10px;border:1px solid var(--line,#ccc)"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0">
        <button type="button" class="primary" data-role="refresh" style="padding:8px 14px">Refresh streets from OSM</button>
        <span data-role="status" style="font-size:13px;color:var(--muted,#555)">Loading…</span>
      </div>
      <div data-role="counts" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>
      <div data-role="list" style="max-height:220px;overflow:auto;border:1px solid var(--line,#ddd);border-radius:8px;padding:8px;font-size:13px"></div>
    </div>`;
  const $ = (name) => container.querySelector(`[data-role="${name}"]`);

  const apiFetch = async (path, init) => {
    const res = await fetch(base + path, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let config = await apiFetch('/api/delivery/zones');
  const shopLL = new L.LatLng(config.shop.lat, config.shop.lng);
  const map = new L.Map($('map'), { maxBoundsViscosity: 0.8 });
  new L.TileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
  }).addTo(map);
  new L.Marker(shopLL).addTo(map).bindPopup('Our shop');
  let layers = [];

  function drawZones() {
    layers.forEach((l) => map.removeLayer(l));
    layers = [];
    for (const z of config.zones) {
      const radius = (z.maxKm == null ? z.minKm + 5 : z.maxKm) * 1000;
      const circle = new L.Circle(shopLL, {
        radius, color: z.color, weight: 2, fill: false, opacity: 0.9,
      }).addTo(map);
      circle.bindTooltip(z.label, { direction: 'center' });
      layers.push(circle);
    }
    const outerKm = config.zones.reduce((m, z) => Math.max(m, z.maxKm ?? z.minKm + 5), 0) + 2;
    const dLat = outerKm / 111.32;
    const dLng = outerKm / (111.32 * Math.cos(shopLL.lat * Math.PI / 180));
    const bounds = L.latLngBounds(
      [shopLL.lat - dLat, shopLL.lng - dLng],
      [shopLL.lat + dLat, shopLL.lng + dLng]
    );
    map.fitBounds(bounds);
  }
  drawZones();

  async function renderStreets() {
    const [rows, status] = await Promise.all([
      apiFetch('/api/delivery/streets'),
      apiFetch('/api/delivery/streets/status').catch(() => ({})),
    ]);
    const counts = status.counts || {};
    $('counts').innerHTML = config.zones.map((z) =>
      `<span style="background:${z.color}22;border:1px solid ${z.color};border-radius:12px;padding:4px 10px">` +
      `${z.label}: <b>${counts[z.id] ?? 0}</b></span>`).join('');
    const groups = config.zones.map((z) => {
      const list = rows.filter((r) => r.zoneId === z.id);
      if (!list.length) return `<div style="margin:6px 0"><b>${z.label}</b> — <em>no streets yet</em></div>`;
      return `<div style="margin:6px 0"><b>${z.label}</b> (${list.length})<div style="padding-left:10px">` +
        list.map((r) => `${r.name}`).join(', ') + '</div></div>';
    });
    $('list').innerHTML = groups.join('');
    $('status').textContent = status.refreshedAt
      ? `Streets refreshed ${new Date(status.refreshedAt).toLocaleString()}${status.lastError ? ' · last error: ' + status.lastError : ''}`
      : (status.lastError || 'No street refresh yet.');
    return rows.length;
  }
  let streetsReady = renderStreets().catch((e) => {
    $('status').textContent = 'Street list unavailable: ' + e.message;
  });

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.disabled = true;
    $('status').textContent = 'Fetching streets from OpenStreetMap — this can take a minute…';
    try {
      const result = await apiFetch('/api/delivery/streets/refresh', { method: 'POST' });
      config = await apiFetch('/api/delivery/zones');
      drawZones();
      await streetsReady;
      await renderStreets();
      $('status').textContent = `Done — ${result.total} streets in ${Math.round(result.durationMs / 1000)}s.`;
    } catch (e) {
      $('status').textContent = 'Refresh failed: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 200);

  return {
    map,
    getConfig: () => config,
    async setZones() {
      config = await apiFetch('/api/delivery/zones');
      drawZones();
      await renderStreets();
    },
    destroy() {
      try { map.remove(); } catch (_) {}
      if (container.firstChild) container.removeChild(container.firstChild);
    },
  };
}
