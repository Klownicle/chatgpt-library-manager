import {
  clearCache,
  clearFolderCache,
  getAllItems,
  getAllScans,
  getKnownSignatures
} from "./store.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

const state = {
  items: [],
  scans: [],
  connected: false,
  connectionPage: null,
  currentPath: "Library",
  viewScope: "global",
  filter: "all",
  query: "",
  sortKey: "modified",
  sortDirection: "desc",
  viewMode: "tab",
  currentManagerTab: null,
  selected: new Set(),
  scanning: false,
  navigatingFolder: false,
  deleting: false,
  deleteCalibrated: false,
  deleteCalibratedAt: null,
  deleteConcurrency: 5,
  deleteState: null,
  scanPort: null,
  scanProgress: null,
  scanError: null,
  delayMaxSeconds: 12,
  knownItemPasses: 2,
  scanMessageQueue: Promise.resolve(),
  scanReconnectTimer: null,
  previewTimer: null,
  toastTimer: null
};

const elements = {
  allCount: document.querySelector("#all-count"),
  imageCount: document.querySelector("#image-count"),
  documentCount: document.querySelector("#document-count"),
  folderTree: document.querySelector("#folder-tree"),
  cacheDot: document.querySelector("#cache-dot"),
  cacheSummary: document.querySelector("#cache-summary"),
  clearCacheButton: document.querySelector("#clear-cache-button"),
  settingsButton: document.querySelector("#settings-button"),
  statusPill: document.querySelector("#status-pill"),
  statusDetail: document.querySelector("#status-detail"),
  viewModeButton: document.querySelector("#view-mode-button"),
  reindexButton: document.querySelector("#reindex-button"),
  indexError: document.querySelector("#index-error"),
  indexErrorFolder: document.querySelector("#index-error-folder"),
  indexErrorMessage: document.querySelector("#index-error-message"),
  dismissIndexError: document.querySelector("#dismiss-index-error"),
  retryIndexButton: document.querySelector("#retry-index-button"),
  openLibraryButton: document.querySelector("#open-library-button"),
  emptyOpenButton: document.querySelector("#empty-open-button"),
  scanButton: document.querySelector("#scan-button"),
  focusLibraryButton: document.querySelector("#focus-library-button"),
  folderTitle: document.querySelector("#folder-title"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  searchInput: document.querySelector("#search-input"),
  selectionCopy: document.querySelector("#selection-copy"),
  reviewDeleteButton: document.querySelector("#review-delete-button"),
  selectAll: document.querySelector("#select-all"),
  fileBody: document.querySelector("#file-body"),
  emptyState: document.querySelector("#empty-state"),
  scanSummary: document.querySelector("#scan-summary"),
  liveScan: document.querySelector("#live-scan"),
  liveCount: document.querySelector("#live-count"),
  livePass: document.querySelector("#live-pass"),
  liveBatch: document.querySelector("#live-batch"),
  liveProgressBar: document.querySelector("#live-progress-bar"),
  liveScroll: document.querySelector("#live-scroll"),
  previewCard: document.querySelector("#preview-card"),
  previewStage: document.querySelector("#preview-stage"),
  previewName: document.querySelector("#preview-name"),
  previewMeta: document.querySelector("#preview-meta"),
  deleteModal: document.querySelector("#delete-modal"),
  deleteList: document.querySelector("#delete-list"),
  deleteTotal: document.querySelector("#delete-total"),
  closeModalButton: document.querySelector("#close-modal-button"),
  cancelDeleteButton: document.querySelector("#cancel-delete-button"),
  confirmDeleteButton: document.querySelector("#confirm-delete-button"),
  stopDeleteButton: document.querySelector("#stop-delete-button"),
  deleteWarning: document.querySelector("#delete-warning"),
  deleteProgress: document.querySelector("#delete-progress"),
  deleteProgressTitle: document.querySelector("#delete-progress-title"),
  deleteProgressCount: document.querySelector("#delete-progress-count"),
  deleteProgressBar: document.querySelector("#delete-progress-bar"),
  deleteSuccessCount: document.querySelector("#delete-success-count"),
  deleteAbsentCount: document.querySelector("#delete-absent-count"),
  deleteFailedCount: document.querySelector("#delete-failed-count"),
  deleteProgressTime: document.querySelector("#delete-progress-time"),
  deleteErrors: document.querySelector("#delete-errors"),
  settingsModal: document.querySelector("#settings-modal"),
  closeSettingsButton: document.querySelector("#close-settings-button"),
  cancelSettingsButton: document.querySelector("#cancel-settings-button"),
  saveSettingsButton: document.querySelector("#save-settings-button"),
  delaySlider: document.querySelector("#delay-slider"),
  delayRangeOutput: document.querySelector("#delay-range-output"),
  passesSlider: document.querySelector("#passes-slider"),
  passesOutput: document.querySelector("#passes-output"),
  deleteConcurrencySlider: document.querySelector("#delete-concurrency-slider"),
  deleteConcurrencyOutput: document.querySelector("#delete-concurrency-output"),
  deleteCalibrationStatus: document.querySelector("#delete-calibration-status"),
  clearDeleteCalibrationButton: document.querySelector("#clear-delete-calibration-button"),
  exportCsvButton: document.querySelector("#export-csv-button"),
  exportFileCount: document.querySelector("#export-file-count"),
  toast: document.querySelector("#toast")
};

const requestedMode = new URLSearchParams(location.search).get("mode");
state.currentManagerTab = await chrome.tabs.getCurrent().catch(() => null);
state.viewMode = requestedMode === "topdock"
  ? "topdock"
  : state.currentManagerTab?.id
    ? "tab"
    : "sidepanel";
document.body.classList.toggle("topdock-mode", state.viewMode === "topdock");
document.body.classList.toggle("undocked-mode", state.viewMode === "tab");
if (state.viewMode === "topdock") {
  window.parent.postMessage({ source: "chatgpt-library-manager-dock", type: "ready" }, "*");
}

bindEvents();
connectScanPort();
await restoreManagerLocation();
await loadSettings();
await refreshDeleteState();
await reloadCache();
await refreshConnection();
const resumedPendingIndex = await resumePendingAutoIndex();
if (!resumedPendingIndex) {
  const navigationErrorShown = await showPendingNavigationError();
  if (!navigationErrorShown) await synchronizeRememberedFolderOnLaunch();
}
setInterval(refreshConnection, 5000);

function bindEvents() {
  elements.settingsButton.addEventListener("click", openSettings);
  elements.openLibraryButton.addEventListener("click", openLibrary);
  elements.viewModeButton.addEventListener("click", toggleViewMode);
  elements.reindexButton.addEventListener("click", () => rebuildCurrentFolder(true));
  elements.retryIndexButton.addEventListener("click", () => rebuildCurrentFolder(false));
  elements.dismissIndexError.addEventListener("click", () => {
    state.scanError = null;
    render();
  });
  elements.emptyOpenButton.addEventListener("click", openLibrary);
  elements.scanButton.addEventListener("click", () => {
    if (state.scanning) cancelCurrentScan();
    else if (state.scanError) rebuildCurrentFolder(false);
    else if (state.viewMode === "tab") dockCurrentPathAndIndex();
    else indexCurrentFolder();
  });
  elements.focusLibraryButton.addEventListener("click", showSelectedInChatGPT);
  elements.clearCacheButton.addEventListener("click", clearLocalIndex);
  elements.reviewDeleteButton.addEventListener("click", openDeleteReview);
  elements.closeModalButton.addEventListener("click", closeDeleteReview);
  elements.cancelDeleteButton.addEventListener("click", closeDeleteReview);
  elements.confirmDeleteButton.addEventListener("click", deleteReviewedItem);
  elements.stopDeleteButton.addEventListener("click", stopDeleteJob);
  elements.deleteModal.addEventListener("click", (event) => {
    if (event.target === elements.deleteModal) closeDeleteReview();
  });
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.cancelSettingsButton.addEventListener("click", closeSettings);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.delaySlider.addEventListener("input", renderDelayRange);
  elements.passesSlider.addEventListener("input", renderPassesCount);
  elements.deleteConcurrencySlider.addEventListener("input", renderDeleteConcurrency);
  elements.clearDeleteCalibrationButton.addEventListener("click", clearDeleteCalibration);
  elements.exportCsvButton.addEventListener("click", exportReviewCsv);
  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) closeSettings();
  });

  elements.searchInput.addEventListener("input", () => {
    state.query = elements.searchInput.value.trim().toLowerCase();
    render();
  });

  elements.selectAll.addEventListener("change", () => {
    const files = getVisibleItems().filter((item) => item.kind === "file");
    for (const item of files) {
      if (elements.selectAll.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
    }
    render();
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.viewScope = "global";
      state.filter = button.dataset.filter;
      state.query = "";
      elements.searchInput.value = "";
      persistManagerLocation();
      render();
    });
  });

  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.sortKey === key) {
        state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDirection = key === "name" ? "asc" : "desc";
      }
      render();
    });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.searchInput.focus();
    }
    if (event.key === "Escape") {
      hidePreview();
      closeDeleteReview();
      closeSettings();
    }
  });
}

async function loadSettings() {
  try {
    const {
      scrollDelayMaxSeconds = 12,
      knownItemPasses = 2,
      deleteConcurrency = 5
    } = await chrome.storage.local.get(["scrollDelayMaxSeconds", "knownItemPasses", "deleteConcurrency"]);
    state.delayMaxSeconds = clampDelayMaximum(scrollDelayMaxSeconds);
    state.knownItemPasses = clampKnownItemPasses(knownItemPasses);
    state.deleteConcurrency = clampDeleteConcurrency(deleteConcurrency);
  } catch {
    state.delayMaxSeconds = 12;
    state.knownItemPasses = 2;
    state.deleteConcurrency = 5;
  }
  elements.delaySlider.value = String(state.delayMaxSeconds);
  elements.passesSlider.value = String(state.knownItemPasses);
  elements.deleteConcurrencySlider.value = String(state.deleteConcurrency);
  renderDelayRange();
  renderPassesCount();
  renderDeleteConcurrency();
  renderDeleteCalibrationStatus();
}

async function refreshDeleteState() {
  try {
    const result = await callBackground({ type: "manager:getDeleteState" }, false);
    state.deleteCalibrated = Boolean(result.calibrated);
    state.deleteCalibratedAt = result.calibratedAt || null;
    state.deleteConcurrency = clampDeleteConcurrency(result.concurrency);
    state.deleteState = result.deleteState || state.deleteState;
    state.deleting = ["running", "calibrating", "cancelling"].includes(state.deleteState?.status);
    renderDeleteCalibrationStatus();
  } catch {
    // The normal connection status will explain a missing background bridge.
  }
}

function openSettings() {
  elements.delaySlider.value = String(state.delayMaxSeconds);
  elements.passesSlider.value = String(state.knownItemPasses);
  elements.deleteConcurrencySlider.value = String(state.deleteConcurrency);
  renderDelayRange();
  renderPassesCount();
  renderDeleteConcurrency();
  renderDeleteCalibrationStatus();
  renderExportFileCount();
  elements.settingsModal.hidden = false;
  elements.delaySlider.focus();
}

function closeSettings() {
  elements.settingsModal.hidden = true;
}

function renderDelayRange() {
  const maximum = clampDelayMaximum(elements.delaySlider.value);
  elements.delayRangeOutput.textContent = `${maximum - 4}–${maximum} seconds`;
}

function renderPassesCount() {
  const passes = clampKnownItemPasses(elements.passesSlider.value);
  elements.passesOutput.textContent = `${passes} passes`;
}

function renderDeleteConcurrency() {
  const concurrency = clampDeleteConcurrency(elements.deleteConcurrencySlider.value);
  elements.deleteConcurrencyOutput.textContent = `${concurrency} request${concurrency === 1 ? "" : "s"}`;
}

function renderDeleteCalibrationStatus() {
  elements.deleteCalibrationStatus.textContent = state.deleteCalibrated
    ? `Calibrated ${formatRelativeTime(state.deleteCalibratedAt || Date.now())}`
    : "Not calibrated";
  elements.clearDeleteCalibrationButton.disabled = !state.deleteCalibrated || state.deleting;
}

async function clearDeleteCalibration() {
  if (state.deleting) return;
  try {
    await callBackground({ type: "manager:clearDeleteCalibration" });
    state.deleteCalibrated = false;
    state.deleteCalibratedAt = null;
    renderDeleteCalibrationStatus();
    showToast("Saved delete calibration cleared.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderExportFileCount() {
  const count = state.items.filter((item) => item.kind === "file").length;
  elements.exportFileCount.textContent = `${count.toLocaleString()} files`;
  elements.exportCsvButton.disabled = count === 0;
}

async function exportReviewCsv() {
  const files = state.items
    .filter((item) => item.kind === "file")
    .sort((a, b) => {
      const folderComparison = (a.folderPath || "Library").localeCompare(
        b.folderPath || "Library",
        undefined,
        { numeric: true, sensitivity: "base" }
      );
      if (folderComparison) return folderComparison;
      const orderA = Number.isFinite(a.sourceOrder) ? a.sourceOrder : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.sourceOrder) ? b.sourceOrder : Number.MAX_SAFE_INTEGER;
      return orderA - orderB || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  if (!files.length) {
    showToast("There are no indexed files to export.", true);
    return;
  }

  try {
    const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
    const headers = [
      "ACTION",
      "Item ID",
      "Signature",
      "Name",
      "Extension",
      "Modified",
      "Size",
      "Folder",
      "Folder URL",
      "Item URL",
      "Preview URL",
      "Remote Token",
      "Source Order",
      "Indexed At",
      "Last Seen At"
    ];
    const rows = files.map((item) => [
      "",
      item.id,
      item.signature,
      item.name,
      item.extension,
      item.modified,
      item.size,
      item.folderPath || "Library",
      folderUrlsByPath[item.folderPath || "Library"] || "",
      item.href,
      item.previewUrl,
      item.remoteToken,
      Number.isFinite(item.sourceOrder) ? item.sourceOrder : "",
      toIsoTimestamp(item.indexedAt),
      toIsoTimestamp(item.lastSeenAt)
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\r\n")}`;
    const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `chatgpt-library-review-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    showToast(`Exported ${files.length.toLocaleString()} indexed files for offline review.`);
  } catch (error) {
    if (/extension context invalidated/i.test(error.message)) showExtensionReloadRequired();
    else showToast(`Could not export the index: ${error.message}`, true);
  }
}

function toCsvCell(value) {
  const text = String(value ?? "");
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

function toIsoTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toISOString();
}

async function saveSettings() {
  const maximum = clampDelayMaximum(elements.delaySlider.value);
  const knownItemPasses = clampKnownItemPasses(elements.passesSlider.value);
  const deleteConcurrency = clampDeleteConcurrency(elements.deleteConcurrencySlider.value);
  try {
    await chrome.storage.local.set({ scrollDelayMaxSeconds: maximum, knownItemPasses, deleteConcurrency });
    state.delayMaxSeconds = maximum;
    state.knownItemPasses = knownItemPasses;
    state.deleteConcurrency = deleteConcurrency;
    closeSettings();
    showToast(`Settings saved: ${maximum - 4}–${maximum} second delay, ${knownItemPasses} verification passes, ${deleteConcurrency} delete workers.`);
  } catch (error) {
    if (/extension context invalidated/i.test(error.message)) showExtensionReloadRequired();
    else showToast(error.message, true);
  }
}

function clampDelayMaximum(value) {
  return Math.max(5, Math.min(60, Math.round(Number(value)) || 12));
}

function clampKnownItemPasses(value) {
  return Math.max(2, Math.min(100, Math.round(Number(value)) || 2));
}

function clampDeleteConcurrency(value) {
  return Math.max(1, Math.min(30, Math.round(Number(value)) || 5));
}

function connectScanPort() {
  if (state.scanPort) return state.scanPort;
  clearTimeout(state.scanReconnectTimer);

  if (!extensionContextAvailable()) {
    showExtensionReloadRequired();
    return null;
  }

  let port;
  try {
    port = chrome.runtime.connect({ name: "manager-scan" });
  } catch (error) {
    if (/extension context invalidated/i.test(error.message)) {
      showExtensionReloadRequired();
      return null;
    }
    throw error;
  }
  state.scanPort = port;
  port.onMessage.addListener((message) => {
    state.scanMessageQueue = state.scanMessageQueue
      .then(() => handleScanEvent(message))
      .catch((error) => showToast(error.message, true));
  });
  port.onDisconnect.addListener(() => {
    if (state.scanPort === port) state.scanPort = null;
    if (!extensionContextAvailable()) {
      showExtensionReloadRequired();
      return;
    }
    state.scanReconnectTimer = setTimeout(connectScanPort, 900);
  });
  try {
    const statusResult = port.postMessage({ type: "status" });
    if (statusResult && typeof statusResult.catch === "function") {
      statusResult.catch(() => {
        if (state.scanPort === port) state.scanPort = null;
      });
    }
  } catch {
    if (state.scanPort === port) state.scanPort = null;
  }
  return port;
}

function extensionContextAvailable() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function showExtensionReloadRequired() {
  clearTimeout(state.scanReconnectTimer);
  state.scanReconnectTimer = null;
  state.connected = false;
  state.scanning = false;
  elements.statusPill.classList.remove("connected");
  elements.statusPill.classList.add("disconnected");
  elements.statusPill.lastChild.textContent = "Reload required";
  elements.statusDetail.textContent = "The extension was updated. Reload the ChatGPT Library tab to reconnect.";
  elements.scanButton.disabled = true;
  elements.scanSummary.textContent = "Extension updated—reload this ChatGPT Library tab.";
}

async function handleScanEvent(message) {
  if (!message?.type) return;

  if (["delete-status", "delete-progress", "delete-complete", "delete-cancelled", "delete-error"].includes(message.type)) {
    state.deleteState = message;
    state.deleting = ["running", "calibrating", "cancelling"].includes(message.status);
    if (message.calibrated) {
      state.deleteCalibrated = true;
      state.deleteCalibratedAt = Date.now();
    }
    if (message.expiredTemplate) state.deleteCalibrated = false;
    const recentTerminal = ["complete", "cancelled", "error", "interrupted"].includes(message.status)
      && Date.now() - (message.finishedAt || message.updatedAt || 0) < 5 * 60 * 1000
      && Number(message.total || 0) > 0;
    if (state.deleting || recentTerminal || !elements.deleteModal.hidden) {
      elements.deleteModal.hidden = false;
      elements.deleteList.hidden = true;
      renderDeleteProgress();
    }
    if (["complete", "cancelled", "error", "interrupted"].includes(message.status) && !elements.deleteModal.hidden) {
      elements.stopDeleteButton.hidden = true;
      elements.cancelDeleteButton.hidden = false;
      elements.cancelDeleteButton.textContent = "Close";
      elements.closeModalButton.disabled = false;
      elements.confirmDeleteButton.hidden = true;
    }
    renderSelection();
    renderInteractionLocks();
    return;
  }

  if (message.type === "cache-items-deleted") {
    const removedIds = new Set(message.removedIds || []);
    for (const id of removedIds) state.selected.delete(id);
    state.items = state.items.filter((item) => !removedIds.has(item.id));
    render();
    if (message.removedCount && !state.deleting) {
      showToast(`${message.removedCount} deleted file${message.removedCount === 1 ? "" : "s"} removed from the local index.`);
    }
    return;
  }

  if (message.type === "progress" || (message.type === "status" && message.status === "scanning")) {
    state.scanning = true;
    closeDeleteReview();
    renderSelection();
    state.scanError = null;
    state.scanProgress = message;
    if (message.folderPath) {
      state.currentPath = normalizeFolderPath(message.folderPath);
      persistManagerLocation();
    }
    await reloadCache();
    const batchCopy = message.batchCount ? ` · +${message.batchCount} this pass` : "";
    elements.scanSummary.textContent = message.waitingForVisibility
      ? `Paused at ${message.totalObserved || 0} rows: return to the ChatGPT Library tab to resume.`
      : `Capturing live: ${message.totalObserved || 0} rows across ${message.pass || 0} passes${batchCopy}.`;
    renderConnection();
    renderLiveScan();
    return;
  }

  if (message.type === "complete" || (message.type === "status" && message.status === "complete")) {
    state.scanning = false;
    state.scanError = null;
    state.scanProgress = message;
    elements.scanButton.classList.remove("scanning");
    await reloadCache();
    const ending = message.stoppedAtKnownItem
      ? "stopped at unchanged cached items"
      : message.complete
        ? "reached and verified the end"
        : "could not prove that the end was reached";
    elements.scanSummary.textContent = `Indexed ${message.totalObserved || message.itemCount || 0} rows in ${message.passes || message.pass || 0} passes; ${ending}.`;
    renderConnection();
    renderLiveScan();
    if (message.type === "complete") showToast(`Index updated: ${message.totalObserved || message.itemCount || 0} rows observed.`);
    return;
  }

  if (message.type === "cancelled" || (message.type === "status" && message.status === "cancelled")) {
    state.scanning = false;
    state.scanError = null;
    state.scanProgress = message;
    elements.scanButton.classList.remove("scanning");
    await reloadCache();
    elements.scanSummary.textContent = `Index stopped. ${message.totalObserved || 0} captured rows were retained.`;
    renderConnection();
    renderLiveScan();
    if (message.type === "cancelled") showToast("Index stopped; captured rows were retained.");
    return;
  }

  if (message.type === "error" || (message.type === "status" && ["error", "interrupted"].includes(message.status))) {
    state.scanning = false;
    state.scanProgress = message;
    state.scanError = {
      code: message.code || (message.status === "interrupted" ? "index-interrupted" : "index-failed"),
      folderPath: message.folderPath || state.connectionPage?.folderPath || state.currentPath,
      message: message.error || "The previous index was interrupted."
    };
    elements.scanButton.classList.remove("scanning");
    elements.scanSummary.textContent = message.error || "The previous index was interrupted.";
    // Progress batches are already saved even when end verification fails.
    // Reload them so the partial folder remains visible and the sidebar stops
    // showing the stale “indexing now” state.
    await reloadCache();
    renderConnection();
    renderLiveScan();
    renderIndexError();
    if (message.type === "error") showToast(message.error || "Indexing failed.", true);
  }
}

async function reloadCache() {
  [state.items, state.scans] = await Promise.all([getAllItems(), getAllScans()]);
  state.items = state.items.filter((item) => !(
    item.kind === "folder"
    && /^(?:parent folders?|back to parent folder)$/i.test(String(item.name || "").trim())
  ));
  const validIds = new Set(state.items.filter((item) => item.kind === "file").map((item) => item.id));
  state.selected = new Set([...state.selected].filter((id) => validIds.has(id)));
  render();
}

async function refreshConnection() {
  try {
    const result = await callBackground({ type: "manager:getState" }, false);
    state.connected = Boolean(result?.connected);
    state.connectionPage = result?.page || null;
    if (result?.scanState?.status === "scanning") {
      state.scanning = true;
      state.scanProgress = result.scanState;
    }
  } catch {
    state.connected = false;
    state.connectionPage = null;
  }
  renderConnection();
}

async function openLibrary() {
  try {
    await callBackground({ type: "manager:openLibrary" });
    showToast("ChatGPT Library opened. Sign in if needed, then return here and index it.");
    setTimeout(refreshConnection, 1600);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function indexCurrentFolder() {
  if (!state.connected || state.scanning || state.navigatingFolder || state.deleting || state.viewMode === "tab") return;
  const intendedPath = normalizeFolderPath(state.currentPath || "Library");
  await refreshConnection();
  if (!state.connected) {
    showToast("The ChatGPT Library connection was lost. Reload the Library tab and try again.", true);
    return;
  }

  const livePath = normalizeFolderPath(state.connectionPage?.folderPath || "Library");
  if (livePath !== intendedPath) {
    state.navigatingFolder = true;
    elements.scanSummary.textContent = `Synchronizing ChatGPT from “${livePath}” to “${intendedPath}”…`;
    render();
    try {
      await callBackground({
        type: "manager:navigatePath",
        targetPath: intendedPath,
        chain: buildFolderChain(intendedPath),
        forceDock: true
      });
    } catch (error) {
      state.navigatingFolder = false;
      render();
      showToast(`Could not synchronize the Library folder: ${error.message}`, true);
    }
    return;
  }

  const scanPort = connectScanPort();
  if (!scanPort) return;
  state.scanning = true;
  closeDeleteReview();
  renderSelection();
  state.scanError = null;
  state.scanProgress = { totalObserved: 0, pass: 0, scroll: null };
  elements.scanButton.classList.add("scanning");
  elements.scanSummary.textContent = "Scanning the Library’s virtual list…";
  renderConnection();
  renderLiveScan();
  renderIndexError();

  try {
    const knownSignatures = await getKnownSignatures(intendedPath);
    scanPort.postMessage({
      type: "start",
      folderPath: intendedPath,
      knownSignatures,
      knownItemPasses: state.knownItemPasses,
      deep: true
    });
  } catch (error) {
    state.scanning = false;
    elements.scanButton.classList.remove("scanning");
    renderConnection();
    renderLiveScan();
    showToast(error.message, true);
  }
}

function cancelCurrentScan() {
  if (!state.scanning) return;
  const scanPort = connectScanPort();
  if (!scanPort) return;
  scanPort.postMessage({ type: "cancel" });
  elements.scanSummary.textContent = "Stopping after the current Library pass…";
}

async function rebuildCurrentFolder(askForConfirmation) {
  if (state.scanning || state.navigatingFolder || state.deleting) return;
  const folderPath = state.scanError?.folderPath
    || state.currentPath
    || state.connectionPage?.folderPath
    || "Library";
  if (askForConfirmation && !confirm(
    `Clear only the cached index for “${folderPath}” and rebuild it? No ChatGPT files will be changed.`
  )) return;
  if (!state.connected) {
    showToast("Open or reload ChatGPT Library before rebuilding this folder.", true);
    return;
  }

  const chain = buildFolderChain(folderPath);
  state.navigatingFolder = true;
  state.scanError = null;
  render();
  try {
    await clearFolderCache(folderPath);
    await reloadCache();
    await callBackground({
      type: "manager:navigatePath",
      targetPath: folderPath,
      chain,
      forceDock: true
    });
    if (state.viewMode === "tab" && state.currentManagerTab?.id) {
      await chrome.tabs.remove(state.currentManagerTab.id);
    }
  } catch (error) {
    state.navigatingFolder = false;
    state.scanError = { code: "reindex-failed", folderPath, message: error.message };
    render();
    showToast(error.message, true);
  }
}

async function openFolder(item) {
  if (state.scanning || state.navigatingFolder || state.deleting) {
    showToast("Wait for the current Library operation before opening another folder.", true);
    return;
  }

  const cachedPath = `${item.folderPath} / ${item.name}`;
  if (cachedPath === state.currentPath) {
    state.viewScope = "folder";
    state.filter = "all";
    state.query = "";
    elements.searchInput.value = "";
    persistManagerLocation();
    render();
    return;
  }
  await navigateToPath(cachedPath);
}

async function navigateToPath(targetPath) {
  if (state.scanning || state.navigatingFolder || state.deleting) return;
  if (targetPath === state.currentPath) {
    state.viewScope = "folder";
    state.filter = "all";
    state.query = "";
    elements.searchInput.value = "";
    persistManagerLocation();
    render();
    return;
  }

  const hasCachedContents = state.items.some((candidate) => candidate.folderPath === targetPath)
    || state.scans.some((scan) => scan.folderPath === targetPath);
  if (hasCachedContents) {
    state.currentPath = targetPath;
    state.viewScope = "folder";
    state.filter = "all";
    state.query = "";
    elements.searchInput.value = "";
    persistManagerLocation();
    render();
  }

  if (state.viewMode === "tab") {
    showToast(hasCachedContents
      ? `Showing cached contents for “${lastPathPart(targetPath)}”. Dock to refresh it.`
      : "That folder is not cached yet. Dock above the Library to index it.", !hasCachedContents);
    return;
  }

  if (!state.connected) {
    showToast(hasCachedContents
      ? `Showing cached contents for “${lastPathPart(targetPath)}”. Connect to ChatGPT to refresh it.`
      : "Connect to the live Library once to index this folder.", true);
    return;
  }

  state.navigatingFolder = true;
  render();
  try {
    await callBackground({
      type: "manager:navigatePath",
      targetPath,
      chain: buildFolderChain(targetPath),
      forceDock: state.viewMode === "topdock"
    });
    await resumePendingAutoIndex();
  } catch (error) {
    state.navigatingFolder = false;
    render();
    showToast(error.message, true);
  }
}

function buildFolderChain(targetPath) {
  const parts = normalizeFolderPath(targetPath).split(" / ").filter(Boolean);
  return parts.slice(1).map((name, index) => {
    const parentPath = parts.slice(0, index + 1).join(" / ");
    const cachedFolder = state.items.find((item) => (
      item.kind === "folder"
      && item.folderPath === parentPath
      && item.name === name
    ));
    return {
      id: cachedFolder?.id || "",
      name,
      href: cachedFolder?.href || "",
      path: parts.slice(0, index + 2).join(" / ")
    };
  });
}

function normalizeFolderPath(folderPath) {
  const parts = String(folderPath || "Library")
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts[0].toLowerCase() !== "library") parts.unshift("Library");
  else parts[0] = "Library";
  return parts.join(" / ");
}

async function restoreManagerLocation() {
  const { managerLocation } = await chrome.storage.local.get("managerLocation");
  if (!managerLocation?.path) return;
  state.currentPath = normalizeFolderPath(managerLocation.path);
  state.viewScope = managerLocation.viewScope === "folder" ? "folder" : "global";
  if (["all", "images", "documents"].includes(managerLocation.filter)) {
    state.filter = managerLocation.filter;
  }
}

function persistManagerLocation() {
  chrome.storage.local.set({
    managerLocation: {
      path: normalizeFolderPath(state.currentPath),
      viewScope: state.viewScope,
      filter: state.filter,
      updatedAt: Date.now()
    }
  }).catch(() => {});
}

async function resumePendingAutoIndex() {
  if (state.viewMode === "tab") return false;
  const { pendingAutoIndex } = await chrome.storage.local.get("pendingAutoIndex");
  if (!pendingAutoIndex) return false;
  await chrome.storage.local.remove("pendingAutoIndex");
  if (Date.now() - (pendingAutoIndex.createdAt || 0) > 30000) return false;

  state.currentPath = pendingAutoIndex.path || "Library";
  state.viewScope = "folder";
  state.filter = "all";
  state.query = "";
  state.navigatingFolder = false;
  persistManagerLocation();
  elements.searchInput.value = "";
  await refreshConnection();
  render();
  showToast(`Opened “${lastPathPart(state.currentPath)}”. Checking for newer files…`);
  await indexCurrentFolder();
  return true;
}

async function showPendingNavigationError() {
  let pendingNavigationError;
  try {
    ({ pendingNavigationError } = await chrome.storage.local.get("pendingNavigationError"));
    if (pendingNavigationError) await chrome.storage.local.remove("pendingNavigationError");
  } catch {
    return false;
  }
  if (!pendingNavigationError) return false;
  if (Date.now() - (pendingNavigationError.createdAt || 0) > 60000) return false;
  const message = pendingNavigationError.error
    || `Could not finish opening “${pendingNavigationError.targetPath || "that folder"}”.`;
  elements.scanSummary.textContent = `Folder navigation stopped: ${message}`;
  showToast(message, true);
  return true;
}

async function synchronizeRememberedFolderOnLaunch() {
  if (
    state.viewMode !== "topdock"
    || state.viewScope !== "folder"
    || !state.connected
    || state.scanning
    || state.navigatingFolder
  ) return false;

  const intendedPath = normalizeFolderPath(state.currentPath);
  const livePath = normalizeFolderPath(state.connectionPage?.folderPath || "Library");
  if (intendedPath === livePath) return false;

  state.navigatingFolder = true;
  elements.scanSummary.textContent = `Restoring “${intendedPath}” in ChatGPT…`;
  render();
  try {
    await callBackground({
      type: "manager:navigatePath",
      targetPath: intendedPath,
      chain: buildFolderChain(intendedPath),
      forceDock: true
    });
    return true;
  } catch (error) {
    state.navigatingFolder = false;
    elements.scanSummary.textContent = `Automatic folder restore failed: ${error.message}`;
    render();
    showToast(`Automatic folder restore failed: ${error.message}`, true);
    return false;
  }
}

async function openFile(item) {
  if (state.scanning || state.navigatingFolder || state.deleting) {
    showToast("Wait for the current Library operation before opening a file.", true);
    return;
  }
  if (!state.connected) {
    showToast("Open the ChatGPT Library to activate this file.", true);
    return;
  }
  try {
    await callBackground({ type: "manager:openItem", id: item.id, name: item.name });
    await callBackground({ type: "manager:focusLibrary" });
  } catch (error) {
    showToast(error.message, true);
  }
}

function render() {
  const files = state.items.filter((item) => item.kind === "file");
  const images = files.filter((item) => IMAGE_EXTENSIONS.has(item.extension));
  elements.allCount.textContent = String(files.length);
  elements.imageCount.textContent = String(images.length);
  elements.documentCount.textContent = String(files.length - images.length);

  const lastScan = [...state.scans].sort((a, b) => b.scannedAt - a.scannedAt)[0];
  elements.cacheDot.classList.toggle("ready", state.items.length > 0);
  elements.cacheSummary.textContent = state.scanning
    ? `${state.items.length.toLocaleString()} rows · indexing now`
    : lastScan
      ? `${state.items.length.toLocaleString()} cached rows · updated ${formatRelativeTime(lastScan.scannedAt)}`
      : state.items.length > 0
        ? `${state.items.length.toLocaleString()} cached rows · partial index`
        : "No local index yet";

  document.body.classList.toggle("search-mode", Boolean(state.query));
  document.body.classList.toggle("global-mode", !state.query && state.viewScope === "global");
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", state.viewScope === "global" && button.dataset.filter === state.filter && !state.query);
  });
  elements.folderTitle.textContent = state.query
    ? "Search results"
    : state.viewScope === "global"
      ? state.filter === "images"
        ? "All indexed images"
        : state.filter === "documents"
          ? "All indexed documents"
          : "All indexed files"
      : lastPathPart(state.currentPath);
  renderViewMode();
  renderIndexError();
  renderSortHeaders();
  renderBreadcrumbs();
  renderFolderTree();
  renderRows();
  renderSelection();
}

function renderIndexError() {
  elements.indexError.hidden = !state.scanError;
  if (!state.scanError) return;
  elements.indexErrorFolder.textContent = `“${state.scanError.folderPath || state.currentPath}”`;
  elements.indexErrorMessage.textContent = state.scanError.message || "ChatGPT did not finish loading its files.";
}

function renderViewMode() {
  elements.viewModeButton.textContent = state.viewMode === "tab" ? "Dock above Library" : "Undock";
  elements.viewModeButton.title = state.viewMode === "tab"
    ? "Move this manager into a horizontal dock above ChatGPT Library"
    : "Open the manager in a normal full-width tab";
}

function renderSortHeaders() {
  document.querySelectorAll(".sort-button").forEach((button) => {
    const active = button.dataset.sort === state.sortKey;
    button.classList.toggle("active", active);
    button.querySelector(".sort-arrow").textContent = active
      ? state.sortDirection === "asc" ? "↑" : "↓"
      : "";
    button.setAttribute("aria-sort", active
      ? state.sortDirection === "asc" ? "ascending" : "descending"
      : "none");
  });
}

function renderConnection() {
  const connected = state.connected;
  const intendedPath = normalizeFolderPath(state.currentPath || "Library");
  const livePath = normalizeFolderPath(state.connectionPage?.folderPath || "Library");
  const folderMismatch = connected && intendedPath !== livePath;
  const hasFolderCache = currentFolderHasCache();
  elements.statusPill.classList.toggle("connected", connected);
  elements.statusPill.classList.toggle("disconnected", !connected);
  elements.statusPill.lastChild.textContent = connected ? "Connected" : "Not connected";
  elements.statusPill.title = connected
    ? "The extension can communicate with the open ChatGPT Library tab."
    : "No responsive ChatGPT Library tab was found.";
  elements.statusDetail.textContent = state.scanning
    ? state.scanProgress?.waitingForVisibility
      ? `${state.scanProgress?.totalObserved || 0} rows captured; waiting for the Library tab to be visible.`
      : `${state.scanProgress?.totalObserved || 0} rows captured; live indexing is active.`
    : connected && state.viewMode === "tab"
      ? folderMismatch
        ? `Undocked cached view · ChatGPT is at ${livePath}; dock to synchronize with ${intendedPath}.`
        : `Undocked cached view · Connected to ${livePath}; dock to index or refresh.`
    : connected
      ? folderMismatch
        ? `Manager: ${intendedPath} · ChatGPT: ${livePath}. The folder will be synchronized before indexing.`
        : `${livePath} is ready for indexing.`
      : "Open or reload chatgpt.com/library to connect.";
  elements.scanButton.disabled = state.deleting || state.navigatingFolder || (state.scanning ? false : !connected);
  elements.scanButton.classList.toggle("primary", !state.scanning);
  elements.scanButton.classList.toggle("danger", state.scanning);
  elements.scanButton.classList.toggle("scanning", state.scanning);
  elements.scanButton.querySelector("span:last-child").textContent = state.navigatingFolder
    ? "Opening folder…"
    : state.scanning
      ? "Stop indexing"
      : state.scanError
        ? "Retry failed index"
      : state.viewMode === "tab"
        ? hasFolderCache ? "Dock to update" : "Dock to index"
        : folderMismatch
          ? hasFolderCache ? "Sync and update folder" : "Sync and index folder"
          : hasFolderCache ? "Update current folder" : "Index current folder";
  elements.scanButton.title = state.viewMode === "tab" && !state.scanning
    ? "Indexing requires the Library to remain visible in the top dock"
    : "";
  elements.reindexButton.hidden = !hasFolderCache && !state.scanError;
  elements.reindexButton.disabled = state.scanning || state.navigatingFolder || state.deleting;
  elements.reindexButton.title = "Clear only this folder’s cached metadata, reload it in ChatGPT, and build a fresh index";
  renderInteractionLocks();
  renderShowInChatGPT();
}

function currentFolderHasCache(folderPath = state.currentPath || state.connectionPage?.folderPath) {
  return state.items.some((item) => item.folderPath === folderPath)
    || state.scans.some((scan) => scan.folderPath === folderPath);
}

function renderInteractionLocks() {
  const locked = state.scanning || state.navigatingFolder || state.deleting;
  elements.clearCacheButton.disabled = locked;
  elements.folderTree.querySelectorAll("button.folder-item").forEach((button) => {
    const isCurrent = button.dataset.destination === state.currentPath
      && state.viewScope === "folder"
      && !state.query;
    button.disabled = locked || isCurrent;
    button.title = isCurrent
      ? "Current folder"
      : locked
        ? "Stop indexing before opening another folder"
        : `Open ${button.textContent.trim()}`;
  });
  elements.fileBody.querySelectorAll("tr.file-row").forEach((row) => {
    row.classList.toggle("navigation-locked", locked);
  });
}

function renderLiveScan() {
  elements.liveScan.hidden = !state.scanning;
  if (!state.scanning) return;

  const progress = state.scanProgress || {};
  const scroll = progress.scroll;
  const percentage = scroll?.maximum > 0
    ? Math.max(2, Math.min(100, Math.round((scroll.position / scroll.maximum) * 100)))
    : 3;
  elements.liveCount.textContent = String(progress.totalObserved || 0);
  elements.liveScan.classList.toggle("waiting", Boolean(progress.waitingForVisibility));
  elements.livePass.textContent = progress.waitingForVisibility ? "Paused" : `Pass ${progress.pass || 0}`;
  const scanActivity = progress.waitingForVisibility
    ? "Library tab is hidden"
    : progress.knownBoundaryPasses > 0
      ? `Cached boundary ${progress.knownBoundaryPasses}/${progress.requiredKnownItemPasses || state.knownItemPasses}`
    : progress.batchCount
      ? `+${progress.batchCount} new/changed`
      : "Checking loaded rows";
  const renderedDetails = Number.isFinite(progress.renderedRows)
    ? ` · ${progress.renderedRows} rendered · ${progress.thumbnailCount || 0} previews`
    : "";
  elements.liveBatch.textContent = `${scanActivity}${renderedDetails}`;
  elements.liveProgressBar.style.width = `${percentage}%`;
  const fullScrollText = progress.waitingForVisibility
    ? "Return to the ChatGPT Library tab to resume indexing"
    : scroll
    ? `${scroll.position.toLocaleString()} / ${scroll.maximum.toLocaleString()} px in the current loaded range`
    : "Finding the Library scroll surface…";
  elements.liveScroll.textContent = progress.waitingForVisibility
    ? "Return to Library to resume"
    : scroll
      ? `${scroll.position.toLocaleString()} / ${scroll.maximum.toLocaleString()} px`
      : fullScrollText;
  elements.liveScroll.title = fullScrollText;
}

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  if (state.query) {
    appendBreadcrumb("Local index", "", true);
    appendBreadcrumb("Search results", "", true);
    return;
  }

  if (state.viewScope === "global") {
    appendBreadcrumb("Local index", "", true);
    appendBreadcrumb(`Current folder: ${lastPathPart(state.currentPath)}`, state.currentPath, false, () => {
      state.viewScope = "folder";
      state.filter = "all";
      render();
    });
    return;
  }

  const parts = state.currentPath.split(" / ").filter(Boolean);
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join(" / ");
    appendBreadcrumb(part, path, path === state.currentPath, () => navigateToPath(path));
  });
}

function appendBreadcrumb(label, path, disabled, onClick = null) {
  const button = document.createElement("button");
  button.className = "breadcrumb-button";
  button.textContent = label;
  button.dataset.path = path;
  button.disabled = disabled || state.scanning || state.navigatingFolder || state.deleting;
  if (onClick) button.addEventListener("click", onClick);
  elements.breadcrumbs.append(button);
}

function renderFolderTree() {
  elements.folderTree.replaceChildren();
  const currentPath = normalizeFolderPath(state.currentPath || "Library");
  const navigationLocked = state.scanning || state.navigatingFolder || state.deleting;
  const rootButton = document.createElement("button");
  rootButton.className = "folder-item";
  rootButton.dataset.destination = "Library";
  const rootIsCurrent = currentPath === "Library" && state.viewScope === "folder" && !state.query;
  rootButton.disabled = navigationLocked || rootIsCurrent;
  rootButton.title = rootIsCurrent
    ? "Current folder"
    : rootButton.disabled
      ? "Stop indexing before opening Root"
      : "Open the ChatGPT Library root";
  rootButton.classList.toggle("active", rootIsCurrent);
  const rootIcon = document.createElement("span");
  rootIcon.textContent = "▱";
  const rootLabel = document.createElement("span");
  rootLabel.textContent = "Root";
  rootButton.append(rootIcon, rootLabel);
  rootButton.addEventListener("click", () => navigateToPath("Library"));
  elements.folderTree.append(rootButton);

  const pathParts = currentPath.split(" / ");
  if (pathParts.length > 2) {
    const parentPath = pathParts.slice(0, -1).join(" / ");
    const parentButton = document.createElement("button");
    parentButton.className = "folder-item parent-folder-item";
    parentButton.dataset.destination = parentPath;
    parentButton.disabled = navigationLocked;
    parentButton.title = navigationLocked
      ? "Stop indexing before opening the parent folder"
      : `Go up to ${lastPathPart(parentPath)}`;
    const parentIcon = document.createElement("span");
    parentIcon.textContent = "↰";
    const parentLabel = document.createElement("span");
    parentLabel.textContent = `.. ${lastPathPart(parentPath)}`;
    parentButton.append(parentIcon, parentLabel);
    parentButton.addEventListener("click", () => navigateToPath(parentPath));
    elements.folderTree.append(parentButton);
  }

  const folders = state.items
    .filter((item) => item.kind === "folder" && normalizeFolderPath(item.folderPath) === currentPath)
    .sort((a, b) => a.name.localeCompare(b.name));

  const unique = new Map(folders.map((item) => [`${item.folderPath}|${item.name}`, item]));
  if (!unique.size) return;

  for (const item of unique.values()) {
    const button = document.createElement("button");
    button.className = "folder-item";
    const destination = `${currentPath} / ${item.name}`;
    button.dataset.destination = destination;
    const isCurrent = destination === state.currentPath && state.viewScope === "folder" && !state.query;
    button.disabled = state.scanning || state.navigatingFolder || state.deleting || isCurrent;
    button.title = isCurrent
      ? "Current folder"
      : button.disabled
        ? "Stop indexing before opening another folder"
        : `Open ${item.name}`;
    button.classList.toggle("active", isCurrent);
    const icon = document.createElement("span");
    icon.textContent = "▱";
    const label = document.createElement("span");
    label.textContent = item.name;
    button.append(icon, label);
    button.addEventListener("click", () => openFolder(item));
    elements.folderTree.append(button);
  }
}

function renderRows() {
  elements.fileBody.replaceChildren();
  const visible = getVisibleItems();
  elements.emptyState.hidden = visible.length > 0;

  for (const item of visible) {
    const row = document.createElement("tr");
    row.className = "file-row";
    row.classList.toggle("navigation-locked", state.scanning || state.navigatingFolder || state.deleting);
    row.classList.toggle("selected", state.selected.has(item.id));
    row.dataset.itemId = item.id;

    const checkCell = document.createElement("td");
    checkCell.className = "check-column";
    if (item.kind === "file") {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = state.deleting;
      checkbox.checked = state.selected.has(item.id);
      checkbox.setAttribute("aria-label", `Select ${item.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        render();
      });
      checkCell.append(checkbox);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "folder-checkbox-placeholder";
      checkCell.append(placeholder);
    }

    const nameCell = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "name-cell";
    const icon = createItemIcon(item);
    const name = document.createElement("span");
    name.className = `file-name ${item.kind === "folder" ? "folder" : ""}`;
    name.textContent = item.name;
    nameWrap.append(icon, name);
    nameCell.append(nameWrap);

    const modifiedCell = document.createElement("td");
    modifiedCell.textContent = item.modified || "—";
    const sizeCell = document.createElement("td");
    sizeCell.textContent = item.kind === "folder" ? "" : (item.size || "—");
    const extensionCell = document.createElement("td");
    extensionCell.textContent = item.kind === "folder" ? "" : (item.extension || "—").toUpperCase();
    const folderCell = document.createElement("td");
    folderCell.className = "folder-cell";
    folderCell.textContent = item.folderPath || "Library";
    folderCell.title = item.folderPath || "Library";

    row.append(checkCell, nameCell, modifiedCell, sizeCell, extensionCell, folderCell);
    row.addEventListener("dblclick", () => {
      if (state.scanning || state.navigatingFolder || state.deleting) {
        showToast("Wait for the current Library operation before navigating.", true);
        return;
      }
      if (item.kind === "folder") openFolder(item);
      else openFile(item);
    });
    row.addEventListener("mouseenter", (event) => schedulePreview(item, event));
    row.addEventListener("mousemove", positionPreview);
    row.addEventListener("mouseleave", hidePreview);
    elements.fileBody.append(row);
  }

  const visibleFiles = visible.filter((item) => item.kind === "file");
  const selectedVisible = visibleFiles.filter((item) => state.selected.has(item.id)).length;
  elements.selectAll.checked = visibleFiles.length > 0 && selectedVisible === visibleFiles.length;
  elements.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleFiles.length;
  elements.selectAll.disabled = visibleFiles.length === 0;
}

function createItemIcon(item) {
  const icon = document.createElement("span");
  icon.className = `file-icon ${item.kind}`;
  if (item.kind === "folder") {
    icon.textContent = "▱";
  } else if (item.previewUrl && IMAGE_EXTENSIONS.has(item.extension)) {
    const image = document.createElement("img");
    image.src = item.previewUrl;
    image.alt = "";
    image.addEventListener("error", () => {
      icon.replaceChildren(document.createTextNode(item.extension || "file"));
    }, { once: true });
    icon.append(image);
  } else {
    icon.textContent = item.extension || "file";
  }
  return icon;
}

function getVisibleItems() {
  const query = state.query;
  const visible = state.items
    .filter((item) => query
      ? `${item.name} ${item.folderPath} ${item.extension || ""}`.toLowerCase().includes(query)
      : state.viewScope === "global"
        ? item.kind === "file"
        : item.folderPath === state.currentPath)
    .filter((item) => {
      if (item.kind === "folder") return state.filter === "all";
      const isImage = IMAGE_EXTENSIONS.has(item.extension);
      if (state.filter === "images") return isImage;
      if (state.filter === "documents") return !isImage;
      return true;
    });

  return visible.sort((a, b) => compareItems(a, b));
}

function compareItems(a, b) {
  if (state.sortKey === "name") {
    const comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return state.sortDirection === "asc" ? comparison : -comparison;
  }

  if (state.sortKey === "size") {
    const comparison = parseSize(a.size) - parseSize(b.size);
    if (comparison !== 0) return state.sortDirection === "asc" ? comparison : -comparison;
  }

  if (state.sortKey === "extension") {
    const comparison = (a.extension || "").localeCompare(b.extension || "", undefined, { sensitivity: "base" });
    if (comparison !== 0) return state.sortDirection === "asc" ? comparison : -comparison;
  }

  if (state.sortKey === "folder") {
    const comparison = (a.folderPath || "Library").localeCompare(b.folderPath || "Library", undefined, { numeric: true, sensitivity: "base" });
    if (comparison !== 0) return state.sortDirection === "asc" ? comparison : -comparison;
  }

  const orderA = Number.isFinite(a.sourceOrder) ? a.sourceOrder : Number.MAX_SAFE_INTEGER;
  const orderB = Number.isFinite(b.sourceOrder) ? b.sourceOrder : Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return state.sortDirection === "desc" ? orderA - orderB : orderB - orderA;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function parseSize(size) {
  const match = String(size || "").replace(/,/g, "").match(/([\d.]+)\s*(B|KB|MB|GB|TB)?/i);
  if (!match) return -1;
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Number(match[1]) * (1024 ** (powers[(match[2] || "B").toUpperCase()] || 0));
}

async function toggleViewMode() {
  try {
    if (state.viewMode === "tab") {
      return dockCurrentPathAndIndex();
    }
    await callBackground({ type: "manager:undockManager" });
    if (state.viewMode === "sidepanel") window.close();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function dockCurrentPathAndIndex() {
  if (state.viewMode !== "tab" || state.navigatingFolder) return;
  state.navigatingFolder = true;
  render();
  try {
    await callBackground({
      type: "manager:navigatePath",
      targetPath: state.currentPath,
      chain: buildFolderChain(state.currentPath),
      forceDock: true
    });
    if (state.currentManagerTab?.id) await chrome.tabs.remove(state.currentManagerTab.id);
    else window.close();
  } catch (error) {
    state.navigatingFolder = false;
    render();
    showToast(error.message, true);
  }
}

function renderSelection() {
  const selectedItems = state.items.filter((item) => state.selected.has(item.id) && item.kind === "file");
  const deleteLocked = state.scanning || state.navigatingFolder || state.deleting;
  elements.selectionCopy.textContent = `${selectedItems.length} file${selectedItems.length === 1 ? "" : "s"} selected`;
  elements.reviewDeleteButton.disabled = deleteLocked || selectedItems.length === 0;
  elements.reviewDeleteButton.title = deleteLocked
    ? state.deleting
      ? "A delete job is already running"
      : "Stop indexing before reviewing or deleting files"
    : selectedItems.length
      ? `Review ${selectedItems.length} selected file${selectedItems.length === 1 ? "" : "s"}`
      : "Select at least one file to review deletion";
  renderShowInChatGPT();
}

function renderShowInChatGPT() {
  const selectedFiles = state.items.filter((item) => state.selected.has(item.id) && item.kind === "file");
  const locked = state.scanning || state.navigatingFolder || state.deleting;
  elements.focusLibraryButton.disabled = !state.connected || locked || selectedFiles.length !== 1;
  elements.focusLibraryButton.title = locked
    ? "Stop indexing before opening a file in a new tab"
    : selectedFiles.length === 1
      ? `Open ${selectedFiles[0].name} in a new ChatGPT tab`
      : "Select exactly one file to open it in ChatGPT";
}

async function showSelectedInChatGPT() {
  const selectedFiles = state.items.filter((item) => state.selected.has(item.id) && item.kind === "file");
  if (selectedFiles.length !== 1) return;
  const item = selectedFiles[0];
  try {
    await callBackground({
      type: "manager:showItemInNewTab",
      item: { id: item.id, name: item.name },
      chain: buildFolderChain(item.folderPath || "Library")
    });
    showToast(`Opened “${item.name}” in a new ChatGPT tab.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

function schedulePreview(item, event) {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => showPreview(item, event), 320);
}

function showPreview(item, event) {
  elements.previewStage.replaceChildren();
  if (item.previewUrl) {
    const image = document.createElement("img");
    image.src = item.previewUrl;
    image.alt = `Preview of ${item.name}`;
    image.addEventListener("error", () => {
      elements.previewStage.replaceChildren(document.createTextNode(item.kind === "folder" ? "▱" : (item.extension || "FILE")));
    }, { once: true });
    elements.previewStage.append(image);
  } else {
    elements.previewStage.textContent = item.kind === "folder" ? "▱" : (item.extension || "FILE");
  }
  elements.previewName.textContent = item.name;
  elements.previewMeta.textContent = [item.modified, item.size].filter(Boolean).join(" · ") || item.kind;
  elements.previewCard.hidden = false;
  positionPreview(event);
}

function positionPreview(event) {
  if (elements.previewCard.hidden) return;
  const width = 310;
  const height = 275;
  const left = Math.min(window.innerWidth - width - 14, event.clientX + 18);
  const top = Math.min(window.innerHeight - height - 14, Math.max(14, event.clientY - 80));
  elements.previewCard.style.left = `${Math.max(14, left)}px`;
  elements.previewCard.style.top = `${top}px`;
}

function hidePreview() {
  clearTimeout(state.previewTimer);
  elements.previewCard.hidden = true;
}

function openDeleteReview() {
  if (state.scanning || state.navigatingFolder || state.deleting) {
    closeDeleteReview();
    showToast("Stop indexing before reviewing or deleting files.", true);
    return;
  }
  const selectedItems = state.items.filter((item) => state.selected.has(item.id) && item.kind === "file");
  if (!selectedItems.length) return;
  state.deleteState = null;
  elements.deleteList.replaceChildren();
  for (const item of selectedItems.slice(0, 250)) {
    const row = document.createElement("div");
    row.className = "delete-row";
    row.append(createItemIcon(item));
    const label = document.createElement("span");
    label.textContent = item.name;
    row.append(label);
    elements.deleteList.append(row);
  }
  if (selectedItems.length > 250) {
    const overflow = document.createElement("div");
    overflow.className = "delete-row";
    overflow.textContent = `…and ${(selectedItems.length - 250).toLocaleString()} more selected files`;
    elements.deleteList.append(overflow);
  }
  elements.deleteTotal.textContent = `${selectedItems.length} file${selectedItems.length === 1 ? "" : "s"} queued`;
  const missingTokens = selectedItems.filter((item) => !item.remoteToken).length;
  if (!state.deleteCalibrated) {
    elements.deleteWarning.textContent = "Calibration is required. The selected disposable file will be deleted through ChatGPT’s native confirmation so the manager can learn the current authenticated request. Nothing else will be processed in this calibration run.";
    elements.confirmDeleteButton.disabled = selectedItems.length !== 1;
    elements.confirmDeleteButton.textContent = selectedItems.length === 1 ? "Calibrate & delete file" : "Select one calibration file";
  } else {
    elements.deleteWarning.textContent = missingTokens
      ? `${missingTokens.toLocaleString()} selected cached record${missingTokens === 1 ? "" : "s"} predate v0.7 and do not contain ChatGPT’s raw libfile identity. Update each affected folder index once to backfill those identities; later deletes will not require another update.`
      : `The manager will submit up to ${state.deleteConcurrency} authenticated delete requests in parallel. Successes and already-absent files leave the cache immediately; individual failures remain indexed and are reported below.`;
    elements.confirmDeleteButton.disabled = missingTokens > 0;
    elements.confirmDeleteButton.textContent = missingTokens
      ? `${missingTokens.toLocaleString()} file ID${missingTokens === 1 ? "" : "s"} need refresh`
      : `Delete ${selectedItems.length.toLocaleString()} selected`;
  }
  elements.deleteList.hidden = false;
  elements.deleteProgress.hidden = true;
  elements.stopDeleteButton.hidden = true;
  elements.confirmDeleteButton.hidden = false;
  elements.cancelDeleteButton.hidden = false;
  elements.cancelDeleteButton.textContent = "Cancel";
  elements.closeModalButton.disabled = false;
  elements.deleteModal.hidden = false;
}

function closeDeleteReview() {
  if (state.deleting) return;
  elements.deleteModal.hidden = true;
}

async function deleteReviewedItem() {
  const selectedItems = state.items.filter((item) => state.selected.has(item.id) && item.kind === "file");
  if (!selectedItems.length || state.deleting) return;
  if (!state.deleteCalibrated && selectedItems.length !== 1) return;
  if (state.deleteCalibrated && selectedItems.some((item) => !item.remoteToken)) {
    showToast("Update the affected folder indexes before direct deletion so every selected file has a libfile identity.", true);
    return;
  }
  state.deleting = true;
  elements.confirmDeleteButton.disabled = true;
  elements.confirmDeleteButton.textContent = state.deleteCalibrated ? "Starting…" : "Calibrating…";
  elements.deleteList.hidden = true;
  elements.deleteProgress.hidden = false;
  elements.stopDeleteButton.hidden = !state.deleteCalibrated;
  elements.cancelDeleteButton.hidden = true;
  elements.closeModalButton.disabled = true;
  state.deleteState = {
    status: state.deleteCalibrated ? "running" : "calibrating",
    total: selectedItems.length,
    processed: 0,
    deleted: 0,
    absent: 0,
    failed: 0,
    startedAt: Date.now(),
    errors: []
  };
  renderDeleteProgress();
  renderSelection();
  try {
    if (!state.deleteCalibrated) {
      const item = selectedItems[0];
      const response = await callBackground({
        type: "manager:calibrateDeleteRequest",
        item,
        chain: buildFolderChain(item.folderPath || "Library")
      });
      if (!response.calibrated) throw new Error("Delete calibration did not complete.");
      state.deleteCalibrated = true;
      state.selected.delete(item.id);
      showToast("Deletion calibrated successfully. Future reviewed selections can use direct requests.");
    } else {
      await callBackground({
        type: "manager:startDirectDelete",
        items: selectedItems.map((item) => ({
          id: item.id,
          name: item.name,
          folderPath: item.folderPath || "Library",
          remoteToken: item.remoteToken,
          kind: "file"
        }))
      });
    }
    await refreshDeleteState();
    await reloadCache();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.deleting = ["running", "calibrating", "cancelling"].includes(state.deleteState?.status);
    if (!state.deleting) {
      elements.stopDeleteButton.hidden = true;
      elements.cancelDeleteButton.hidden = false;
      elements.cancelDeleteButton.textContent = "Close";
      elements.closeModalButton.disabled = false;
      elements.confirmDeleteButton.hidden = true;
    }
    renderDeleteProgress();
    render();
  }
}

async function stopDeleteJob() {
  if (!state.deleting) return;
  elements.stopDeleteButton.disabled = true;
  elements.stopDeleteButton.textContent = "Stopping…";
  try {
    await callBackground({ type: "manager:cancelDelete" });
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderDeleteProgress() {
  const progress = state.deleteState || {};
  const total = Number(progress.total || 0);
  const processed = Number(progress.processed || 0);
  const percentage = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  elements.deleteProgress.hidden = false;
  elements.deleteProgressBar.style.width = `${percentage}%`;
  elements.deleteProgressCount.textContent = `${processed.toLocaleString()} / ${total.toLocaleString()}`;
  elements.deleteSuccessCount.textContent = Number(progress.deleted || 0).toLocaleString();
  elements.deleteAbsentCount.textContent = Number(progress.absent || 0).toLocaleString();
  elements.deleteFailedCount.textContent = Number(progress.failed || 0).toLocaleString();
  const labels = {
    calibrating: "Calibrating with ChatGPT’s native delete…",
    running: progress.currentName ? `Processing ${progress.currentName}` : "Submitting delete requests…",
    cancelling: "Stopping remaining requests…",
    cancelled: "Deletion stopped",
    complete: "Deletion complete",
    error: "Deletion stopped with an error",
    interrupted: "Previous deletion was interrupted"
  };
  elements.deleteProgressTitle.textContent = labels[progress.status] || "Preparing deletion…";
  const elapsedSeconds = Math.max(0, Number(progress.elapsedMs || (progress.startedAt ? Date.now() - progress.startedAt : 0)) / 1000);
  const rate = Number(progress.ratePerSecond || 0);
  const timeParts = [`Elapsed ${formatDuration(elapsedSeconds)}`];
  if (rate > 0) timeParts.push(`${rate.toFixed(rate < 1 ? 2 : 1)} files/sec`);
  if (Number.isFinite(progress.etaSeconds) && progress.status === "running") timeParts.push(`ETA ${formatDuration(progress.etaSeconds)}`);
  if (progress.error) timeParts.push(progress.error);
  elements.deleteProgressTime.textContent = timeParts.join(" · ");
  const errors = progress.errors || [];
  elements.deleteErrors.replaceChildren();
  for (const entry of errors) {
    const row = document.createElement("div");
    row.className = "delete-error-row";
    row.textContent = `${entry.name}: ${entry.error}${entry.httpStatus ? ` (HTTP ${entry.httpStatus})` : ""}`;
    elements.deleteErrors.append(row);
  }
  elements.deleteErrors.hidden = errors.length === 0;
  elements.stopDeleteButton.disabled = progress.status !== "running";
  elements.stopDeleteButton.textContent = progress.status === "cancelling" ? "Stopping…" : "Stop";
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}m ${remainder}s`;
}

async function clearLocalIndex() {
  if (!confirm("Clear only the local Library Manager index? Nothing will be deleted from ChatGPT.")) return;
  await clearCache();
  await chrome.storage.local.remove("folderUrlsByPath").catch(() => {});
  state.items = [];
  state.scans = [];
  state.selected.clear();
  state.currentPath = "Library";
  state.viewScope = "global";
  persistManagerLocation();
  render();
  showToast("Local index cleared. No ChatGPT files were changed.");
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
}

function callBackground(message, showErrors = true) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        const error = new Error(runtimeError.message);
        if (showErrors) showToast(error.message, true);
        reject(error);
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error || "The extension background service did not respond.");
        if (showErrors) showToast(error.message, true);
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function lastPathPart(path) {
  return path.split(" / ").filter(Boolean).pop() || "Library";
}

function formatRelativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
