// Config
const cfg = window.CARGO_SITE_CONFIG || {};
const TS_BASE = (cfg.baseUrl || "https://thingspeak.mathworks.com").replace(/\/+$/, "");
const CHANNEL = cfg.channelId || "";
const R_KEY = cfg.readApiKey || "";
const FIELDS = Array.isArray(cfg.fields) && cfg.fields.length ? cfg.fields : [];

// State
let alertCount = 0;
let autoTimer = null;
let vibHistory = [];
let buzzerActive = false;
let audioCtx = null;
let buzzerNodes = [];
let latestGps = { lat: null, lng: null };
let latestReadings = {};
let accelTrend = [];
const addressCache = new Map();
const HISTORY_STORAGE_KEY = "cargoTelemetryHistory";
const HISTORY_LIMIT = 100;

function readTelemetryHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (err) {
    return [];
  }
}

function writeTelemetryHistory(history) {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatSnapshotTime(value, options) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-IN", options || {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function getReadingLevel(value, fieldCfg) {
  if (fieldCfg.warnAt === null) return "ok";
  if (value >= fieldCfg.dangerAt) return "danger";
  if (value >= fieldCfg.warnAt) return "warn";
  return "ok";
}

function getWorstLevel(levels) {
  if (levels.includes("danger")) return "danger";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

function saveTelemetrySnapshot(sourceData, readings, unsafeEvents) {
  const values = FIELDS.map(field => {
    const value = readings[field.sensorKey];
    const hasValue = Number.isFinite(value);

    return {
      key: field.sensorKey,
      title: field.title,
      unit: field.unit,
      field: field.field,
      value: hasValue ? value : null,
      level: hasValue ? getReadingLevel(value, field) : "missing"
    };
  });

  const snapshot = {
    id: sourceData.entry_id ? String(sourceData.entry_id) : String(Date.now()),
    entryId: sourceData.entry_id || null,
    capturedAt: new Date().toISOString(),
    sourceCreatedAt: sourceData.created_at || null,
    status: getWorstLevel(values.map(item => item.level)),
    values,
    unsafeEvents: unsafeEvents.map(event => ({
      title: event.title,
      value: event.value,
      unit: event.unit,
      level: event.level
    })),
    gps: Number.isFinite(latestGps.lat) && Number.isFinite(latestGps.lng)
      ? { lat: latestGps.lat, lng: latestGps.lng }
      : null
  };

  const history = readTelemetryHistory();
  const duplicateIndex = snapshot.entryId
    ? history.findIndex(item => String(item.entryId) === String(snapshot.entryId))
    : -1;

  if (duplicateIndex >= 0) {
    history.splice(duplicateIndex, 1);
  }

  history.unshift(snapshot);
  writeTelemetryHistory(history);
  renderHistoryView();
  renderAccelChart();
}

async function fetchAccelTrend() {
  const accelField = FIELDS.find(field => field.sensorKey === "accel");
  const chartEl = document.getElementById("accel-trend-chart");

  if (!CHANNEL || !accelField) return;

  if (chartEl) {
    chartEl.innerHTML = `<div class="accel-empty">Loading acceleration history...</div>`;
  }

  const params = new URLSearchParams({
    results: String(cfg.results || 60)
  });

  if (R_KEY) {
    params.set("api_key", R_KEY);
  }

  try {
    const res = await fetch(`https://api.thingspeak.com/channels/${CHANNEL}/feeds.json?${params}`);
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    const fieldKey = "field" + accelField.field;

    accelTrend = (Array.isArray(data.feeds) ? data.feeds : [])
      .map(feed => {
        const value = Number.parseFloat(feed[fieldKey]);
        if (!Number.isFinite(value)) return null;

        return {
          value,
          time: feed.created_at,
          level: getReadingLevel(value, accelField)
        };
      })
      .filter(Boolean);

    renderAccelChart();
  } catch (err) {
    if (chartEl) {
      chartEl.innerHTML = `<div class="accel-empty">Could not load ThingSpeak acceleration history. Press Refresh to retry.</div>`;
    }
  }
}

function renderAccelChart() {
  const chartEl = document.getElementById("accel-trend-chart");
  const currentEl = document.getElementById("accel-stat-current");
  const peakEl = document.getElementById("accel-stat-peak");
  const avgEl = document.getElementById("accel-stat-average");
  const stateEl = document.getElementById("accel-chart-state");
  const accelField = FIELDS.find(field => field.sensorKey === "accel");

  if (!chartEl || !accelField) return;

  let history = accelTrend.slice(-60);

  if (!history.length) {
    history = readTelemetryHistory()
    .slice(0, 24)
    .reverse()
    .map(item => {
      const reading = item.values.find(value => value.key === "accel");
      return reading && Number.isFinite(reading.value)
        ? { value: reading.value, time: item.capturedAt, level: reading.level }
        : null;
    })
    .filter(Boolean);
  }

  const liveValue = Number.isFinite(latestReadings.accel) ? latestReadings.accel : null;

  if (!history.length && liveValue !== null) {
    history.push({
      value: liveValue,
      time: new Date().toISOString(),
      level: getReadingLevel(liveValue, accelField)
    });
  }

  if (!history.length) {
    chartEl.innerHTML = `<div class="accel-empty">Refresh the dashboard to build the acceleration trend.</div>`;
    if (currentEl) currentEl.textContent = "--";
    if (peakEl) peakEl.textContent = "--";
    if (avgEl) avgEl.textContent = "--";
    if (stateEl) stateEl.textContent = "Waiting for readings";
    return;
  }

  const values = history.map(point => point.value);
  const current = values[values.length - 1];
  const peak = Math.max(...values);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minReading = Math.min(...values, 0);
  const maxReading = Math.max(...values, accelField.warnAt, accelField.dangerAt, 0);
  const paddingValue = Math.max(2, (maxReading - minReading) * 0.12);
  const minValue = Math.floor(minReading - paddingValue);
  const maxValue = Math.ceil(maxReading + paddingValue);
  const valueRange = Math.max(1, maxValue - minValue);
  const width = 900;
  const height = 320;
  const padding = { top: 26, right: 24, bottom: 46, left: 46 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const xFor = index => padding.left + (history.length === 1 ? innerWidth : (index / (history.length - 1)) * innerWidth);
  const yFor = value => {
    const bounded = Math.min(maxValue, Math.max(minValue, value));
    return padding.top + innerHeight - ((bounded - minValue) / valueRange) * innerHeight;
  };
  const zeroY = yFor(0);
  const areaPoints = history.map((point, index) => `${xFor(index).toFixed(2)},${yFor(point.value).toFixed(2)}`).join(" ");
  const areaPath = `M ${xFor(0).toFixed(2)} ${zeroY.toFixed(2)} L ${areaPoints} L ${xFor(history.length - 1).toFixed(2)} ${zeroY.toFixed(2)} Z`;
  const linePoints = areaPoints;
  const warnY = yFor(accelField.warnAt);
  const dangerY = yFor(accelField.dangerAt);
  const latestLevel = getReadingLevel(current, accelField);
  const ticks = [minValue, 0, accelField.warnAt, accelField.dangerAt, maxValue]
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .map(value => `
      <g>
        <line x1="${padding.left}" y1="${yFor(value).toFixed(2)}" x2="${width - padding.right}" y2="${yFor(value).toFixed(2)}" class="accel-grid-line" />
        <text x="12" y="${(yFor(value) + 4).toFixed(2)}" class="accel-axis-label">${value.toFixed(0)}</text>
      </g>
    `).join("");

  chartEl.innerHTML = `
    <svg class="accel-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Raw Acceleration Z trend">
      <defs>
        <linearGradient id="accelAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(80,227,194,0.38)" />
          <stop offset="100%" stop-color="rgba(80,227,194,0.02)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" class="accel-plot-bg" />
      ${ticks}
      <line x1="${padding.left}" y1="${zeroY.toFixed(2)}" x2="${width - padding.right}" y2="${zeroY.toFixed(2)}" class="accel-zero-line" />
      <line x1="${padding.left}" y1="${warnY.toFixed(2)}" x2="${width - padding.right}" y2="${warnY.toFixed(2)}" class="accel-threshold accel-warn-line" />
      <line x1="${padding.left}" y1="${dangerY.toFixed(2)}" x2="${width - padding.right}" y2="${dangerY.toFixed(2)}" class="accel-threshold accel-danger-line" />
      <text x="${width - padding.right - 70}" y="${(warnY - 7).toFixed(2)}" class="accel-threshold-label">Warn</text>
      <text x="${width - padding.right - 78}" y="${(dangerY - 7).toFixed(2)}" class="accel-threshold-label">Danger</text>
      <path d="${areaPath}" class="accel-area" />
      <polyline points="${linePoints}" class="accel-line" />
      ${history.map((point, index) => `<circle cx="${xFor(index).toFixed(2)}" cy="${yFor(point.value).toFixed(2)}" r="${index === history.length - 1 ? 6 : 4}" class="accel-dot accel-dot-${point.level}" />`).join("")}
      <text x="${padding.left}" y="${height - 16}" class="accel-axis-label">${formatSnapshotTime(history[0].time, { hour: "2-digit", minute: "2-digit" })}</text>
      <text x="${width - padding.right}" y="${height - 16}" text-anchor="end" class="accel-axis-label">${formatSnapshotTime(history[history.length - 1].time, { hour: "2-digit", minute: "2-digit" })}</text>
    </svg>
  `;

  if (currentEl) currentEl.textContent = current.toFixed(1) + " " + accelField.unit;
  if (peakEl) peakEl.textContent = peak.toFixed(1) + " " + accelField.unit;
  if (avgEl) avgEl.textContent = average.toFixed(1) + " " + accelField.unit;
  if (stateEl) {
    stateEl.className = "accel-status-pill accel-status-" + latestLevel;
    stateEl.textContent = latestLevel.toUpperCase();
  }
}

function renderHistoryView() {
  const history = readTelemetryHistory();
  const filter = document.getElementById("history-filter");
  const selectedFilter = filter ? filter.value : "all";
  const filtered = selectedFilter === "all"
    ? history
    : history.filter(item => item.status === selectedFilter);

  const totalEl = document.getElementById("history-stat-total");
  const unsafeEl = document.getElementById("history-stat-unsafe");
  const lastEl = document.getElementById("history-stat-last");
  const peakEl = document.getElementById("history-stat-peak");
  const countEl = document.getElementById("history-count-label");
  const emptyEl = document.getElementById("history-empty");
  const listEl = document.getElementById("history-list");

  const unsafeCount = history.filter(item => item.status !== "ok").length;
  const peakWeight = history.reduce((max, item) => {
    const total = item.values.find(value => value.key === "total");
    return total && Number.isFinite(total.value) ? Math.max(max, total.value) : max;
  }, 0);

  if (totalEl) totalEl.textContent = history.length;
  if (unsafeEl) unsafeEl.textContent = unsafeCount;
  if (lastEl) lastEl.textContent = history[0] ? formatSnapshotTime(history[0].capturedAt, { timeStyle: "short" }) : "--";
  if (peakEl) peakEl.textContent = peakWeight ? peakWeight.toFixed(1) + " kg" : "--";
  if (countEl) countEl.textContent = history.length + " saved reading" + (history.length === 1 ? "" : "s");

  if (!listEl || !emptyEl) return;

  emptyEl.style.display = filtered.length ? "none" : "block";

  listEl.innerHTML = filtered.map(item => {
    const visibleValues = item.values.map(value => `
      <div class="history-reading history-reading-${value.level}">
        <span>${escapeHtml(value.title)}</span>
        <strong>${value.value === null ? "--" : Number(value.value).toFixed(value.key === "lat" || value.key === "lng" ? 5 : 1)} ${escapeHtml(value.unit)}</strong>
      </div>
    `).join("");

    const alerts = item.unsafeEvents.length
      ? item.unsafeEvents.map(event => `<span>${escapeHtml(event.title)} ${escapeHtml(event.level.toUpperCase())}</span>`).join("")
      : "<span>All readings nominal</span>";

    const gps = item.gps
      ? `<a href="https://maps.google.com/?q=${item.gps.lat.toFixed(6)},${item.gps.lng.toFixed(6)}" target="_blank" rel="noreferrer">${item.gps.lat.toFixed(5)}, ${item.gps.lng.toFixed(5)}</a>`
      : "<span>No GPS fix stored</span>";

    return `
      <article class="history-card history-card-${item.status}">
        <div class="history-card-head">
          <div>
            <span class="history-kicker">Entry ${escapeHtml(item.entryId || item.id)}</span>
            <h3>${formatSnapshotTime(item.capturedAt)}</h3>
            <p>ThingSpeak time: ${formatSnapshotTime(item.sourceCreatedAt)}</p>
          </div>
          <span class="cs-badge cs-badge-${item.status}">${item.status.toUpperCase()}</span>
        </div>
        <div class="history-readings">${visibleValues}</div>
        <div class="history-meta">
          <div><strong>Alerts</strong>${alerts}</div>
          <div><strong>Location</strong>${gps}</div>
        </div>
      </article>
    `;
  }).join("");
}

function clearTelemetryHistory() {
  if (!confirm("Clear all stored telemetry snapshots from this browser?")) return;
  localStorage.removeItem(HISTORY_STORAGE_KEY);
  renderHistoryView();
}

// Web Audio buzzer
function startBuzzer() {
  if (buzzerActive) return;
  buzzerActive = true;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    function beep() {
      if (!buzzerActive) return;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = "square";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);

      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.35);

      buzzerNodes.push(osc);

      if (buzzerActive) setTimeout(beep, 700);
    }

    beep();
  } catch (e) {}

  const panel = document.getElementById("cs-buzzer-panel");
  if (panel) panel.classList.add("cs-buzzer-active");

  const btn = document.getElementById("cs-buzzer-mute");
  if (btn) btn.style.display = "inline-flex";
}

function stopBuzzer() {
  buzzerActive = false;

  buzzerNodes.forEach(n => {
    try {
      n.stop();
    } catch (e) {}
  });

  buzzerNodes = [];

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  const panel = document.getElementById("cs-buzzer-panel");
  if (panel) panel.classList.remove("cs-buzzer-active");

  const btn = document.getElementById("cs-buzzer-mute");
  if (btn) btn.style.display = "none";
}

function triggerVibrationAlert() {
  const vibField = FIELDS.find(f => f.sensorKey === "vib");
  const unit = vibField ? vibField.unit : "m/s²";
  const value = Number.isFinite(latestReadings.vib)
    ? latestReadings.vib
    : (vibField ? vibField.dangerAt : 15);

  startBuzzer();

  pushAlert(`Manual vibration alert triggered: ${value.toFixed(1)} ${unit}`, "danger");

  recordUnsafeIncident([{
    title: "Vibration (Shock)",
    value,
    unit,
    level: "danger"
  }]);
}

// Sensor card update
function updateCard(key, value, fieldCfg) {
  const card = document.getElementById("sc-card-" + key);
  const badge = document.getElementById("sc-badge-" + key);
  const val = document.getElementById("sc-val-" + key);
  const bar = document.getElementById("sc-bar-" + key);

  if (!card) return "ok";

  if (fieldCfg.warnAt === null) {
    if (val) val.textContent = value.toFixed(5);

    card.className = "cs-sensor-card cs-ok";

    if (badge) {
      badge.className = "cs-badge cs-badge-ok";
      badge.textContent = "GPS";
    }

    return "ok";
  }

  const pct = Math.min(100, (value / fieldCfg.max) * 100);
  const level = value >= fieldCfg.dangerAt
    ? "danger"
    : value >= fieldCfg.warnAt
      ? "warn"
      : "ok";

  card.className = "cs-sensor-card cs-" + level;

  if (badge) {
    badge.className = "cs-badge cs-badge-" + level;
    badge.textContent = level.toUpperCase();
  }

  if (val) val.textContent = value.toFixed(1);

  if (bar) {
    bar.className = "cs-bar-fill cs-fill-" + level;
    bar.style.width = pct + "%";
  }

  return level;
}

// Alert log
function pushAlert(msg, level) {
  const list = document.getElementById("cs-alert-list");
  if (!list) return;

  const t = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const row = document.createElement("div");
  row.className = "cs-alert-row";
  row.innerHTML = `<span class="cs-alert-time">${t}</span><span class="cs-alert-msg cs-msg-${level}">${msg}</span>`;

  list.insertBefore(row, list.firstChild);

  while (list.children.length > 40) {
    list.removeChild(list.lastChild);
  }

  alertCount++;

  const el = document.getElementById("cs-alert-count");
  if (el) el.textContent = alertCount + " alert" + (alertCount !== 1 ? "s" : "");
}

// Mini vibration bar chart
function pushVibChart(val, fieldCfg) {
  vibHistory.push(val);

  if (vibHistory.length > 20) {
    vibHistory.shift();
  }

  const charts = document.querySelectorAll("[data-vib-chart]");
  if (!charts.length) return;

  const max = Math.max(...vibHistory, 1);

  const bars = vibHistory.map(v => {
    const h = Math.max(3, (v / max) * 44);
    const c = v >= fieldCfg.dangerAt
      ? "#f85149"
      : v >= fieldCfg.warnAt
        ? "var(--accent)"
        : "rgba(80,227,194,0.6)";

    return `<div class="cs-mini-bar" style="height:${h}px;background:${c}"></div>`;
  }).join("");

  charts.forEach(wrap => {
    wrap.innerHTML = bars;
  });
}

// Vibration buzzer panel update
function updateBuzzerPanel(value, fieldCfg) {
  const panel = document.getElementById("cs-buzzer-panel");
  const valEl = document.getElementById("cs-buzzer-val");
  const subEl = document.getElementById("cs-buzzer-sub");

  if (!panel) return;

  if (valEl) valEl.textContent = value.toFixed(1) + " " + fieldCfg.unit;

  const level = value >= fieldCfg.dangerAt
    ? "danger"
    : value >= fieldCfg.warnAt
      ? "warn"
      : "ok";

  panel.dataset.level = level;

  if (level === "danger") {
    if (subEl) subEl.textContent = "EMERGENCY - Vibration critical";
    startBuzzer();
  } else {
    if (subEl) {
      subEl.textContent = level === "warn"
        ? "Elevated vibration - monitor closely"
        : "Vibration nominal";
    }

    stopBuzzer();
  }
}

// GPS map update
function updateGpsMap(lat, lng) {
  const wrap = document.getElementById("cs-gps-wrap");
  const coords = document.getElementById("cs-gps-coords");
  const mapEl = document.getElementById("cs-gps-map");
  const link = document.getElementById("cs-gps-link");
  const waiting = document.getElementById("cs-gps-waiting");

  lat = Number(lat);
  lng = Number(lng);

  if (!wrap || !mapEl || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (coords) coords.textContent = "Waiting for valid GPS data";
    if (waiting) waiting.style.display = "flex";
    return;
  }

  latestGps = { lat, lng };
  localStorage.setItem("cargoLastGps", JSON.stringify(latestGps));

  wrap.style.display = "block";
  wrap.dataset.hasLocation = "true";

  if (coords) coords.textContent = `${lat.toFixed(5)} N, ${lng.toFixed(5)} E`;
  if (waiting) waiting.style.display = "none";

  if (link) {
    link.href = `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  const src = `https://maps.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}&z=15&output=embed`;

  mapEl.src = "about:blank";

  setTimeout(() => {
    mapEl.src = src;
  }, 100);
}

// Reverse geocode address
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;

  if (addressCache.has(key)) {
    return addressCache.get(key);
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) throw new Error("Address lookup failed");

    const data = await res.json();
    const address = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    addressCache.set(key, address);

    return address;
  } catch (err) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

async function recordUnsafeIncident(events) {
  if (!events.length || latestGps.lat === null || latestGps.lng === null) return;

  const addressEl = document.getElementById("cs-incident-address");
  const coordsEl = document.getElementById("cs-incident-coords");
  const detailsEl = document.getElementById("cs-incident-details");

  if (!addressEl || !coordsEl || !detailsEl) return;

  const { lat, lng } = latestGps;
  const time = new Date().toLocaleString();

  const details = events.map(event =>
    `${event.title}: ${event.value.toFixed(1)} ${event.unit} (${event.level.toUpperCase()})`
  ).join(" | ");

  addressEl.textContent = "Looking up address...";
  coordsEl.textContent = `${lat.toFixed(5)} N, ${lng.toFixed(5)} E`;
  detailsEl.textContent = `${time} - ${details}`;

  addressEl.textContent = await reverseGeocode(lat, lng);
}

// Gauge update
function updateGauge(gaugeId, value, fieldCfg) {
  const pct = Math.min(1, value / fieldCfg.max);
  const level = value >= fieldCfg.dangerAt
    ? "danger"
    : value >= fieldCfg.warnAt
      ? "warn"
      : "ok";

  const strokeColor = level === "danger"
    ? "#f85149"
    : level === "warn"
      ? "var(--accent)"
      : "var(--secondary)";

  const angle = -90 + pct * 180;

  const needle = document.getElementById("gauge-" + gaugeId + "-needle");
  if (needle) {
    needle.setAttribute("transform", `rotate(${angle}, 100, 110)`);
  }

  const fill = document.getElementById("gauge-" + gaugeId + "-fill");

  if (fill) {
    const rad = (angle * Math.PI) / 180;
    const ex = 100 + 80 * Math.cos(rad - Math.PI / 2);
    const ey = 110 + 80 * Math.sin(rad - Math.PI / 2);
    const large = pct > 0.5 ? 1 : 0;

    fill.setAttribute(
      "d",
      pct < 0.01
        ? "M 20 110 A 80 80 0 0 1 20.01 110"
        : `M 20 110 A 80 80 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
    );

    fill.setAttribute("stroke", strokeColor);
  }

  const valEl = document.getElementById("gauge-" + gaugeId + "-val");
  if (valEl) valEl.textContent = value.toFixed(1);

  const labelEl = document.getElementById("gauge-" + gaugeId + "-label");
  if (labelEl) labelEl.textContent = value.toFixed(1) + " " + fieldCfg.unit;

  const badge = document.getElementById("gauge-" + gaugeId + "-badge");

  if (badge) {
    badge.className = "cs-badge cs-badge-" + level;
    badge.textContent = level.toUpperCase();
  }
}

function readGpsFromThingSpeak(data) {
  const latField = FIELDS.find(f => f.sensorKey === "lat");
  const lngField = FIELDS.find(f => f.sensorKey === "lng");

  const gpsSources = [
    {
      lat: data.field7,
      lng: data.field8,
      label: "field7 / field8"
    },
    {
      lat: latField ? data["field" + latField.field] : null,
      lng: lngField ? data["field" + lngField.field] : null,
      label: "config GPS fields"
    }
  ];

  for (const source of gpsSources) {
    const lat = Number.parseFloat(source.lat);
    const lng = Number.parseFloat(source.lng);

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, label: source.label };
    }
  }

  return null;
}

// ThingSpeak fetch
async function fetchLatest() {
  if (!CHANNEL) return;

  const url = `https://api.thingspeak.com/channels/${CHANNEL}/feeds/last.json?api_key=${R_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();

    let allOk = true;
    let latVal = null;
    let lngVal = null;
    const unsafeEvents = [];
    const parsedReadings = {};

    FIELDS.forEach(f => {
      const raw = Number.parseFloat(data["field" + f.field]);

      if (Number.isNaN(raw)) return;

      parsedReadings[f.sensorKey] = raw;

      if (f.sensorKey === "lat") {
        latVal = raw;
        updateCard(f.sensorKey, raw, f);
        return;
      }

      if (f.sensorKey === "lng") {
        lngVal = raw;
        updateCard(f.sensorKey, raw, f);
        return;
      }

      const lvl = updateCard(f.sensorKey, raw, f);

      if (lvl !== "ok") {
        allOk = false;
        unsafeEvents.push({
          title: f.title,
          value: raw,
          unit: f.unit,
          level: lvl
        });
      }

      if (lvl === "danger") {
        pushAlert(`${f.title} danger: ${raw.toFixed(1)} ${f.unit}`, "danger");
      } else if (lvl === "warn") {
        pushAlert(`${f.title} elevated: ${raw.toFixed(1)} ${f.unit}`, "warn");
      }

      if (f.sensorKey === "vib") {
        pushVibChart(raw, f);
        updateBuzzerPanel(raw, f);
      }

      if (f.sensorKey === "accel") {
        updateGauge("accel", raw, f);
      }

      if (["total", "front", "back"].includes(f.sensorKey)) {
        updateGauge(f.sensorKey, raw, f);
      }
    });

    latestReadings = parsedReadings;

    const gps = readGpsFromThingSpeak(data);

    if (gps) {
      console.log("GPS found from:", gps.label, gps.lat, gps.lng);
      updateGpsMap(gps.lat, gps.lng);
    } else {
      const coords = document.getElementById("cs-gps-coords");
      const savedGps = localStorage.getItem("cargoLastGps");

      if (savedGps) {
        const previousGps = JSON.parse(savedGps);
        if (coords) coords.textContent = "Using last valid GPS fix";
        updateGpsMap(previousGps.lat, previousGps.lng);
      } else if (coords) {
        coords.textContent = "No live GPS data received yet";
      }

      console.warn("No valid GPS received from ThingSpeak:", {
        field7: data.field7,
        field8: data.field8,
        allData: data
      });
    }

    recordUnsafeIncident(unsafeEvents);
    saveTelemetrySnapshot(data, parsedReadings, unsafeEvents);
    fetchAccelTrend();

    if (allOk) pushAlert("All sensors nominal", "ok");

    const ts = document.getElementById("cs-last-sync");
    if (ts) ts.textContent = "Synced " + new Date().toLocaleTimeString();
  } catch (err) {
    pushAlert("Fetch failed: " + err.message, "danger");
  }
}

// Auto-refresh toggle
function tsToggleAuto() {
  const btn = document.getElementById("cs-auto-btn");

  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;

    btn.textContent = "Auto OFF";
    btn.classList.remove("cs-btn-active");
  } else {
    fetchLatest();
    autoTimer = setInterval(fetchLatest, 15000);

    btn.textContent = "Auto ON (15s)";
    btn.classList.add("cs-btn-active");
  }
}

// Build sensor cards
function buildSensorCards() {
  const wrap = document.getElementById("cs-sensor-grid");
  if (!wrap) return;

  wrap.innerHTML = FIELDS.map(f => {
    const isGps = f.warnAt === null;

    return `
      <div class="cs-sensor-card cs-ok" id="sc-card-${f.sensorKey}">
        <div class="cs-sc-top">
          <span class="cs-sc-name">${f.title}</span>
          <span class="cs-badge cs-badge-ok" id="sc-badge-${f.sensorKey}">${isGps ? "GPS" : "NORMAL"}</span>
        </div>
        <div class="cs-sc-val" id="sc-val-${f.sensorKey}">—</div>
        <div class="cs-sc-unit">${f.unit} · Field ${f.field}</div>
        <div class="cs-sc-bar">
          <div class="cs-bar-fill cs-fill-ok" id="sc-bar-${f.sensorKey}" style="width:0%"></div>
        </div>
      </div>`;
  }).join("");
}

// Build accel chart only
function buildCharts() {
  const chartGrid = document.getElementById("chartGrid");

  if (!chartGrid) return;

  chartGrid.innerHTML = "";

  const accelField = FIELDS.find(f => f.sensorKey === "accel");

  if (!accelField) return;

  const card = document.createElement("article");
  card.className = "accel-chart-card glass chart-card-full";

  card.innerHTML = `
    <div class="accel-chart-header">
      <div>
        <span class="history-kicker">Motion Trend</span>
        <h3>${accelField.title}</h3>
        <p>${accelField.description || ""}</p>
      </div>
      <span class="accel-status-pill accel-status-ok" id="accel-chart-state">Waiting for readings</span>
    </div>
    <div class="accel-stat-row">
      <div><span>Current</span><strong id="accel-stat-current">--</strong></div>
      <div><span>Peak</span><strong id="accel-stat-peak">--</strong></div>
      <div><span>Average</span><strong id="accel-stat-average">--</strong></div>
    </div>
    <div class="accel-chart-shell" id="accel-trend-chart"></div>
  `;

  chartGrid.appendChild(card);
  renderAccelChart();
}

// Init
function renderConnectedState() {
  const el = id => document.getElementById(id);

  if (el("connectionMode")) {
    el("connectionMode").textContent = R_KEY ? "Live · API-backed" : "Live · Public";
  }

  if (el("channelLabel")) {
    el("channelLabel").textContent = "Channel " + CHANNEL;
  }

  if (el("dashboardLink")) {
    el("dashboardLink").href = cfg.dashboardUrl || `${TS_BASE}/channels/${CHANNEL}`;
  }

  buildSensorCards();
  buildCharts();
  fetchAccelTrend();
  pushAlert("Connected to channel " + CHANNEL, "ok");
}

const revealItems = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window && revealItems.length) {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add("is-visible");
        obs.unobserve(e.target);
      }
    });
  }, {
    threshold: 0.12
  });

  revealItems.forEach(el => obs.observe(el));
} else {
  revealItems.forEach(el => el.classList.add("is-visible"));
}

if (CHANNEL) {
  renderConnectedState();
}

renderHistoryView();
