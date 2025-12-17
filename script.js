/***********************
 * CONFIG
 ***********************/
const DEFAULT_STOP_CODES = ["16215", "13323"];
const AUTO_REFRESH_MS = 60_000;
const UI_TICK_MS = 1000;
const COOLDOWN_SECONDS = 30;

const TOKEN_STORAGE_KEY = "bay_transit_511_token";
const STOPS_STORAGE_KEY = "bay_transit_last_stops";


/***********************
 * MODE + STATE
 ***********************/
let mode = { kind: "fake" }; // {kind:"fake"} OR {kind:"live", token:string}

let cooldownRemaining = 0;
let cooldownTimerId = null;
let refreshInFlight = null;

let liveRefreshIntervalId = null;
let liveRefreshTimeoutId = null;

const fakeDataSeed = [
  { line: "J", destination: "Downtown (Inbound)", arrivals: [5, 12, 20] },
  {
    line: "33",
    destination: "SF General Hospital (Eastbound)",
    arrivals: [3, 15, 27],
  },
];

// One canonical list that UI renders from (no matter fake/live)
let activeRenderedData = [];

// Inline edit state
let editingStopCode = null;
let editingValue = "";
let editingError = "";

// Add stop state (new)
let isAddingStop = false;
let addValue = "";
let addError = "";

function msUntilNextMinute() {
  const now = new Date();
  return (
    (60 - now.getSeconds()) * 1000 -
    now.getMilliseconds()
  );
}


/***********************
 * SMALL DOM HELPERS
 ***********************/
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.innerText = text;
  return node;
}

/***********************
 * URL STOPS (with normalization)
 ***********************/
function isValidStopCode(s) {
  return /^\d{5}$/.test(s);
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

function getValidStopCodesOrDefault() {
  return parseStopCodesFromUrl() ?? DEFAULT_STOP_CODES;
}

function setStopsParamInUrl(stopCodes, { push = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("stops", stopCodes.join(","));
  if (push) history.pushState({}, "", url);
  else history.replaceState({}, "", url);
}

function ensureUrlHasValidStops() {
  const parsed = parseStopCodesFromUrl();
  if (parsed) return parsed;

  const params = new URLSearchParams(window.location.search);
  const hasStopsParam = params.has("stops");

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
  // URL is source of truth for live mode
  return ensureUrlHasValidStops();
}

/***********************
 * MODE UI
 ***********************/
function isLiveMode() {
  return mode.kind === "live";
}

function updateModeBadge() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;

  badge.textContent = isLiveMode() ? "LIVE DATA" : "FAKE DATA";
  badge.className = `mode-badge ${isLiveMode() ? "live" : "fake"}`;
}

function updateLockIcon() {
  const btn = document.getElementById("lock-btn");
  if (!btn) return;
  btn.textContent = isLiveMode() ? "🔓" : "🔒";
}

function clearInlineEditState() {
  editingStopCode = null;
  editingValue = "";
  editingError = "";
}

function clearAddStopState() {
  isAddingStop = false;
  addValue = "";
  addError = "";
}

function setFakeMode() {
  mode = { kind: "fake" };
  clearInlineEditState();
  clearAddStopState();
  updateModeBadge();
  updateLockIcon();
  stopAutoRefreshLive();
}

function setLiveMode(token) {
  mode = { kind: "live", token };
  updateModeBadge();
  updateLockIcon();
  startAutoRefreshLive();
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
  const input = document.getElementById("token-input");
  const errorEl = document.getElementById("token-error");
  if (!overlay || !input || !errorEl) return;

  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  input.value = "";

  overlay.classList.remove("hidden");
  input.focus();
}

function closeTokenModal() {
  const overlay = document.getElementById("token-modal-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
}

function showTokenError(msg) {
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
    return fakeDataSeed.map((item) => ({
      stopCode: null,
      line: item.line,
      destination: item.destination,
      arrivals: item.arrivals.map((min) => new Date(Date.now() + min * 60000)),
    }));
  },
};

const LiveSource = {
  async refresh(token, stopCodes) {
    const results = await Promise.allSettled(
      stopCodes.map((code) => fetchApiJSON(code, token))
    );

    return results.map((res, idx) => {
      const stopCode = stopCodes[idx];

      if (res.status === "fulfilled") {
        const parsedItem = parseApiJSON(res.value);
        if (!parsedItem) {
          return {
            stopCode,
            line: "—",
            destination: "No arrivals",
            arrivals: [],
          };
        }
        return { stopCode, ...parsedItem };
      }

      return {
        stopCode,
        line: "!",
        destination: `Error loading stop ${stopCode}`,
        arrivals: [],
        errorMessage: res.reason?.message || "Unknown error",
      };
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
      return;
    }

    if (!mode.token) throw new Error("Missing API token.");
    const stopCodes = getLiveStopCodes();
    activeRenderedData = await LiveSource.refresh(mode.token, stopCodes);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/***********************
 * LIVE API (511)
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
  if (visits.length === 0) return null;

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
 * TOKEN VALIDATION
 ***********************/
async function validateTokenOrThrow(token) {
  const firstStop = getValidStopCodesOrDefault()[0];
  await fetchApiJSON(firstStop, token);
}

/***********************
 * STOP EDIT / REMOVE / ADD
 ***********************/
function beginInlineEdit(stopCode) {
  editingStopCode = stopCode;
  editingValue = stopCode;
  editingError = "";
}

function applyStopEdit(oldStopCode, newStopCode) {
  const current = getLiveStopCodes();
  const idx = current.indexOf(oldStopCode);
  if (idx === -1) return;

  const next = [...current];
  next[idx] = newStopCode;

  setStopsParamInUrl(next, { push: true });
  saveStopsToStorage(next);
  clearInlineEditState();
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
  clearInlineEditState();

  return { ok: true };
}

function beginAddStop() {
  isAddingStop = true;
  addValue = "";
  addError = "";
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
  clearAddStopState();
  return { ok: true };
}

/***********************
 * RENDERING
 ***********************/
function updateLastUpdated() {
  const elNode = document.getElementById("last-updated");
  if (!elNode) return;

  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  elNode.textContent = `Last updated: ${time}`;
}

function buildTransitLineHeader(item) {
  const headerRowEl = el("div", "header-row");

  const logoEl = el("div", "transit-line-logo");
  logoEl.innerHTML = `<span>${item.line}</span>`;

  const destEl = el("div", "transit-line-destination", item.destination);

  headerRowEl.append(logoEl, destEl);
  return headerRowEl;
}

function buildArrivalsRow(minutesAway) {
  return el("div", "transit-line-arrivals", minutesAway.join(", "));
}

function buildStopEditorRow(item) {
  const editorRow = el("div", "stop-editor-row");

  const label = el("div", "stop-editor-label", "Stop code");

  const input = el("input", "stop-editor-input");
  input.value = editingValue;
  input.placeholder = "e.g. 16215";

  input.addEventListener("click", (e) => e.stopPropagation());
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
      render(activeRenderedData);
      return;
    }

    applyStopEdit(item.stopCode, editingValue);

    try {
      await refresh();
    } catch (err) {
      console.error("Refresh after stop edit failed:", err);
    }
  });

  const removeBtn = el("button", "stop-editor-btn danger", "Remove");
  removeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    const result = removeStopCode(item.stopCode);
    if (!result.ok) {
      render(activeRenderedData);
      return;
    }

    try {
      await refresh();
    } catch (err) {
      console.error("Refresh after stop removal failed:", err);
    }
  });

  const cancelBtn = el("button", "stop-editor-btn", "Cancel");
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearInlineEditState();
    render(activeRenderedData);
  });

  actions.append(saveBtn, removeBtn, cancelBtn);
  editorRow.append(label, input, actions);

  return editorRow;
}

function renderStopControls() {
  const controls = document.getElementById("stop-controls");
  if (!controls) return;

  // Fake mode: no stop editing UI at all
  if (!isLiveMode()) {
    controls.innerHTML = "";
    return;
  }

  controls.innerHTML = "";

  // Render "Add stop" as a transit-line style card
  const addCard = el("div", "transit-line add-stop is-clickable");
  addCard.title = "Add a stop";
  addCard.addEventListener("click", () => {
    if (isAddingStop) return;
    beginAddStop();
    render(activeRenderedData);
  });

  const headerRowEl = el("div", "header-row");

  const logoEl = el("div", "transit-line-logo add-stop-logo");
  logoEl.innerHTML = `<span>+</span>`;

  const destEl = el("div", "transit-line-destination", "Add stop");

  headerRowEl.append(logoEl, destEl);
  addCard.appendChild(headerRowEl);

  // Add a faint arrivals placeholder so spacing matches real cards
  const placeholderArrivals = el("div", "transit-line-arrivals", "-, -, -");
  addCard.appendChild(placeholderArrivals);

  controls.appendChild(addCard);

  // If user clicked Add stop, show the inline editor right under the card
  if (!isAddingStop) return;

  const row = el("div", "stop-editor-row");
  const label = el("div", "stop-editor-label", "New stop");

  const input = el("input", "stop-editor-input");
  input.placeholder = "Enter stop code (e.g. 16215)";
  input.value = addValue;

  input.addEventListener("input", (e) => {
    addValue = e.target.value.trim();
    addError = "";
  });

  const actions = el("div", "stop-editor-actions");

  const saveBtn = el("button", "stop-editor-btn", "Save");
  saveBtn.addEventListener("click", async () => {
    if (!isValidStopCode(addValue)) {
      addError = "Stop codes must be exactly 5 digits.";
      render(activeRenderedData);
      return;
    }

    const result = applyAddStop(addValue);
    if (!result.ok) {
      render(activeRenderedData);
      return;
    }

    try {
      await refresh();
    } catch (err) {
      console.error("Refresh after add stop failed:", err);
    }
  });

  const cancelBtn = el("button", "stop-editor-btn", "Cancel");
  cancelBtn.addEventListener("click", () => {
    clearAddStopState();
    render(activeRenderedData);
  });

  actions.append(saveBtn, cancelBtn);
  row.append(label, input, actions);

  controls.appendChild(row);

  if (addError) {
    controls.appendChild(el("div", "stop-editor-error", addError));
  }
}

function render(list) {
  updateLastUpdated();

  const containerEl = document.getElementById("container");
  if (!containerEl) return;

  containerEl.innerHTML = "";

  const now = Date.now();
  const maxMinutes = 60;
  let renderedCount = 0;

  for (const item of list) {
    const minutesAway = item.arrivals
      .map((d) => Math.floor((d.getTime() - now) / 60000))
      .filter((m) => m > 0 && m <= maxMinutes);

    if (minutesAway.length === 0) continue;
    renderedCount++;

    const lineEl = el("div", "transit-line");

    if (isLiveMode() && item.stopCode) {
      lineEl.classList.add("is-clickable");
      lineEl.title = `Click to edit stop ${item.stopCode}`;
      lineEl.addEventListener("click", () => {
        if (editingStopCode === item.stopCode) return;
        beginInlineEdit(item.stopCode);
        render(activeRenderedData);
      });
    }

    lineEl.append(buildTransitLineHeader(item), buildArrivalsRow(minutesAway));

    if (isLiveMode() && item.stopCode && editingStopCode === item.stopCode) {
      lineEl.append(buildStopEditorRow(item));
      if (editingError)
        lineEl.append(el("div", "stop-editor-error", editingError));
    }

    containerEl.appendChild(lineEl);
  }

  if (renderedCount === 0) {
    containerEl.innerHTML = `
      <div class="empty-state">
        No upcoming arrivals within the next hour.
      </div>
    `;
  }

  // Stop controls live below the list
  renderStopControls();
}

/***********************
 * TICKERS
 ***********************/
function startUiTick() {
  setInterval(() => {
    render(activeRenderedData);
  }, UI_TICK_MS);
}

function startAutoRefreshLive() {
  stopAutoRefreshLive(); // safety

  // Align first refresh to next real minute
  const delay = msUntilNextMinute();

  liveRefreshTimeoutId = setTimeout(async () => {
    if (!isLiveMode()) return;

    try {
      await refresh();
    } catch (err) {
      console.error("Aligned refresh failed:", err);
    }

    // After first aligned refresh, repeat every 60s
    liveRefreshIntervalId = setInterval(async () => {
      if (!isLiveMode()) return;
      try {
        await refresh();
      } catch (err) {
        console.error("Auto refresh failed:", err);
      }
    }, 60_000);
  }, delay);
}

function stopAutoRefreshLive() {
  if (liveRefreshTimeoutId) {
    clearTimeout(liveRefreshTimeoutId);
    liveRefreshTimeoutId = null;
  }

  if (liveRefreshIntervalId) {
    clearInterval(liveRefreshIntervalId);
    liveRefreshIntervalId = null;
  }
}

/***********************
 * URL CHANGES
 ***********************/
function setupUrlStopListener() {
  window.addEventListener("popstate", async () => {
    ensureUrlHasValidStops();

    if (isLiveMode()) saveStopsToStorage(getLiveStopCodes());

    clearInlineEditState();
    clearAddStopState();

    try {
      await refresh();
    } catch (err) {
      console.error("Refresh after URL change failed:", err);
    }
  });
}

/***********************
 * LOCK BUTTON + MODAL EVENTS
 ***********************/
function setupLockAndModal() {
  const lockBtn = document.getElementById("lock-btn");
  const overlay = document.getElementById("token-modal-overlay");
  const cancelBtn = document.getElementById("token-cancel-btn");
  const saveBtn = document.getElementById("token-save-btn");
  const input = document.getElementById("token-input");

  if (!lockBtn || !overlay || !cancelBtn || !saveBtn || !input) return;

  lockBtn.addEventListener("click", async () => {
    if (isLiveMode()) {
      clearTokenFromStorage();
      setFakeMode();
      await refresh();
      return;
    }
    openTokenModal();
  });

  cancelBtn.addEventListener("click", closeTokenModal);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTokenModal();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveBtn.click();
    if (e.key === "Escape") closeTokenModal();
  });

  saveBtn.addEventListener("click", async () => {
    const token = input.value.trim();
    if (!token) {
      showTokenError("Paste a token first.");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Checking...";

    try {
      ensureUrlHasValidStops();

      await validateTokenOrThrow(token);

      saveTokenToStorage(token);
      setLiveMode(token);

      closeTokenModal();
      await refresh();
    } catch (err) {
      console.error(err);
      showTokenError(err.message || "Token failed. Try again.");
      setFakeMode();
      await refresh();
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Unlock";
    }
  });
}

/***********************
 * INIT
 ***********************/
document.addEventListener("DOMContentLoaded", async () => {
  setupRefreshButton();
  setupLockAndModal();
  setupUrlStopListener();

  // Normalize URL immediately (forces defaults if missing/invalid)
  ensureUrlHasValidStops();

  // Default: fake mode
  setFakeMode();
  await refresh();
  render(activeRenderedData);

  // Auto-unlock if token exists and validates
  const stored = loadTokenFromStorage();
  if (stored) {
    try {
      await validateTokenOrThrow(stored);
      setLiveMode(stored);
      await refresh();
    } catch (err) {
      console.warn("Stored token invalid, clearing.", err);
      clearTokenFromStorage();
      setFakeMode();
      await refresh();
    }
  }

  startUiTick();
});
