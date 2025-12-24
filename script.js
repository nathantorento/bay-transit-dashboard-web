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
// mode variants:
// - { kind: "fake" }
// - { kind: "live", token }   (user token, persisted)
// - { kind: "owner", password } (owner password via Vercel proxy, not persisted)
let mode = { kind: "fake" };

let cooldownRemaining = 0;
let cooldownTimerId = null;
let refreshInFlight = null;

const fakeDataSeed = [
  { line: "J", destination: "Outbound", arrivals: [8, 22, 40] },
  { line: "33", destination: "Outbound", arrivals: [21, 34, 39] },
];

let activeRenderedData = [];

// inline edit state
let editingStopCode = null;
let editingValue = "";
let editingError = "";

let shouldFocusEditInput = false;

// add stop state
let isAddingStop = false;
let addValue = "";
let addError = "";

/***********************
 * SMALL DOM HELPERS
 ***********************/
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.innerText = text;
  return node;
}

function isClickInsideEditableLine(target) {
  return !!target.closest(".transit-line");
}

/***********************
 * URL + STORAGE STOPS
 ***********************/
function isValidStopCode(s) {
  return /^\d{5}$/.test(s);
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
function isLiveMode() {
  return mode.kind === "live" || mode.kind === "owner";
}

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
  async refresh(modeObj, stopCodes) {
    const fetchOne = async (code) => {
      if (modeObj.kind === "live") return fetchApiJSON(code, modeObj.token);
      return fetchApiJSONViaOwnerProxy(code, modeObj.password);
    };

    const results = await Promise.allSettled(stopCodes.map(fetchOne));

    // Do not render per-stop errors. Just keep successes.
    return results
      .map((res, idx) => {
        if (res.status !== "fulfilled") return null;
        const parsed = parseApiJSON(res.value);
        if (!parsed) return null;
        return { stopCode: stopCodes[idx], ...parsed };
      })
      .filter(Boolean);
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

    const stopCodes = getLiveStopCodes();
    activeRenderedData = await LiveSource.refresh(mode, stopCodes);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
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
    headers: {
      "x-owner-password": ownerPassword,
    },
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
function beginInlineEdit(stopCode) {
  shouldFocusEditInput = true;
  editingStopCode = stopCode;
  editingValue = stopCode;
  editingError = "";
  clearAddStopState();
}

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
  clearInlineEditState();
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

function getLineColor(lineRef) {
  const key = String(lineRef || "").toUpperCase();
  return LINE_COLORS[key] || DEFAULT_LINE_COLOR;
}

function buildTransitLineHeader(item) {
  const headerRowEl = el("div", "header-row");

  const logoEl = el("div", "transit-line-logo");
  logoEl.style.backgroundColor = getLineColor(item.line);
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
  input.id = "stop-editor-input";
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
    if (editingError) {
      render(activeRenderedData);
      return;
    }

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

  if (!isLiveMode()) {
    controls.innerHTML = "";
    return;
  }

  controls.innerHTML = "";

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

  const placeholderArrivals = el("div", "transit-line-arrivals", "-, -, -");
  addCard.appendChild(placeholderArrivals);

  controls.appendChild(addCard);

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
      lineEl.title = "Click to edit";
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
  
  if (shouldFocusEditInput) {
    shouldFocusEditInput = false;

    // wait a tick so the input exists in the DOM
    requestAnimationFrame(() => {
      const input = document.getElementById("stop-editor-input");
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  renderStopControls();
}

/***********************
 * TICKERS
 ***********************/
function startUiTick() {
  setInterval(() => render(activeRenderedData), UI_TICK_MS);
}

function startAutoRefreshLive() {
  setInterval(() => {
    if (!isLiveMode()) return;
    refresh().catch((err) => console.error("Auto refresh failed:", err));
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
  ) {
    return;
  }

  lockBtn.addEventListener("click", async () => {
    if (isLiveMode()) {
      clearTokenFromStorage(); // only affects token mode; owner mode isn't stored anyway
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
    } catch (err) {
      console.error(err);
      showModalError(err.message || "Token failed. Try again.");
      setFakeMode();
      await refresh();
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
    } catch (err) {
      console.error(err);
      showModalError(err.message || "Owner unlock failed.");
      setFakeMode();
      await refresh();
    } finally {
      ownerBtn.disabled = false;
      ownerBtn.textContent = "Unlock (Owner)";
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

  const stops = ensureUrlHasValidStops();
  saveStopsToStorage(stops);

  setFakeMode();
  await refresh();
  render(activeRenderedData);

  // auto-unlock token mode if stored token validates
  const storedToken = loadTokenFromStorage();
  if (storedToken) {
    try {
      await validateTokenOrThrow(storedToken);
      setTokenLiveMode(storedToken);
      await refresh();
    } catch (err) {
      console.warn("Stored token invalid, clearing.", err);
      clearTokenFromStorage();
      setFakeMode();
      await refresh();
    }
  }

  startUiTick();
  startAutoRefreshLive();
  document.addEventListener("click", (e) => {
    if (!isLiveMode()) return;
    if (!editingStopCode) return;

    // If click is inside a line, do nothing (line handles its own clicks)
    if (isClickInsideEditableLine(e.target)) return;

    clearInlineEditState();
    render(activeRenderedData);
  });
  
  const badge = document.getElementById("mode-badge");
  if (badge) {
    badge.addEventListener("click", () => {
      if (!isLiveMode()) {
        alert("Unlock the page to view real data.");
      }
    });
  }

});
