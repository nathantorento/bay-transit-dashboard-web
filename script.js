/***********************
 * CONFIG
 ***********************/
const DEFAULT_STOP_CODES = ["16215", "13323"];
const AUTO_REFRESH_MS = 60_000;
const UI_TICK_MS = 1000;
const COOLDOWN_SECONDS = 30;

const TOKEN_STORAGE_KEY = "bay_transit_511_token";
const STOPS_STORAGE_KEY = "bay_transit_last_stops";

const LINE_COLORS = {
  J: "#f4a300",
  K: "#67b7d1",
  L: "#6b4a9a",
  M: "#1b7f3a",
  N: "#2a5ea8",
  T: "#d4145a",
};
const DEFAULT_LINE_COLOR = "#0b1b3a"; // dark navy

/***********************
 * MODE + STATE
 ***********************/
let mode = { kind: "fake" }; // fake | live(token) | owner(password)

let cooldownRemaining = 0;
let cooldownTimerId = null;
let refreshInFlight = null;

// Fake seed stays for demo/dev
const fakeDataSeed = [
  { line: "J", destination: "Outbound", arrivals: [8, 22, 40] },
  { line: "33", destination: "Outbound", arrivals: [21, 34, 39] },
];

// This is the “source of truth” for what we display
// Each item: { key, stopCode|null, line, destination, arrivals: Date[] }
let activeRenderedData = [];

// Keep last successful live data by stopCode to prevent flicker on per-stop failures
const lastGoodByStop = new Map(); // stopCode -> item

// Inline edit state
let editingStopCode = null;
let editingValue = "";
let editingError = "";

// Add stop state
let isAddingStop = false;
let addValue = "";
let addError = "";

// DOM cache for stable updates (so inputs don’t lose focus)
const cardByKey = new Map(); // key -> { rootEl, arrivalsEl }
let lastKeys = []; // last rendered key order

/***********************
 * SMALL DOM HELPERS
 ***********************/
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.innerText = text;
  return node;
}

function isValidStopCode(s) {
  return /^\d{5}$/.test(s);
}

function isLiveMode() {
  return mode.kind === "live" || mode.kind === "owner";
}

function getLineColor(lineRef) {
  const key = String(lineRef || "").toUpperCase();
  return LINE_COLORS[key] || DEFAULT_LINE_COLOR;
}

/***********************
 * URL + STORAGE STOPS
 ***********************/
function parseStopCodesFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("stops");
  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (!parts.every(isValidStopCode)) return null;

  return parts;
}

function setStopsParamInUrl(stopCodes, { push = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("stops", stopCodes.join(","));
  if (push) history.pushState({}, "", url);
  else history.replaceState({}, "", url);
}

function loadStopsFromStorage() {
  const raw = localStorage.getItem(STOPS_STORAGE_KEY);
  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (!parts.every(isValidStopCode)) return null;

  return parts;
}

function saveStopsToStorage(stopCodes) {
  localStorage.setItem(STOPS_STORAGE_KEY, stopCodes.join(","));
}

function ensureUrlHasValidStops() {
  const params = new URLSearchParams(window.location.search);
  const hasStopsParam = params.has("stops");

  const parsed = parseStopCodesFromUrl();
  if (parsed) return parsed;

  // If stops param is missing, fall back to last-used stops
  if (!hasStopsParam) {
    const stored = loadStopsFromStorage();
    if (stored) {
      setStopsParamInUrl(stored, { push: false });
      return stored;
    }
  }

  // If stops param is invalid OR nothing stored, force defaults
  setStopsParamInUrl(DEFAULT_STOP_CODES, { push: false });
  return DEFAULT_STOP_CODES;
}

function getLiveStopCodes() {
  return ensureUrlHasValidStops();
}

/***********************
 * MODE UI
 ***********************/
function updateModeBadge() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;

  badge.textContent =
    mode.kind === "live"
      ? "LIVE DATA (TOKEN)"
      : mode.kind === "owner"
      ? "LIVE DATA (OWNER)"
      : "FAKE DATA";

  badge.className = `mode-badge ${isLiveMode() ? "live" : "fake"}`;
}

function updateLockIcon() {
  const btn = document.getElementById("lock-btn");
  if (!btn) return;
  btn.textContent = isLiveMode() ? "🔓" : "🔒";
}

function setFakeMode() {
  mode = { kind: "fake" };
  editingStopCode = null;
  editingValue = "";
  editingError = "";
  isAddingStop = false;
  addValue = "";
  addError = "";
  updateModeBadge();
  updateLockIcon();
}

function setTokenLiveMode(token) {
  mode = { kind: "live", token };
  updateModeBadge();
  updateLockIcon();
}

function setOwnerMode(password) {
  mode = { kind: "owner", password };
  updateModeBadge();
  updateLockIcon();
}

/***********************
 * TOKEN STORAGE
 ***********************/
function loadTokenFromStorage() {
  const t = localStorage.getItem(TOKEN_STORAGE_KEY);
  return t && t.trim() ? t.trim() : null;
}

function saveTokenToStorage(token) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearTokenFromStorage() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/***********************
 * MODAL
 ***********************/
function openTokenModal() {
  const overlay = document.getElementById("token-modal-overlay");
  const tokenInput = document.getElementById("token-input");
  const ownerInput = document.getElementById("owner-password-input");
  const errorEl = document.getElementById("token-error");
  if (!overlay || !tokenInput || !ownerInput || !errorEl) return;

  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  tokenInput.value = "";
  ownerInput.value = "";

  overlay.classList.remove("hidden");
  tokenInput.focus();
}

function closeTokenModal() {
  const overlay = document.getElementById("token-modal-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
}

function showModalError(msg) {
  const errorEl = document.getElementById("token-error");
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

/***********************
 * REFRESH BUTTON + COOLDOWN
 ***********************/
function setRefreshButtonState({ disabled, label }) {
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;
  btn.disabled = disabled;
  btn.textContent = label;
}

function startCooldown() {
  if (cooldownTimerId !== null) {
    clearInterval(cooldownTimerId);
    cooldownTimerId = null;
  }

  cooldownRemaining = COOLDOWN_SECONDS;
  setRefreshButtonState({
    disabled: true,
    label: `Refresh (${cooldownRemaining}s)`,
  });

  cooldownTimerId = setInterval(() => {
    cooldownRemaining -= 1;

    if (cooldownRemaining <= 0) {
      clearInterval(cooldownTimerId);
      cooldownTimerId = null;
      setRefreshButtonState({ disabled: false, label: "Refresh" });
      return;
    }

    setRefreshButtonState({
      disabled: true,
      label: `Refresh (${cooldownRemaining}s)`,
    });
  }, 1000);
}

function setupRefreshButton() {
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;

  setRefreshButtonState({ disabled: false, label: "Refresh" });

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;

    setRefreshButtonState({ disabled: true, label: "Refreshing..." });

    try {
      await refresh();
      // structural render may be needed if data shape changed
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } catch (err) {
      console.error("Manual refresh failed:", err);
    } finally {
      startCooldown();
    }
  });
}

/***********************
 * DATA SOURCES
 ***********************/
const FakeSource = {
  async refresh() {
    return fakeDataSeed.map((item, idx) => ({
      key: `fake:${idx}`,
      stopCode: null,
      line: item.line,
      destination: item.destination,
      arrivals: item.arrivals.map((min) => new Date(Date.now() + min * 60000)),
    }));
  },
};

const LiveSource = {
  async refresh(modeObj, stopCodes) {
    const fetchOne = async (code) => {
      if (modeObj.kind === "live") return fetchApiJSON(code, modeObj.token);
      return fetchApiJSONViaOwnerProxy(code, modeObj.password);
    };

    const results = await Promise.allSettled(stopCodes.map(fetchOne));

    // return a per-stop map of successes (null for failures)
    return results.map((res, idx) => {
      const stopCode = stopCodes[idx];
      if (res.status !== "fulfilled")
        return { stopCode, ok: false, parsed: null };

      const parsed = parseApiJSON(res.value);
      if (!parsed) return { stopCode, ok: false, parsed: null };

      return { stopCode, ok: true, parsed };
    });
  },
};

function getActiveSourceKind() {
  return isLiveMode() ? "live" : "fake";
}

/***********************
 * MODE-AWARE REFRESH
 ***********************/
async function refresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (getActiveSourceKind() === "fake") {
      activeRenderedData = await FakeSource.refresh();
      setLastUpdatedNow();
      return;
    }

    const stopCodes = getLiveStopCodes();
    const perStop = await LiveSource.refresh(mode, stopCodes);

    const next = [];

    for (const entry of perStop) {
      if (entry.ok) {
        const item = {
          key: `stop:${entry.stopCode}`,
          stopCode: entry.stopCode,
          line: entry.parsed.line,
          destination: entry.parsed.destination,
          arrivals: entry.parsed.arrivals,
        };
        lastGoodByStop.set(entry.stopCode, item);
        next.push(item);
        continue;
      }

      // Failure: keep last good for this stop if we have it (prevents flicker)
      const fallback = lastGoodByStop.get(entry.stopCode);
      if (fallback) next.push(fallback);
    }

    activeRenderedData = next;
    setLastUpdatedNow();
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function setLastUpdatedNow() {
  const elNode = document.getElementById("last-updated");
  if (!elNode) return;

  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  elNode.textContent = `Last updated: ${time}`;
}

/***********************
 * 511 API (direct)
 ***********************/
async function fetchApiJSON(stopCode, token) {
  const url = new URL("https://api.511.org/transit/StopMonitoring");
  url.search = new URLSearchParams({
    api_key: token,
    agency: "SF",
    stopcode: stopCode,
    format: "json",
  }).toString();

  const res = await fetch(url);

  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid API token (401).");
    if ([403, 429].includes(res.status))
      throw new Error("API token has reached its limit.");
    throw new Error(`API request failed (${res.status} ${res.statusText}).`);
  }

  const json = await res.json();
  validateStopMonitoringShape(json);
  return json;
}

/***********************
 * Owner proxy (Vercel Function)
 ***********************/
async function fetchApiJSONViaOwnerProxy(stopCode, ownerPassword) {
  const url = new URL("/api/stop-monitoring", window.location.origin);
  url.search = new URLSearchParams({ stopcode: stopCode }).toString();

  const res = await fetch(url, {
    headers: { "x-owner-password": ownerPassword },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("Owner password is incorrect.");
    throw new Error(`Proxy request failed (${res.status} ${res.statusText}).`);
  }

  const json = await res.json();
  validateStopMonitoringShape(json);
  return json;
}

/***********************
 * API SHAPE VALIDATION + PARSING
 ***********************/
function validateStopMonitoringShape(json) {
  const visits =
    json?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit;

  if (!Array.isArray(visits)) {
    throw new Error(
      "API format changed: ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit missing or not an array."
    );
  }

  for (const visit of visits) {
    const mvj = visit?.MonitoredVehicleJourney;
    if (!mvj)
      throw new Error("API format changed: MonitoredVehicleJourney missing.");

    const call = mvj?.MonitoredCall;
    if (!call) throw new Error("API format changed: MonitoredCall missing.");

    if (!mvj.LineRef) throw new Error("API format changed: LineRef missing.");
    if (!mvj.DirectionRef)
      throw new Error("API format changed: DirectionRef missing.");
    if (!call.ExpectedArrivalTime)
      throw new Error("API format changed: ExpectedArrivalTime missing.");
  }
}

function parseApiJSON(apiJSON) {
  const visits =
    apiJSON.ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit;
  if (!visits || visits.length === 0) return null;

  const mvj0 = visits[0].MonitoredVehicleJourney;
  const line = mvj0.LineRef;

  const destination =
    mvj0.DirectionRef === "IB"
      ? "Inbound"
      : mvj0.DirectionRef === "OB"
      ? "Outbound"
      : mvj0.DirectionRef;

  const arrivals = visits.map(
    (v) => new Date(v.MonitoredVehicleJourney.MonitoredCall.ExpectedArrivalTime)
  );

  return { line, destination, arrivals };
}

/***********************
 * VALIDATION HELPERS
 ***********************/
async function validateTokenOrThrow(token) {
  const firstStop = ensureUrlHasValidStops()[0];
  await fetchApiJSON(firstStop, token);
}

async function validateOwnerPasswordOrThrow(password) {
  const firstStop = ensureUrlHasValidStops()[0];
  await fetchApiJSONViaOwnerProxy(firstStop, password);
}

/***********************
 * STOP EDIT / REMOVE / ADD
 ***********************/
function applyStopEdit(oldStopCode, newStopCode) {
  const current = getLiveStopCodes();
  const idx = current.indexOf(oldStopCode);
  if (idx === -1) return;

  if (current.includes(newStopCode) && newStopCode !== oldStopCode) {
    editingError = "That stop is already in the list.";
    return;
  }

  const next = [...current];
  next[idx] = newStopCode;

  setStopsParamInUrl(next, { push: true });
  saveStopsToStorage(next);

  // close editor on save
  editingStopCode = null;
  editingValue = "";
  editingError = "";
}

function removeStopCode(stopCode) {
  const current = getLiveStopCodes();
  if (current.length <= 1) {
    editingError = "You must keep at least 1 stop.";
    return { ok: false };
  }

  const next = current.filter((s) => s !== stopCode);
  setStopsParamInUrl(next, { push: true });
  saveStopsToStorage(next);

  editingStopCode = null;
  editingValue = "";
  editingError = "";
  return { ok: true };
}

function applyAddStop(newStopCode) {
  const current = getLiveStopCodes();

  if (current.includes(newStopCode)) {
    addError = "That stop is already in the list.";
    return { ok: false };
  }

  const next = [...current, newStopCode];
  setStopsParamInUrl(next, { push: true });
  saveStopsToStorage(next);

  isAddingStop = false;
  addValue = "";
  addError = "";
  return { ok: true };
}

/***********************
 * RENDERING (STRUCTURE) — called only when needed
 ***********************/
function buildTransitLineHeader(item) {
  const headerRowEl = el("div", "header-row");

  const logoEl = el("div", "transit-line-logo");
  logoEl.style.backgroundColor = getLineColor(item.line);
  logoEl.innerHTML = `<span>${item.line}</span>`;

  const destEl = el("div", "transit-line-destination", item.destination);

  headerRowEl.append(logoEl, destEl);
  return headerRowEl;
}

function computeMinutesAway(arrivals, nowMs) {
  const maxMinutes = 60;
  return arrivals
    .map((d) => Math.floor((d.getTime() - nowMs) / 60000))
    .filter((m) => m > 0 && m <= maxMinutes);
}

function renderIfStructureChanged() {
  const containerEl = document.getElementById("container");
  if (!containerEl) return;

  const keys = activeRenderedData.map((x) => x.key);

  const same =
    keys.length === lastKeys.length && keys.every((k, i) => k === lastKeys[i]);

  if (same) {
    // structure unchanged, just sync editor + stop controls
    syncEditors();
    renderStopControls();
    return;
  }

  lastKeys = keys;
  cardByKey.clear();
  containerEl.innerHTML = "";

  for (const item of activeRenderedData) {
    const lineEl = el("div", "transit-line");
    lineEl.dataset.key = item.key;

    if (isLiveMode() && item.stopCode) {
      lineEl.classList.add("is-clickable");
      lineEl.title = "Click to edit";
      lineEl.addEventListener("click", () => {
        // Clicking the input/buttons should not trigger this (they stopPropagation)
        if (editingStopCode === item.stopCode) return;
        editingStopCode = item.stopCode;
        editingValue = item.stopCode;
        editingError = "";
        isAddingStop = false;
        addValue = "";
        addError = "";
        syncEditors(true); // focus input
      });
    }

    const arrivalsEl = el("div", "transit-line-arrivals", "");
    lineEl.append(buildTransitLineHeader(item), arrivalsEl);

    containerEl.appendChild(lineEl);
    cardByKey.set(item.key, { rootEl: lineEl, arrivalsEl });
  }

  syncEditors();
  renderStopControls();
}

function updateArrivalsInPlace() {
  const now = Date.now();
  let renderedCount = 0;

  for (const item of activeRenderedData) {
    const card = cardByKey.get(item.key);
    if (!card) continue;

    const mins = computeMinutesAway(item.arrivals, now);
    if (mins.length === 0) {
      // keep the card, just show placeholder
      card.arrivalsEl.textContent = "-, -, -";
      continue;
    }

    renderedCount += 1;
    card.arrivalsEl.textContent = mins.join(", ");
  }

  const containerEl = document.getElementById("container");
  if (!containerEl) return;

  // Show empty state only if we have no cards at all
  if (activeRenderedData.length === 0) {
    containerEl.innerHTML = `
      <div class="empty-state">
        No data yet. Try refreshing.
      </div>
    `;
    return;
  }

  // If everything is beyond 60 mins, keep cards with placeholders rather than swapping to empty state
}

function buildStopEditorRow(stopCode) {
  const editorWrap = document.createElement("div");
  editorWrap.dataset.editor = "true";

  const editorRow = el("div", "stop-editor-row");

  const label = el("div", "stop-editor-label", "Stop code");

  const input = el("input", "stop-editor-input");
  input.value = editingValue;
  input.placeholder = "e.g. 16215";

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("input", (e) => {
    editingValue = e.target.value.trim();
    editingError = "";
  });

  const actions = el("div", "stop-editor-actions");

  const saveBtn = el("button", "stop-editor-btn", "Save");
  saveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    if (!isValidStopCode(editingValue)) {
      editingError = "Stop codes must be exactly 5 digits.";
      syncEditors(true);
      return;
    }

    applyStopEdit(stopCode, editingValue);
    if (editingError) {
      syncEditors(true);
      return;
    }

    // Structure might have changed if stop code changed
    await refresh().catch(console.error);
    renderIfStructureChanged();
    updateArrivalsInPlace();
  });

  const removeBtn = el("button", "stop-editor-btn danger", "Remove");
  removeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    const result = removeStopCode(stopCode);
    if (!result.ok) {
      syncEditors(true);
      return;
    }

    await refresh().catch(console.error);
    renderIfStructureChanged();
    updateArrivalsInPlace();
  });

  const cancelBtn = el("button", "stop-editor-btn", "Cancel");
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    editingStopCode = null;
    editingValue = "";
    editingError = "";
    syncEditors(false);
  });

  actions.append(saveBtn, removeBtn, cancelBtn);
  editorRow.append(label, input, actions);
  editorWrap.appendChild(editorRow);

  if (editingError) {
    editorWrap.appendChild(el("div", "stop-editor-error", editingError));
  }

  return { editorWrap, input };
}

function syncEditors(shouldFocus) {
  // Remove any existing editor nodes
  for (const { rootEl } of cardByKey.values()) {
    rootEl.querySelectorAll('[data-editor="true"]').forEach((n) => n.remove());
  }

  if (!isLiveMode() || !editingStopCode) return;

  // Find the card for this stop
  const key = `stop:${editingStopCode}`;
  const card = cardByKey.get(key);
  if (!card) return;

  const { editorWrap, input } = buildStopEditorRow(editingStopCode);
  card.rootEl.appendChild(editorWrap);

  if (shouldFocus) {
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

function renderStopControls() {
  const controls = document.getElementById("stop-controls");
  if (!controls) return;

  if (!isLiveMode()) {
    controls.innerHTML = "";
    return;
  }

  controls.innerHTML = "";

  const addCard = el("div", "transit-line add-stop is-clickable");
  addCard.title = "Add a stop";
  addCard.addEventListener("click", () => {
    if (isAddingStop) return;
    isAddingStop = true;
    addValue = "";
    addError = "";
    editingStopCode = null;
    editingValue = "";
    editingError = "";
    renderStopControls();
  });

  const headerRowEl = el("div", "header-row");

  const logoEl = el("div", "transit-line-logo add-stop-logo");
  logoEl.innerHTML = `<span>+</span>`;

  const destEl = el("div", "transit-line-destination", "Add stop");

  headerRowEl.append(logoEl, destEl);
  addCard.appendChild(headerRowEl);
  addCard.appendChild(el("div", "transit-line-arrivals", "-, -, -"));

  controls.appendChild(addCard);

  if (!isAddingStop) return;

  const row = el("div", "stop-editor-row");
  const label = el("div", "stop-editor-label", "New stop");

  const input = el("input", "stop-editor-input");
  input.placeholder = "Enter stop code (e.g. 16215)";
  input.value = addValue;

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("input", (e) => {
    addValue = e.target.value.trim();
    addError = "";
  });

  const actions = el("div", "stop-editor-actions");

  const saveBtn = el("button", "stop-editor-btn", "Save");
  saveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!isValidStopCode(addValue)) {
      addError = "Stop codes must be exactly 5 digits.";
      renderStopControls();
      return;
    }

    const result = applyAddStop(addValue);
    if (!result.ok) {
      renderStopControls();
      return;
    }

    await refresh().catch(console.error);
    renderIfStructureChanged();
    updateArrivalsInPlace();
  });

  const cancelBtn = el("button", "stop-editor-btn", "Cancel");
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    isAddingStop = false;
    addValue = "";
    addError = "";
    renderStopControls();
  });

  actions.append(saveBtn, cancelBtn);
  row.append(label, input, actions);
  controls.appendChild(row);

  if (addError) controls.appendChild(el("div", "stop-editor-error", addError));

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/***********************
 * TICKERS
 ***********************/
function startUiTick() {
  setInterval(() => {
    // Only update arrivals text in-place. Do NOT rebuild DOM.
    updateArrivalsInPlace();
  }, UI_TICK_MS);
}

function startAutoRefreshLive() {
  setInterval(async () => {
    if (!isLiveMode()) return;
    await refresh().catch((err) => console.error("Auto refresh failed:", err));
    renderIfStructureChanged();
    updateArrivalsInPlace();
  }, AUTO_REFRESH_MS);
}

/***********************
 * URL CHANGES
 ***********************/
function setupUrlStopListener() {
  window.addEventListener("popstate", async () => {
    const stops = ensureUrlHasValidStops();

    if (!isLiveMode()) return;

    saveStopsToStorage(stops);

    // Close editors on URL nav
    editingStopCode = null;
    editingValue = "";
    editingError = "";
    isAddingStop = false;
    addValue = "";
    addError = "";

    await refresh().catch(console.error);
    renderIfStructureChanged();
    updateArrivalsInPlace();
  });
}

/***********************
 * CLICK OUTSIDE TO CLOSE EDITOR
 ***********************/
function setupClickOutsideToCloseEditor() {
  document.addEventListener("click", (e) => {
    if (!isLiveMode()) return;
    if (!editingStopCode) return;

    // If click is inside a transit line, do nothing
    if (e.target.closest(".transit-line")) return;

    editingStopCode = null;
    editingValue = "";
    editingError = "";
    syncEditors(false);
  });
}

/***********************
 * LOCK + MODAL EVENTS
 ***********************/
function setupLockAndModal() {
  const lockBtn = document.getElementById("lock-btn");
  const overlay = document.getElementById("token-modal-overlay");
  const cancelBtn = document.getElementById("token-cancel-btn");

  const tokenBtn = document.getElementById("token-save-btn");
  const tokenInput = document.getElementById("token-input");

  const ownerBtn = document.getElementById("owner-unlock-btn");
  const ownerInput = document.getElementById("owner-password-input");

  if (
    !lockBtn ||
    !overlay ||
    !cancelBtn ||
    !tokenBtn ||
    !tokenInput ||
    !ownerBtn ||
    !ownerInput
  )
    return;

  lockBtn.addEventListener("click", async () => {
    if (isLiveMode()) {
      clearTokenFromStorage();
      setFakeMode();
      await refresh().catch(console.error);
      renderIfStructureChanged();
      updateArrivalsInPlace();
      return;
    }
    openTokenModal();
  });

  cancelBtn.addEventListener("click", closeTokenModal);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTokenModal();
  });

  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tokenBtn.click();
    if (e.key === "Escape") closeTokenModal();
  });

  ownerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ownerBtn.click();
    if (e.key === "Escape") closeTokenModal();
  });

  tokenBtn.addEventListener("click", async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      showModalError("Paste a token first.");
      return;
    }

    tokenBtn.disabled = true;
    tokenBtn.textContent = "Checking...";

    try {
      const stops = ensureUrlHasValidStops();
      saveStopsToStorage(stops);

      await validateTokenOrThrow(token);

      saveTokenToStorage(token);
      setTokenLiveMode(token);

      closeTokenModal();
      await refresh();
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } catch (err) {
      console.error(err);
      showModalError(err.message || "Token failed. Try again.");
      setFakeMode();
      await refresh().catch(console.error);
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } finally {
      tokenBtn.disabled = false;
      tokenBtn.textContent = "Unlock (Token)";
    }
  });

  ownerBtn.addEventListener("click", async () => {
    const pw = ownerInput.value.trim();
    if (!pw) {
      showModalError("Enter the owner password.");
      return;
    }

    ownerBtn.disabled = true;
    ownerBtn.textContent = "Checking...";

    try {
      const stops = ensureUrlHasValidStops();
      saveStopsToStorage(stops);

      await validateOwnerPasswordOrThrow(pw);

      setOwnerMode(pw);

      closeTokenModal();
      await refresh();
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } catch (err) {
      console.error(err);
      showModalError(err.message || "Owner unlock failed.");
      setFakeMode();
      await refresh().catch(console.error);
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } finally {
      ownerBtn.disabled = false;
      ownerBtn.textContent = "Unlock (Owner)";
    }
  });
}

/***********************
 * FAKE BADGE ALERT
 ***********************/
function setupFakeBadgeAlert() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;

  badge.addEventListener("click", () => {
    if (!isLiveMode()) alert("unlock the page to view real data");
  });
}

/***********************
 * INIT
 ***********************/
document.addEventListener("DOMContentLoaded", async () => {
  setupRefreshButton();
  setupLockAndModal();
  setupUrlStopListener();
  setupClickOutsideToCloseEditor();
  setupFakeBadgeAlert();

  const stops = ensureUrlHasValidStops();
  saveStopsToStorage(stops);

  setFakeMode();

  await refresh().catch(console.error);
  renderIfStructureChanged();
  updateArrivalsInPlace();

  // auto-unlock token mode if stored token validates
  const storedToken = loadTokenFromStorage();
  if (storedToken) {
    try {
      await validateTokenOrThrow(storedToken);
      setTokenLiveMode(storedToken);
      await refresh().catch(console.error);
      renderIfStructureChanged();
      updateArrivalsInPlace();
    } catch (err) {
      console.warn("Stored token invalid, clearing.", err);
      clearTokenFromStorage();
      setFakeMode();
      await refresh().catch(console.error);
      renderIfStructureChanged();
      updateArrivalsInPlace();
    }
  }

  startUiTick();
  startAutoRefreshLive();
});
