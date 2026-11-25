(() => {
  // delivery-map/src/config.js
  async function loadZones(url = "./data/sample-zones.json") {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load zones: " + res.status);
    return res.json();
  }

  // delivery-map/src/zones.js
  function kmToM(km) {
    return km * 1e3;
  }
  function outerRadiusKm(zones) {
    return Math.max(...zones.map((z) => z.maxKm == null ? (z.minKm ?? 0) + 5 : z.maxKm), 0);
  }
  function boundsForRadiusKm(L, center, radiusKm) {
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.cos(center.lat * Math.PI / 180));
    return new L.LatLngBounds(
      new L.LatLng(center.lat - dLat, center.lng - dLng),
      new L.LatLng(center.lat + dLat, center.lng + dLng)
    );
  }
  function renderZones(map, shopLatLng, zones, L, enabled = null) {
    const layers = [];
    const active = enabled ? new Set(enabled) : new Set(zones.map((z) => z.id));
    const sorted = [...zones].sort((a, b) => (b.maxKm ?? b.minKm) - (a.maxKm ?? a.minKm));
    for (const z of sorted) {
      if (!active.has(z.id)) continue;
      const radius = kmToM(z.maxKm ?? z.minKm ?? 0);
      const circle = new L.Circle(shopLatLng, {
        radius,
        color: z.color,
        weight: 2,
        opacity: 0.9,
        fill: false,
        fillColor: z.fillColor || z.color,
        fillOpacity: 0
      });
      circle.bindTooltip(z.label, { permanent: false, direction: "center" });
      circle.addTo(map);
      layers.push({ zone: z, layer: circle });
    }
    return layers;
  }

  // delivery-map/src/api.js
  function createApi(config) {
    const shop = config.shop;
    const zones = config.zones;
    const shopLatLng = { lat: shop.lat, lng: shop.lng, distanceTo(o) {
    } };
    function haversine(a, b) {
      const R = 6371e3;
      const toRad = (x) => x * Math.PI / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    }
    return {
      /**
       * Check a coordinate against delivery zones (no-delivery first, then innermost).
       * @param {number} lat
       * @param {number} lng
       * @returns {Promise<{inArea:boolean, distanceKm:number, fee:(number|null), currency:string, zoneId:(string|null), label:string, message:string}>}
       */
      async checkDelivery(lat, lng) {
        const point = { lat, lng };
        const shopPt = { lat: shop.lat, lng: shop.lng };
        const distanceM = haversine(shopPt, point);
        const distanceKm = distanceM / 1e3;
        const noneZones = zones.filter((z) => z.type === "none" || z.fee === null);
        const noneMatch = noneZones.find((z) => {
          const min = z.minKm ?? 0;
          const max = z.maxKm == null ? Infinity : z.maxKm;
          return distanceKm >= min && distanceKm < max;
        });
        if (noneMatch) {
          return { inArea: false, distanceKm: Number(distanceKm.toFixed(2)), fee: null, currency: config.currency || "ZAR", zoneId: noneMatch.id, label: noneMatch.label || noneMatch.name, message: "No delivery available" };
        }
        const candidates = zones.filter((z) => {
          if (z.type === "none" || z.fee === null) return false;
          const min = z.minKm ?? 0;
          const max = z.maxKm == null ? Infinity : z.maxKm;
          return distanceKm >= min && distanceKm < max;
        });
        const zone = candidates.length ? candidates.reduce((a, b) => {
          const am = a.maxKm == null ? Infinity : a.maxKm;
          const bm = b.maxKm == null ? Infinity : b.maxKm;
          return am <= bm ? a : b;
        }, candidates[0]) : null;
        if (!zone) {
          return { inArea: false, distanceKm: Number(distanceKm.toFixed(2)), fee: null, currency: config.currency || "ZAR", zoneId: null, label: "Outside delivery area", message: "You are outside the delivery area" };
        }
        const eligible = zone.fee !== null;
        return {
          inArea: eligible,
          distanceKm: Number(distanceKm.toFixed(2)),
          fee: zone.fee,
          currency: config.currency || "ZAR",
          zoneId: zone.id,
          label: zone.label || zone.name,
          message: eligible ? zone.fee === 0 ? "Free delivery" : `Delivery fee R${zone.fee}` : "You are outside the delivery area"
        };
      },
      haversine
    };
  }

  // delivery-map/src/geocode/deliveryGeocoder.js
  function createDeliveryGeocoder({ L, api, config, geocoders, streetEntries = [] }) {
    const shop = new L.LatLng(config.shop.lat, config.shop.lng);
    const bounds = boundsForRadiusKm(L, shop, outerRadiusKm(config.zones));
    const viewbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((n) => Number(n.toFixed(5))).join(",");
    const photon = new geocoders.Photon({
      geocodingQueryParams: { bbox: viewbox, lat: config.shop.lat, lon: config.shop.lng }
    });
    const nominatim = new geocoders.Nominatim({
      geocodingQueryParams: { countrycodes: "za", bounded: 1, viewbox }
    });
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
    function addressParts(raw, source) {
      const p = raw.properties || {};
      if (source === "nominatim") {
        const a = p.address || {};
        return {
          number: a.house_number || "",
          street: a.road || a.pedestrian || a.footway || "",
          area: a.suburb || a.city_district || a.city || a.town || a.village || a.hamlet || "",
          region: a.state || a.region || "",
          postcode: a.postcode || ""
        };
      }
      return {
        number: p.housenumber || p.house_number || "",
        street: p.street || p.name || p.road || "",
        area: p.suburb || p.city || p.town || p.village || p.district || "",
        region: p.state || "",
        postcode: p.postcode || ""
      };
    }
    async function finalize(raw, source) {
      if (!raw || !raw.center) return null;
      const check = await api.checkDelivery(raw.center.lat, raw.center.lng);
      if (!check.inArea) return null;
      const parts = addressParts(raw, source);
      const label = [parts.number, parts.street].filter(Boolean).join(" ") || raw.name || "Selected location";
      const contextLine = [parts.area, parts.region].filter(Boolean).join(", ");
      return {
        ...raw,
        name: label,
        html: '<div class="aw-result-main">' + esc(label) + '</div><div class="aw-result-sub">' + esc([contextLine, check.label].filter(Boolean).join(" \xB7 ")) + "</div>",
        properties: { ...p_or_empty(raw.properties), source, delivery: check, address: parts }
      };
    }
    function p_or_empty(p) {
      return p && typeof p === "object" ? p : {};
    }
    async function localResult(entry) {
      const center = new L.LatLng(entry.lat, entry.lng);
      const check = await api.checkDelivery(entry.lat, entry.lng);
      if (!check.inArea) return null;
      return {
        name: entry.name,
        center,
        bbox: new L.LatLngBounds(center, center),
        html: '<div class="aw-result-main">' + esc(entry.name) + '</div><div class="aw-result-sub">' + esc(check.label || check.message || "") + "</div>",
        properties: {
          source: "local",
          address: { number: "", street: entry.name, area: "", zoneId: entry.zoneId },
          delivery: check
        }
      };
    }
    function dedupeSource(entries) {
      const seen = /* @__PURE__ */ new Set();
      return entries.filter(({ r }) => {
        if (!r || !r.center) return false;
        const key = [r.center.lat.toFixed(4), r.center.lng.toFixed(4)].join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return {
      /** As-you-type suggestions: Photon only, zone-filtered, nearest first. */
      async suggest(query, context) {
        const q = String(query || "").toLowerCase().trim();
        const local = await Promise.all(
          streetEntries.filter((e) => e.name && e.name.toLowerCase().includes(q)).map(localResult)
        );
        let raws = [];
        try {
          raws = await photon.suggest(query, context);
        } catch (_) {
        }
        const remote = await Promise.all(raws.map((r) => finalize(r, "photon")));
        const seen = /* @__PURE__ */ new Set();
        return [...local, ...remote].filter(Boolean).sort((a, b) => a.center.distanceTo(shop) - b.center.distanceTo(shop)).filter((r) => {
          const key = r.name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      },
      /** Explicit search: Nominatim first (house numbers), Photon as backup. */
      async geocode(query, context) {
        let raws = [];
        try {
          raws = (await nominatim.geocode(query, context)).map((r) => ({ r, source: "nominatim" }));
        } catch (_) {
        }
        if (raws.length < 3) {
          try {
            const extra = (await photon.geocode(query, context)).map((r) => ({ r, source: "photon" }));
            raws = dedupeSource([...raws, ...extra]);
          } catch (_) {
          }
        }
        const q = String(query || "").toLowerCase().trim();
        const local = await Promise.all(
          streetEntries.filter((e) => e.name && e.name.toLowerCase().includes(q)).map(localResult)
        );
        const out = await Promise.all(raws.map(({ r, source }) => finalize(r, source)));
        return [...local, ...out].filter(Boolean).sort((a, b) => {
          const da = a.center.distanceTo(shop);
          const db = b.center.distanceTo(shop);
          return da - db;
        });
      },
      /** Reverse lookup used for the area label; needs no zone filtering. */
      reverse(location, scale) {
        return photon.reverse(location, scale);
      }
    };
  }

  // delivery-map/src/addressWizard.js
  var DEFAULT_ZONES_URL = "/data/sample-zones.json";
  var stylesReady = false;
  var wizardSeq = 0;
  function ensureStyles() {
    if (stylesReady && document.getElementById("aw-styles")) return;
    if (!document.getElementById("aw-styles")) {
      const style = document.createElement("style");
      style.id = "aw-styles";
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
      .aw-number-field { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 12px; }
      .aw-number-field label { font-weight:800; font-size:18px; }
      .aw-number-field input { font:inherit; font-size:18px; width:140px; padding:10px 12px;
        border:2px solid #9a9a9a; border-radius:10px; }
      .aw-compact .aw-number-field { margin:0 0 8px; gap:8px; }
      .aw-compact .aw-number-field label { font-size:14px; }
      .aw-compact .aw-number-field input { font-size:14px; width:110px; padding:8px 10px;
        border-width:1.5px; border-color:#b7a58f; border-radius:8px; }
      .aw-delivery { font-size:22px; font-weight:800; padding:10px 0; }
      .aw-delivery.ok { color:#17662f; }
      .aw-delivery.bad { color:#a11; }
      .aw-map { width:100%; height:440px; border:2px solid #c9c9c9; border-radius:12px; margin:14px 0; }
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
    `;
      document.head.appendChild(style);
    }
    stylesReady = true;
  }
  function resolveContainer(container) {
    if (typeof container === "string") {
      const el = document.querySelector(container);
      if (!el) throw new Error("Address wizard container not found: " + container);
      return el;
    }
    if (container && container.nodeType === 1) return container;
    throw new Error("createAddressWizard requires a container element or selector");
  }
  async function createAddressWizard(options = {}) {
    ensureStyles();
    const container = resolveContainer(options.container);
    const L = options.L || typeof window !== "undefined" && window.L;
    if (!L) throw new Error("Address wizard needs Leaflet (pass options.L)");
    const config = options.zonesConfig || await loadZones(options.zonesUrl || DEFAULT_ZONES_URL);
    const api = options.api || createApi(config);
    container.innerHTML = "";
    const numberId = "aw-street-number-" + ++wizardSeq;
    const root = document.createElement("div");
    root.className = "aw-wizard";
    if (options.compact) root.classList.add("aw-compact");
    root.innerHTML = `
    <section class="aw-step is-active" data-step="1">
      <h2 class="aw-question">Where do you live?</h2>
      <p class="aw-hint">Type your street and house number, for example <b>12 High Street</b>. Pick the address from the list.</p>
      <div class="aw-search" data-role="search"></div>
      <div class="aw-status" data-role="search-status" role="status" aria-live="polite"></div>
      <button type="button" class="aw-btn ghost" data-role="manual">I can't find my address \u2014 let me put the pin on the map</button>
    </section>
    <section class="aw-step" data-step="2">
      <h2 class="aw-question">Is this the right spot?</h2>
      <div class="aw-address-card" data-role="address"></div>
      <div class="aw-number-field">
        <label for="${numberId}">Street number</label>
        <input id="${numberId}" type="text" data-role="number" inputmode="numeric"
          autocomplete="house-number" placeholder="e.g. 10" aria-label="Street number" />
      </div>
      <div class="aw-delivery" data-role="delivery"></div>
      <div class="aw-status" data-role="pin-status" role="status" aria-live="polite"></div>
      <div class="aw-map" data-role="map" style="height:${options.mapHeight || 440}px"></div>
      <button type="button" class="aw-btn primary" data-role="confirm" disabled>Yes, that's my house</button>
      <button type="button" class="aw-btn ghost" data-role="different">Different address</button>
      <button type="button" class="aw-btn ghost" data-role="gps">Use my location (GPS)</button>
    </section>`;
    container.appendChild(root);
    const $ = (name) => root.querySelector(`[data-role="${name}"]`);
    const state = {
      step: 1,
      address: null,
      pin: null,
      check: null,
      instructions: "",
      manual: false
    };
    let marker = null;
    let line = null;
    let currentStep = 1;
    function status(role, text, cls = "") {
      const el = $(role);
      el.textContent = text || "";
      el.className = "aw-status" + (cls ? " " + cls : "");
    }
    function addressText() {
      const a = state.address || {};
      const full = [$("number").value.trim(), a.street, a.area].filter(Boolean).join(" ");
      if (full) return full;
      return a.label || (state.manual ? "Check the pin on the map" : "Tap your house on the map");
    }
    function updateAddressCard() {
      $("address").textContent = addressText();
    }
    function showStep(n) {
      currentStep = n;
      state.step = n;
      root.querySelectorAll(".aw-step").forEach((s) => {
        s.classList.toggle("is-active", s.dataset.step === String(n));
      });
      if (n === 2) {
        later(() => {
          map.invalidateSize();
          try {
            map.setMinZoom(Math.max(8, map.getBoundsZoom(bounds, true)));
          } catch (_) {
          }
        }, 60);
      }
    }
    const shopLL = new L.LatLng(config.shop.lat, config.shop.lng);
    const bounds = boundsForRadiusKm(L, shopLL, outerRadiusKm(config.zones));
    const map = new L.Map($("map"), { maxBounds: bounds, maxBoundsViscosity: 1 });
    new L.TileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);
    new L.Marker(shopLL).addTo(map).bindPopup("Our shop");
    renderZones(map, shopLL, config.zones, L);
    map.setView(shopLL, 11);
    const GeocoderClass = options.Geocoder || L.Control?.Geocoder;
    if (!GeocoderClass) throw new Error("Address wizard needs the geocoder control (pass options.Geocoder)");
    const providerClasses = options.geocoders || typeof window !== "undefined" && window["leaflet-control-geocoder"]?.geocoders || GeocoderClass;
    const geocoder = createDeliveryGeocoder({
      L,
      api,
      config,
      geocoders: providerClasses,
      streetEntries: options.streetEntries || []
    });
    const control = new GeocoderClass({
      geocoder,
      collapsed: false,
      defaultMarkGeocode: false,
      showUniqueResult: true,
      placeholder: "Type your street and house number",
      queryMinLength: 3,
      suggestMinLength: 3,
      suggestTimeout: 250,
      position: "topright",
      errorMessage: ""
    });
    control.addTo(map);
    $("search").appendChild(control.getContainer());
    control.on("startsuggest startgeocode", () => {
      status("search-status", "Looking for your address\u2026");
    });
    control.on("finishsuggest finishgeocode", (e) => {
      if (!e.results || !e.results.length) {
        status(
          "search-status",
          "We couldn't find that address. Try just the street name, or put the pin on the map yourself.",
          "err"
        );
      } else {
        status("search-status", "Tap the address you want.");
      }
    });
    control.on("errorsuggest errorgeocode", () => {
      status(
        "search-status",
        "Address search isn't working right now. You can still put the pin on the map yourself.",
        "err"
      );
    });
    control.on("markgeocode", (e) => selectAddress(e.geocode));
    function clearPin() {
      if (marker) {
        map.removeLayer(marker);
        marker = null;
      }
      if (line) {
        map.removeLayer(line);
        line = null;
      }
      state.pin = null;
      state.check = null;
      $("confirm").disabled = true;
    }
    function updateDeliveryUI() {
      const el = $("delivery");
      if (!state.check) {
        el.textContent = "";
        el.className = "aw-delivery";
        return;
      }
      const c = state.check;
      el.textContent = c.inArea ? c.fee === 0 ? "Good news \u2014 delivery is free." : `Delivery costs R${c.fee}.` : "Sorry, we don't deliver to this spot. Please move the pin or try another address.";
      el.className = "aw-delivery " + (c.inArea ? "ok" : "bad");
    }
    async function setPin(latlng, message) {
      state.pin = { lat: latlng.lat, lng: latlng.lng };
      if (!marker) {
        marker = new L.Marker(latlng, {
          draggable: true,
          icon: new L.DivIcon({
            className: "aw-pin-icon",
            html: '<div class="aw-pin">\u{1F4CD}</div>',
            iconSize: [56, 56],
            iconAnchor: [28, 52]
          })
        }).addTo(map);
        marker.on("dragend", () => setPin(marker.getLatLng()));
      } else {
        marker.setLatLng(latlng);
      }
      state.check = await api.checkDelivery(latlng.lat, latlng.lng);
      updateDeliveryUI();
      $("confirm").disabled = !state.check.inArea;
      status(
        "pin-status",
        message || (state.check.inArea ? "You can drag the big pin if it needs to move." : "That's outside our delivery area. Move the pin or choose a different address."),
        state.check.inArea ? "ok" : "err"
      );
      if (line) map.removeLayer(line);
      line = new L.Polyline([shopLL, latlng], { color: "#3388ff", weight: 4, dashArray: "8,8" }).addTo(map);
      map.setView(latlng, Math.max(map.getZoom(), 16));
    }
    function selectAddress(result) {
      const p = result.properties && result.properties.address || {};
      state.address = {
        label: result.name,
        number: p.number || "",
        street: p.street || "",
        area: p.area || ""
      };
      state.manual = false;
      $("number").value = p.number || "";
      updateAddressCard();
      showStep(2);
      const msg = p.number ? "We found your address. Drag the pin if it is not exactly right." : "We found the street. Drag the big pin to your house, then confirm.";
      setPin(result.center, msg);
    }
    function goManual() {
      state.address = null;
      state.manual = true;
      clearPin();
      $("number").value = "";
      updateAddressCard();
      showStep(2);
      status("pin-status", "Tap the map near your house. Then drag the big pin to the right spot.");
      map.setView(shopLL, 11);
    }
    map.on("click", (e) => {
      if (currentStep === 2) {
        if (state.manual) updateAddressCard();
        setPin(e.latlng);
      }
    });
    $("number").addEventListener("input", updateAddressCard);
    $("manual").addEventListener("click", goManual);
    $("different").addEventListener("click", () => {
      clearPin();
      control.setQuery("");
      status("search-status", "");
      showStep(1);
    });
    $("gps").addEventListener("click", () => {
      if (!navigator.geolocation) {
        status("pin-status", "This device cannot share its location. Tap the map instead.", "err");
        return;
      }
      status("pin-status", "Finding your location\u2026");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (state.manual) updateAddressCard();
          setPin(new L.LatLng(pos.coords.latitude, pos.coords.longitude));
        },
        (err) => status("pin-status", "Could not find your location. Tap the map instead. (" + err.message + ")", "err"),
        { enableHighAccuracy: true, timeout: 1e4 }
      );
    });
    $("confirm").addEventListener("click", () => {
      if (!state.pin || !state.check || !state.check.inArea) return;
      const number = $("number").value.trim();
      if (number && !state.address) state.address = { label: "", street: "", area: "" };
      if (state.address) state.address.number = number;
      if (typeof options.onComplete === "function") {
        options.onComplete({ state: { ...state }, check: state.check });
      }
    });
    const timers = /* @__PURE__ */ new Set();
    function later(fn, ms) {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
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
        try {
          control.remove();
        } catch (_) {
        }
        try {
          map.remove();
        } catch (_) {
        }
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  // delivery-map/src/masterMap.js
  async function createMasterMap(options = {}) {
    const container = typeof options.container === "string" ? document.querySelector(options.container) : options.container;
    if (!container) throw new Error("Master map container not found");
    const L = options.L || window.L;
    if (!L) throw new Error("Master map needs Leaflet");
    const base = options.base || "";
    container.innerHTML = `
    <div class="dm-master" style="font-family:inherit">
      <div data-role="map" style="height:360px;width:100%;border-radius:10px;border:1px solid var(--line,#ccc)"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0">
        <button type="button" class="primary" data-role="refresh" style="padding:8px 14px">Refresh streets from OSM</button>
        <span data-role="status" style="font-size:13px;color:var(--muted,#555)">Loading\u2026</span>
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
    let config = await apiFetch("/api/delivery/zones");
    const shopLL = new L.LatLng(config.shop.lat, config.shop.lng);
    const map = new L.Map($("map"), { maxBoundsViscosity: 0.8 });
    new L.TileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);
    new L.Marker(shopLL).addTo(map).bindPopup("Our shop");
    let layers = [];
    function drawZones() {
      layers.forEach((l) => map.removeLayer(l));
      layers = [];
      for (const z of config.zones) {
        const radius = (z.maxKm == null ? z.minKm + 5 : z.maxKm) * 1e3;
        const circle = new L.Circle(shopLL, {
          radius,
          color: z.color,
          weight: 2,
          fill: false,
          opacity: 0.9
        }).addTo(map);
        circle.bindTooltip(z.label, { direction: "center" });
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
        apiFetch("/api/delivery/streets"),
        apiFetch("/api/delivery/streets/status").catch(() => ({}))
      ]);
      const counts = status.counts || {};
      $("counts").innerHTML = config.zones.map((z) => `<span style="background:${z.color}22;border:1px solid ${z.color};border-radius:12px;padding:4px 10px">${z.label}: <b>${counts[z.id] ?? 0}</b></span>`).join("");
      const groups = config.zones.map((z) => {
        const list = rows.filter((r) => r.zoneId === z.id);
        if (!list.length) return `<div style="margin:6px 0"><b>${z.label}</b> \u2014 <em>no streets yet</em></div>`;
        return `<div style="margin:6px 0"><b>${z.label}</b> (${list.length})<div style="padding-left:10px">` + list.map((r) => `${r.name}`).join(", ") + "</div></div>";
      });
      $("list").innerHTML = groups.join("");
      $("status").textContent = status.refreshedAt ? `Streets refreshed ${new Date(status.refreshedAt).toLocaleString()}${status.lastError ? " \xB7 last error: " + status.lastError : ""}` : status.lastError || "No street refresh yet.";
      return rows.length;
    }
    let streetsReady = renderStreets().catch((e) => {
      $("status").textContent = "Street list unavailable: " + e.message;
    });
    $("refresh").addEventListener("click", async () => {
      const btn = $("refresh");
      btn.disabled = true;
      $("status").textContent = "Fetching streets from OpenStreetMap \u2014 this can take a minute\u2026";
      try {
        const result = await apiFetch("/api/delivery/streets/refresh", { method: "POST" });
        config = await apiFetch("/api/delivery/zones");
        drawZones();
        await streetsReady;
        await renderStreets();
        $("status").textContent = `Done \u2014 ${result.total} streets in ${Math.round(result.durationMs / 1e3)}s.`;
      } catch (e) {
        $("status").textContent = "Refresh failed: " + e.message;
      } finally {
        btn.disabled = false;
      }
    });
    setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (_) {
      }
    }, 200);
    return {
      map,
      getConfig: () => config,
      async setZones() {
        config = await apiFetch("/api/delivery/zones");
        drawZones();
        await renderStreets();
      },
      destroy() {
        try {
          map.remove();
        } catch (_) {
        }
        if (container.firstChild) container.removeChild(container.firstChild);
      }
    };
  }

  // delivery-map/src/integration.js
  window.BeluchisDelivery = { createAddressWizard, createMasterMap };
})();
