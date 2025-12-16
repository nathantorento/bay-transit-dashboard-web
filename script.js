/***********************
 * CONFIG
 ***********************/
let USE_LIVE_API = false; // keep false during dev
const API_KEY = ""; // only used if USE_LIVE_API = true, keep local for now

const STOP_CODES = ["16215", "13323"];
const AUTO_REFRESH_MS = 60_000; // live fetch every 1 minute
const UI_TICK_MS = 1000; // re-render every second (no fetch)
const COOLDOWN_SECONDS = 30;

/***********************
 * STATE
 ***********************/
let cooldownRemaining = 0;
let cooldownTimerId = null;

let refreshInFlight = null; // prevents overlapping refreshes

// Fake and live data for debugging:
const fakeDataSeed = [
  { line: "J", destination: "Downtown (Inbound)", arrivals: [5, 12, 20] },
  {
    line: "33",
    destination: "SF General Hospital (Eastbound)",
    arrivals: [3, 15, 27],
  },
];

let fakeRenderedData = buildFakeRenderedData();
let liveRenderedData = []; // filled only in live mode

/***********************
 * BUTTON UI + COOLDOWN
 ***********************/
function updateModeBadge() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;

  badge.textContent = USE_LIVE_API ? "LIVE DATA" : "FAKE DATA";
  badge.className = `mode-badge ${USE_LIVE_API ? "live" : "fake"}`;
}

function setRefreshButtonState({ disabled, label }) {
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;
  btn.disabled = disabled;
  btn.textContent = label;
}

function setupModeBadgeToggle() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;

  badge.addEventListener("click", async () => {
    // Flip mode
    USE_LIVE_API = !USE_LIVE_API;

    updateModeBadge();

    // Clear cooldown state visually (optional but clean)
    setRefreshButtonState({ disabled: false, label: "Refresh" });

    // Immediately refresh in the new mode
    try {
      await refreshData();
    } catch (err) {
      console.error("Mode switch refresh failed:", err);
    }
  });
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
      await refreshData(); // mode-aware
    } catch (err) {
      console.error("Manual refresh failed:", err);
    } finally {
      startCooldown(); // cooldown applies only to the button
    }
  });
}

/***********************
 * MODE-AWARE REFRESH (NO API IN DEV MODE)
 ***********************/
async function refreshData() {
  // Prevent overlap (manual + auto firing together)
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (!USE_LIVE_API) {
      refreshFake();
      return;
    }
    await refreshLive();
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/***********************
 * FAKE PIPELINE
 ***********************/
function buildFakeRenderedData() {
  // Convert arrival minutes into Date objects relative to now
  return fakeDataSeed.map((item) => ({
    line: item.line,
    destination: item.destination,
    arrivals: item.arrivals.map((min) => new Date(Date.now() + min * 60000)),
  }));
}

function refreshFake() {
  fakeRenderedData = buildFakeRenderedData();
  renderEntriesFake();
}

/***********************
 * LIVE PIPELINE (511 API)
 ***********************/
async function fetchApiJSON(stopCode) {
  const url = new URL("https://api.511.org/transit/StopMonitoring");
  url.search = new URLSearchParams({
    api_key: API_KEY,
    agency: "SF",
    stopcode: stopCode,
    format: "json",
  }).toString();

  const res = await fetch(url);

  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid API key (401).");
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
      "API format has changed: ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit missing or not an array."
    );
  }

  for (const visit of visits) {
    const mvj = visit?.MonitoredVehicleJourney;
    if (!mvj)
      throw new Error(
        "API format has changed: MonitoredVehicleJourney missing."
      );

    const call = mvj?.MonitoredCall;
    if (!call)
      throw new Error("API format has changed: MonitoredCall missing.");

    if (!mvj.LineRef)
      throw new Error("API format has changed: LineRef missing.");
    if (!mvj.DirectionRef)
      throw new Error("API format has changed: DirectionRef missing.");
    if (!call.ExpectedArrivalTime)
      throw new Error("API format has changed: ExpectedArrivalTime missing.");
  }
}

function parseApiJSON(apiJSON) {
  const visits =
    apiJSON.ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit;
  if (visits.length === 0) return null; // successful but no predictions

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

async function refreshLive() {
  const rawList = await Promise.all(STOP_CODES.map(fetchApiJSON));
  const parsed = rawList.map(parseApiJSON).filter(Boolean); // remove nulls
  liveRenderedData = parsed;
  renderEntriesLive();
}

/***********************
 * RENDERING
 ***********************/
function updateLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;

  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  el.textContent = `Last updated: ${time}`;
}

function renderEntriesCore(list) {
  updateLastUpdated();

  const containerEl = document.getElementById("container");
  if (!containerEl) return;

  containerEl.innerHTML = "";

  const now = Date.now();
  const maxMinutes = 60; // show arrivals within next hour
  let renderedCount = 0;

  for (const item of list) {
    const minutesAway = item.arrivals
      .map((d) => Math.floor((d.getTime() - now) / 60000))
      .filter((m) => m > 0 && m <= maxMinutes);

    if (minutesAway.length === 0) continue;

    renderedCount++;

    const lineEl = document.createElement("div");
    lineEl.className = "transit-line";

    const headerRowEl = document.createElement("div");
    headerRowEl.className = "header-row";

    const logoEl = document.createElement("div");
    logoEl.className = "transit-line-logo";
    logoEl.innerHTML = `<span>${item.line}</span>`;

    const destEl = document.createElement("div");
    destEl.className = "transit-line-destination";
    destEl.innerText = item.destination;

    const arrivalsEl = document.createElement("div");
    arrivalsEl.className = "transit-line-arrivals";
    arrivalsEl.innerText = minutesAway.join(", ");

    headerRowEl.append(logoEl, destEl);
    lineEl.append(headerRowEl, arrivalsEl);
    containerEl.appendChild(lineEl);
  }

  if (renderedCount === 0) {
    containerEl.innerHTML = `
      <div class="empty-state">
        No upcoming arrivals within the next hour.
      </div>
    `;
  }
}

function renderEntriesFake() {
  renderEntriesCore(fakeRenderedData);
}

function renderEntriesLive() {
  renderEntriesCore(liveRenderedData);
}

/***********************
 * TICKERS
 ***********************/
function startUiTick() {
  // UI-only tick: never fetches, only re-renders current data
  setInterval(() => {
    if (USE_LIVE_API) renderEntriesLive();
    else renderEntriesFake();
  }, UI_TICK_MS);
}

function startAutoRefreshLive() {
  if (!USE_LIVE_API) return;

  // Fetch immediately once so you don't wait 60s
  refreshData().catch((err) =>
    console.error("Initial live refresh failed:", err)
  );

  setInterval(() => {
    refreshData().catch((err) => console.error("Auto refresh failed:", err));
  }, AUTO_REFRESH_MS);
}

/***********************
 * INIT
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  setupRefreshButton();
  setupModeBadgeToggle();

  updateModeBadge();

  // Initial render from whichever mode you’re in
  if (USE_LIVE_API) renderEntriesLive();
  else renderEntriesFake();

  startUiTick(); // updates “minutes away” without fetching
  startAutoRefreshLive(); // fetches every 60s only in live mode
});
