import { deleteCachedItems, finalizeScan, getAllItems, upsertItemsBatch } from "./store.js";

const LIBRARY_URL = "https://chatgpt.com/library?tab=all";
const EXPLORER_URL = chrome.runtime.getURL("explorer.html");
const managerScanPorts = new Set();
let activeLibraryPort = null;
let activeLibraryTabId = null;
let scanWriteQueue = Promise.resolve();
let deleteProgressQueue = Promise.resolve();
let activeScanState = { type: "status", status: "idle", updatedAt: Date.now() };
let activeDeleteState = { type: "delete-status", status: "idle", updatedAt: Date.now() };

chrome.storage.local.get("scanRuntimeState").then(({ scanRuntimeState }) => {
  if (!scanRuntimeState) return;
  const staleRunningScan = scanRuntimeState.status === "scanning"
    && Date.now() - (scanRuntimeState.updatedAt || 0) > 15000;
  activeScanState = staleRunningScan
    ? { ...scanRuntimeState, type: "status", status: "interrupted", updatedAt: Date.now() }
    : scanRuntimeState;
});

chrome.storage.local.get("deleteRuntimeState").then(({ deleteRuntimeState }) => {
  if (!deleteRuntimeState) return;
  const stale = deleteRuntimeState.status === "running"
    && Date.now() - (deleteRuntimeState.updatedAt || 0) > 120000;
  activeDeleteState = stale
    ? { ...deleteRuntimeState, type: "delete-status", status: "interrupted", updatedAt: Date.now() }
    : deleteRuntimeState;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    safetyMode: "reviewed-direct-delete",
    installedAt: Date.now()
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener(() => {
  toggleTopDockFromToolbar().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener((managerPort) => {
  if (managerPort.name !== "manager-scan") return;
  managerScanPorts.add(managerPort);
  managerPort.onMessage.addListener((message) => {
    handleScanManagerMessage(managerPort, message).catch((error) => {
      safePost(managerPort, { type: "error", error: error.message });
    });
  });
  managerPort.onDisconnect.addListener(() => managerScanPorts.delete(managerPort));
  safePost(managerPort, activeScanState);
  safePost(managerPort, activeDeleteState);
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "manager:getState":
      return getConnectionState();
    case "manager:openLibrary":
      return openLibrary();
    case "manager:focusLibrary":
      return focusLibrary();
    case "manager:undockManager": {
      if (activeLibraryPort && activeScanState.status === "scanning") {
        activeLibraryPort.postMessage({ type: "cancel" });
      }
      const result = await openExplorer();
      await sendToLibrary({ type: "library:closeTopDock" }).catch(() => null);
      return result;
    }
    case "manager:dockManager": {
      const result = await focusLibrary();
      await sendToLibrary({ type: "library:toggleTopDock", open: true });
      return result;
    }
    case "manager:navigatePath":
      return navigateLibraryPath(
        message.chain || [],
        message.targetPath || "Library",
        Boolean(message.forceDock)
      );
    case "manager:showItemInNewTab":
      return showItemInNewTab(message.item, message.chain || []);
    case "manager:deleteOneNative":
      return deleteOneNative(message.item, message.chain || []);
    case "manager:getDeleteState":
      return getDeleteState();
    case "manager:clearDeleteCalibration":
      await chrome.storage.local.remove("deleteRequestTemplate");
      return { cleared: true };
    case "manager:calibrateDeleteRequest":
      return calibrateDeleteRequest(message.item, message.chain || []);
    case "manager:startDirectDelete":
      return runDirectDelete(message.items || []);
    case "manager:cancelDelete":
      return cancelDirectDelete();
    case "manager:scanCurrentFolder":
      return sendToAllLibrary({
        type: "library:scanCurrentFolder",
        expectedFolderPath: message.folderPath || "",
        knownSignatures: message.knownSignatures || {},
        knownItemPasses: message.knownItemPasses,
        deep: Boolean(message.deep)
      });
    case "manager:enterFolder": {
      const tab = await findLibraryTab();
      if (!tab?.id) throw new Error("Open ChatGPT Library first.");
      await waitForLibraryRows(tab.id);
      const response = await sendToLibrary({
        type: "library:enterFolder",
        id: message.id,
        name: message.name
      });
      if (response?.ok !== false && message.targetPath) {
        await rememberCurrentFolderUrl(message.targetPath).catch(() => null);
      }
      return response;
    }
    case "manager:openItem":
      return sendToLibrary({
        type: "library:openItem",
        id: message.id,
        name: message.name
      });
    case "library:confirmedItemsDeleted": {
      if (!sender?.tab?.url?.startsWith("https://chatgpt.com/library")) {
        throw new Error("Confirmed deletion events are accepted only from a ChatGPT Library tab.");
      }
      return commitConfirmedDeletions(message.items || []);
    }
    case "library:deleteProgress": {
      if (!sender?.tab?.url?.startsWith("https://chatgpt.com/library")) {
        throw new Error("Delete progress is accepted only from a ChatGPT Library tab.");
      }
      deleteProgressQueue = deleteProgressQueue.then(() => handleDirectDeleteProgress(message.progress || {}));
      return deleteProgressQueue;
    }
    case "library:scanEvent": {
      if (!sender?.tab?.id || !sender.tab.url?.startsWith("https://chatgpt.com/library")) {
        throw new Error("Scan events are accepted only from a ChatGPT Library tab.");
      }
      if (!activeLibraryTabId || sender.tab.id !== activeLibraryTabId || activeScanState.status !== "scanning") {
        return { ignored: true };
      }
      const libraryPort = activeLibraryPort;
      scanWriteQueue = scanWriteQueue.then(() => handleLibraryScanEvent(libraryPort, message.event || {}));
      return scanWriteQueue;
    }
    default:
      throw new Error("Unknown manager message.");
  }
}

async function getDeleteState() {
  const { deleteRequestTemplate, deleteConcurrency = 5 } = await chrome.storage.local.get([
    "deleteRequestTemplate",
    "deleteConcurrency"
  ]);
  return {
    calibrated: Boolean(deleteRequestTemplate?.template),
    calibratedAt: deleteRequestTemplate?.calibratedAt || null,
    concurrency: clampDeleteConcurrency(deleteConcurrency),
    deleteState: activeDeleteState
  };
}

async function calibrateDeleteRequest(item, chain) {
  if (activeScanState.status === "scanning" || activeDeleteState.status === "running") {
    throw new Error("Stop the current Library operation before calibrating deletion.");
  }
  if (!item?.id || !item?.name || item.kind === "folder") {
    throw new Error("Select exactly one disposable indexed file for calibration.");
  }

  const folderPath = item.folderPath || "Library";
  const folderUrl = folderPath === "Library" ? LIBRARY_URL : await getRememberedFolderUrl(folderPath, chain);
  if (!folderUrl) throw new Error(`Open “${folderPath}” once so its cached URL can be used for calibration.`);
  const url = new URL(folderUrl);
  url.searchParams.set("search", item.name);
  const originalTab = await findLibraryTab();
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  if (!tab.id) throw new Error("Chrome did not create the protected calibration tab.");
  await registerAuxiliaryLibraryTab(tab.id);
  let calibrationDeleted = false;

  setDeleteState({
    status: "calibrating",
    total: 1,
    processed: 0,
    deleted: 0,
    absent: 0,
    failed: 0,
    currentName: item.name,
    startedAt: Date.now()
  }, "delete-progress");

  try {
    await waitForTabComplete(tab.id);
    await sendWhenBridgeReady(tab.id, { type: "library:ping" });
    await sendWhenBridgeReady(tab.id, { type: "library:setFolderPathHint", folderPath });
    const response = await sendWhenBridgeReady(tab.id, { type: "library:calibrateDeleteRequest", item });
    if (!response?.deleted) throw new Error(response?.error || "ChatGPT did not finish the native calibration deletion.");
    await commitConfirmedDeletions([item]);
    calibrationDeleted = true;
    schedulePrimaryLibraryRefresh();
    if (!response.savedTemplate?.template) {
      throw new Error(response.calibrationError || "The file was deleted, but the authenticated request could not be calibrated.");
    }
    await chrome.storage.local.set({ deleteRequestTemplate: response.savedTemplate });
    setDeleteState({
      status: "complete",
      total: 1,
      processed: 1,
      deleted: 1,
      absent: 0,
      failed: 0,
      currentName: "",
      calibrated: true,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - activeDeleteState.startedAt
    }, "delete-complete");
    return { deleted: true, calibrated: true };
  } catch (error) {
    setDeleteState({
      status: "error",
      error: error.message,
      processed: calibrationDeleted ? 1 : activeDeleteState.processed,
      deleted: calibrationDeleted ? 1 : activeDeleteState.deleted,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - activeDeleteState.startedAt
    }, "delete-error");
    throw error;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (originalTab?.id) {
      await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
      if (originalTab.windowId) await chrome.windows.update(originalTab.windowId, { focused: true }).catch(() => {});
    }
  }
}

async function runDirectDelete(items) {
  if (activeScanState.status === "scanning") throw new Error("Stop indexing before deleting files.");
  if (["running", "calibrating"].includes(activeDeleteState.status)) throw new Error("A delete job is already running.");
  if (!items.length || items.some((item) => item.kind === "folder")) throw new Error("Select one or more indexed files first.");
  if (items.some((item) => !/^libfile_[a-z0-9_-]+$/i.test(item.remoteToken || ""))) {
    throw new Error("One or more selected files need an index update to capture their libfile identity.");
  }

  const { deleteRequestTemplate, deleteConcurrency = 5 } = await chrome.storage.local.get([
    "deleteRequestTemplate",
    "deleteConcurrency"
  ]);
  if (!deleteRequestTemplate?.template) throw new Error("Calibrate deletion with one disposable file first.");
  const tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library before starting deletion.");

  setDeleteState({
    status: "running",
    total: items.length,
    processed: 0,
    deleted: 0,
    absent: 0,
    failed: 0,
    errors: [],
    currentName: "",
    startedAt: Date.now(),
    elapsedMs: 0,
    ratePerSecond: 0,
    etaSeconds: null,
    concurrency: clampDeleteConcurrency(deleteConcurrency)
  }, "delete-progress");

  try {
    const result = await sendWhenBridgeReady(tab.id, {
      type: "library:replayDeleteItems",
      items,
      savedTemplate: deleteRequestTemplate,
      concurrency: clampDeleteConcurrency(deleteConcurrency),
      maxRetries: 6
    });
    if (result?.ok === false || !Number.isFinite(result?.total)) {
      throw new Error(result?.error || "The ChatGPT delete bridge did not return a valid result.");
    }
    if (result.expiredTemplate) await chrome.storage.local.remove("deleteRequestTemplate");
    const status = result.cancelled ? "cancelled" : "complete";
    setDeleteState({
      status,
      processed: result.processed,
      total: result.total,
      deleted: result.deleted,
      absent: result.absent,
      failed: result.failed,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - activeDeleteState.startedAt,
      etaSeconds: 0,
      expiredTemplate: Boolean(result.expiredTemplate)
    }, status === "complete" ? "delete-complete" : "delete-cancelled");
    if (result.deleted || result.absent) schedulePrimaryLibraryRefresh();
    return { ...result, status };
  } catch (error) {
    setDeleteState({
      status: "error",
      error: error.message,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - activeDeleteState.startedAt
    }, "delete-error");
    if (activeDeleteState.deleted || activeDeleteState.absent) schedulePrimaryLibraryRefresh();
    throw error;
  }
}

async function handleDirectDeleteProgress(progress) {
  if (!progress?.completed || !["running", "cancelling"].includes(activeDeleteState.status)) return activeDeleteState;
  const { completed } = progress;
  if (["deleted", "absent"].includes(completed.status)) {
    await commitConfirmedDeletions([completed.item]);
  }
  const elapsedMs = Math.max(1, Date.now() - activeDeleteState.startedAt);
  const ratePerSecond = progress.processed / (elapsedMs / 1000);
  const remaining = Math.max(0, progress.total - progress.processed);
  const errors = [...(activeDeleteState.errors || [])];
  if (completed.status === "failed") {
    errors.push({
      name: completed.item?.name || "Unknown file",
      httpStatus: completed.httpStatus || 0,
      error: completed.error || "Delete failed",
      attempts: completed.attempts || 1
    });
  }
  setDeleteState({
    status: activeDeleteState.status === "cancelling" ? "cancelling" : "running",
    processed: progress.processed,
    total: progress.total,
    deleted: progress.deleted,
    absent: progress.absent,
    failed: progress.failed,
    errors: errors.slice(-50),
    currentName: completed.item?.name || "",
    elapsedMs,
    ratePerSecond,
    etaSeconds: ratePerSecond > 0 ? Math.ceil(remaining / ratePerSecond) : null,
    expiredTemplate: Boolean(progress.expiredTemplate)
  }, "delete-progress");
  if (progress.expiredTemplate) await chrome.storage.local.remove("deleteRequestTemplate");
  return activeDeleteState;
}

async function cancelDirectDelete() {
  if (activeDeleteState.status !== "running") return { cancelled: false };
  const tab = await findLibraryTab();
  if (tab?.id) await sendWhenBridgeReady(tab.id, { type: "library:cancelDeleteReplay" }).catch(() => null);
  setDeleteState({ status: "cancelling", cancelRequestedAt: Date.now() }, "delete-progress");
  return { cancelled: true };
}

function clampDeleteConcurrency(value) {
  return Math.max(1, Math.min(30, Number.parseInt(value, 10) || 5));
}

function setDeleteState(changes, eventType = "delete-progress") {
  activeDeleteState = {
    ...activeDeleteState,
    ...changes,
    type: "delete-status",
    updatedAt: Date.now()
  };
  chrome.storage.local.set({ deleteRuntimeState: activeDeleteState });
  for (const port of managerScanPorts) safePost(port, { ...activeDeleteState, type: eventType });
}

function schedulePrimaryLibraryRefresh() {
  setTimeout(() => refreshPrimaryLibraryAfterDelete().catch(() => {}), 1200);
}

async function refreshPrimaryLibraryAfterDelete() {
  const tab = await findLibraryTab();
  if (!tab?.id) return;
  const dockState = await chrome.tabs.sendMessage(tab.id, { type: "library:getDockState" }).catch(() => ({ open: false }));
  const completion = waitForNextTabComplete(tab.id);
  await chrome.tabs.reload(tab.id);
  await completion;
  await sendWhenBridgeReady(tab.id, { type: "library:ping" });
  if (dockState?.open) await openTopDockWhenReady(tab.id);
}

async function deleteOneNative(item, chain) {
  if (activeScanState.status === "scanning") {
    throw new Error("Stop indexing before deleting a file.");
  }
  if (!item?.id || !item?.name || item.kind === "folder") {
    throw new Error("Select exactly one indexed file to delete.");
  }

  const folderPath = item.folderPath || "Library";
  const folderUrl = folderPath === "Library"
    ? LIBRARY_URL
    : await getRememberedFolderUrl(folderPath, chain);
  if (!folderUrl) {
    throw new Error(`The cached URL for “${folderPath}” is missing. Open that folder once before deleting from it.`);
  }

  const url = new URL(folderUrl);
  url.searchParams.set("search", item.name);
  const originalTab = await findLibraryTab();
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  if (!tab.id) throw new Error("Chrome did not create the protected deletion tab.");
  await registerAuxiliaryLibraryTab(tab.id);

  try {
    await waitForTabComplete(tab.id);
    await sendWhenBridgeReady(tab.id, { type: "library:ping" });
    await sendWhenBridgeReady(tab.id, {
      type: "library:setFolderPathHint",
      folderPath
    });
    const response = await sendWhenBridgeReady(tab.id, {
      type: "library:deleteItemNative",
      item
    });
    if (!response?.deleted) throw new Error(response?.error || `ChatGPT did not delete “${item.name}”.`);
    const committed = await commitConfirmedDeletions([item]);
    return { ...committed, deleted: true };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (originalTab?.id) {
      await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
      if (originalTab.windowId) await chrome.windows.update(originalTab.windowId, { focused: true }).catch(() => {});
    }
  }
}

async function commitConfirmedDeletions(items) {
  const removed = await deleteCachedItems(items);
  const event = {
    type: "cache-items-deleted",
    removedIds: removed.map((item) => item.id),
    removedCount: removed.length,
    names: removed.map((item) => item.name),
    updatedAt: Date.now()
  };
  for (const port of managerScanPorts) safePost(port, event);
  return event;
}

async function showItemInNewTab(item) {
  if (!item?.id || !item?.name) throw new Error("Select one indexed file first.");
  const searchUrl = new URL(LIBRARY_URL);
  searchUrl.searchParams.set("search", item.name);
  const tab = await chrome.tabs.create({ url: searchUrl.href, active: true });
  if (!tab.id) throw new Error("Chrome did not create the ChatGPT tab.");
  await registerAuxiliaryLibraryTab(tab.id);
  await waitForTabComplete(tab.id);
  await sendWhenBridgeReady(tab.id, { type: "library:ping" });

  const response = await sendWhenBridgeReady(tab.id, {
    type: "library:openItem",
    id: item.id,
    name: item.name
  });
  if (response?.ok === false) throw new Error(response.error || `Could not open ${item.name}.`);
  return { tabId: tab.id };
}

async function getAuxiliaryLibraryTabIds() {
  try {
    const { auxiliaryLibraryTabIds = [] } = await chrome.storage.session.get("auxiliaryLibraryTabIds");
    return auxiliaryLibraryTabIds;
  } catch {
    return [];
  }
}

async function registerAuxiliaryLibraryTab(tabId) {
  const ids = new Set(await getAuxiliaryLibraryTabIds());
  ids.add(tabId);
  await chrome.storage.session.set({ auxiliaryLibraryTabIds: [...ids] });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ids = new Set(await getAuxiliaryLibraryTabIds());
  if (!ids.delete(tabId)) return;
  await chrome.storage.session.set({ auxiliaryLibraryTabIds: [...ids] });
});

async function navigateLibraryPath(chain, targetPath, forceDock = false) {
  const tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library first.");

  const dockState = await chrome.tabs.sendMessage(tab.id, { type: "library:getDockState" }).catch(() => ({ open: false }));
  const restoreDock = Boolean(dockState?.open || forceDock);
  try {
    await chrome.storage.local.remove(["pendingAutoIndex", "pendingNavigationError"]);
    const directFolderUrl = await getRememberedFolderUrl(targetPath, chain);
    const destinationUrl = targetPath === "Library" ? LIBRARY_URL : directFolderUrl || LIBRARY_URL;
    const completion = waitForNextTabComplete(tab.id);
    await chrome.tabs.update(tab.id, { url: destinationUrl });
    await completion;
    await sendWhenBridgeReady(tab.id, { type: "library:ping" });
    if (directFolderUrl) {
      const response = await sendWhenBridgeReady(tab.id, {
        type: "library:setFolderPathHint",
        folderPath: targetPath
      });
      if (response?.ok === false) throw new Error(response.error || `Could not verify ${targetPath}.`);
      await waitForLibraryRows(tab.id);
    } else if (chain.length) {
      await waitForLibraryRows(tab.id);
    }

    if (!directFolderUrl) {
      for (const folder of chain) {
        const beforeNavigation = await chrome.tabs.get(tab.id);
        const response = await sendWhenBridgeReady(tab.id, {
          type: "library:enterFolder",
          id: folder.id || "",
          name: folder.name
        });
        if (response?.ok === false) throw new Error(response.error || `Could not open ${folder.name}.`);
        await waitForFolderUrlChange(tab.id, beforeNavigation.url || "");
        const hintResponse = await sendWhenBridgeReady(tab.id, {
          type: "library:setFolderPathHint",
          folderPath: folder.path
        });
        if (hintResponse?.ok === false) throw new Error(hintResponse.error || `Could not verify ${folder.name}.`);
        await waitForLibraryRows(tab.id);
        await rememberCurrentFolderUrl(folder.path).catch(() => null);
      }
    }

    await chrome.storage.local.set({
      pendingAutoIndex: { path: targetPath, createdAt: Date.now() }
    });

    if (restoreDock) {
      await openTopDockWhenReady(tab.id);
    }
    await focusNavigatedLibraryTab(tab);
    return { tabId: tab.id, folderDepth: chain.length };
  } catch (error) {
    await chrome.storage.local.set({
      pendingNavigationError: {
        targetPath,
        error: error.message,
        createdAt: Date.now()
      }
    });
    if (restoreDock) {
      await openTopDockWhenReady(tab.id).catch(() => null);
    }
    await focusNavigatedLibraryTab(tab).catch(() => null);
    throw error;
  }
}

async function getRememberedFolderUrl(targetPath, chain) {
  if (targetPath === "Library") return LIBRARY_URL;
  const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
  return validateLibraryFolderUrl(folderUrlsByPath[targetPath] || chain.at(-1)?.href || "");
}

async function rememberCurrentFolderUrl(targetPath) {
  const tab = await findLibraryTab();
  if (!tab?.id || !targetPath) return false;
  const current = await chrome.tabs.get(tab.id);
  const folderUrl = validateLibraryFolderUrl(current.url || "");
  if (!folderUrl) return false;
  const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
  folderUrlsByPath[targetPath] = folderUrl;
  await chrome.storage.local.set({ folderUrlsByPath });
  return true;
}

function validateLibraryFolderUrl(value) {
  try {
    const url = new URL(value, LIBRARY_URL);
    if (url.origin !== "https://chatgpt.com") return "";
    if (!/^\/library\/d\/[^/?#]+\/?$/.test(url.pathname)) return "";
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

async function focusNavigatedLibraryTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

async function waitForLibraryRows(tabId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const response = await sendWhenBridgeReady(tabId, { type: "library:ping" }).catch(() => null);
    if (response?.page?.visibleRows > 0 || response?.page?.emptyFolder) return response.page;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("ChatGPT Library did not render its folder rows after reloading.");
}

async function waitForFolderUrlChange(tabId, previousUrl) {
  const previous = stripLibraryUrl(previousUrl || "");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId);
    const currentUrl = validateLibraryFolderUrl(current.url || "");
    if (currentUrl && currentUrl !== previous) {
      await sendWhenBridgeReady(tabId, { type: "library:ping" });
      return currentUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("ChatGPT did not change to the requested folder URL.");
}

async function openTopDockWhenReady(tabId) {
  let lastError = new Error("ChatGPT did not finish preparing the page for the Library Manager dock.");
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const response = await sendWhenBridgeReady(tabId, { type: "library:toggleTopDock", open: true });
      if (response?.ok !== false) return response;
      lastError = new Error(response.error || lastError.message);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError;
}

function waitForNextTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("ChatGPT Library took too long to reload."));
    }, 20000);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function waitForTabComplete(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("The new ChatGPT tab took too long to load."));
    }, 20000);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function toggleTopDockFromToolbar() {
  let tab = await findLibraryTab();
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: LIBRARY_URL, active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    tab = await ensureAllLibraryRoute(tab);
  }

  const dockState = await sendWhenBridgeReady(tab.id, { type: "library:getDockState" });
  if (dockState?.open && dockState?.ready !== false) {
    return sendWhenBridgeReady(tab.id, { type: "library:toggleTopDock", open: false });
  }

  if (activeScanState.status !== "scanning") {
    const { managerLocation } = await chrome.storage.local.get("managerLocation");
    const rememberedPath = managerLocation?.viewScope === "folder" ? managerLocation.path : "";
    const rememberedUrl = rememberedPath ? await getToolbarFolderUrl(rememberedPath) : "";
    if (rememberedPath && rememberedUrl) {
      const currentTab = await chrome.tabs.get(tab.id);
      const currentUrl = stripLibraryUrl(currentTab.url || "");
      if (currentUrl !== rememberedUrl) {
        const completion = waitForNextTabComplete(tab.id);
        await chrome.tabs.update(tab.id, { url: rememberedUrl });
        await completion;
        await sendWhenBridgeReady(tab.id, { type: "library:ping" });
      }
      const hintResponse = await sendWhenBridgeReady(tab.id, {
        type: "library:setFolderPathHint",
        folderPath: rememberedPath
      });
      if (hintResponse?.ok === false) {
        throw new Error(hintResponse.error || `Could not restore ${rememberedPath}.`);
      }
      const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
      folderUrlsByPath[rememberedPath] = rememberedUrl;
      await chrome.storage.local.remove("pendingNavigationError");
      await chrome.storage.local.set({
        folderUrlsByPath,
        pendingAutoIndex: { path: rememberedPath, createdAt: Date.now() }
      });
      return openTopDockWhenReady(tab.id);
    }
  }

  const response = await sendWhenBridgeReady(tab.id, { type: "library:toggleTopDock", open: true });
  if (response?.ok === false) throw new Error(response.error || "Could not toggle the Library Manager dock.");
  return response;
}

async function getToolbarFolderUrl(folderPath) {
  const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
  const remembered = validateLibraryFolderUrl(folderUrlsByPath[folderPath] || "");
  if (remembered) return remembered;

  const parts = String(folderPath || "").split(" / ").filter(Boolean);
  if (parts.length < 2) return "";
  const parentPath = parts.slice(0, -1).join(" / ");
  const name = parts.at(-1);
  const items = await getAllItems();
  const folder = items.find((item) => (
    item.kind === "folder"
    && item.folderPath === parentPath
    && item.name === name
  ));
  return validateLibraryFolderUrl(folder?.href || "");
}

function stripLibraryUrl(value) {
  try {
    const url = new URL(value, LIBRARY_URL);
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

async function sendWhenBridgeReady(tabId, payload) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(lastError?.message || "Reload the ChatGPT Library tab once, then click the extension icon again.");
}

async function openExplorer() {
  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter((tab) => tab.url?.startsWith(EXPLORER_URL));
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
    return { explorerTabId: tabs[0].id };
  }
  const tab = await chrome.tabs.create({ url: EXPLORER_URL });
  return { explorerTabId: tab.id };
}

async function findLibraryTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/library*" });
  const auxiliaryIds = new Set(await getAuxiliaryLibraryTabIds());
  const primaryTabs = tabs.filter((tab) => !auxiliaryIds.has(tab.id));
  return primaryTabs.find((tab) => tab.status === "complete") || primaryTabs[0] || null;
}

async function getConnectionState() {
  const tab = await findLibraryTab();
  if (!tab) return { connected: false, reason: "library-tab-not-open" };

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "library:ping" });
    return {
      connected: Boolean(response?.ready),
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      page: response?.page || null,
      scanState: activeScanState
    };
  } catch {
    return {
      connected: false,
      tabId: tab.id,
      reason: "bridge-not-ready",
      scanState: activeScanState
    };
  }
}

async function openLibrary() {
  const existing = await findLibraryTab();
  if (existing?.id) {
    const tab = await ensureAllLibraryRoute(existing);
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: LIBRARY_URL, active: true });
  return { tabId: tab.id, reused: false };
}

async function focusLibrary() {
  let tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library first.");
  tab = await ensureAllLibraryRoute(tab);
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  return { tabId: tab.id };
}

async function sendToLibrary(payload) {
  const tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library first.");
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    throw new Error("The Library bridge is not ready. Reload the ChatGPT Library tab once.");
  }
}

async function sendToAllLibrary(payload) {
  let tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library first.");
  tab = await ensureAllLibraryRoute(tab);
  try {
    return await sendWhenBridgeReady(tab.id, payload);
  } catch {
    throw new Error("The Library bridge is not ready. Reload the ChatGPT Library tab once.");
  }
}

async function ensureAllLibraryRoute(tab) {
  if (!tab?.id) return tab;
  let current;
  try {
    current = new URL(tab.url || LIBRARY_URL);
  } catch {
    return tab;
  }
  if (current.origin !== "https://chatgpt.com" || current.pathname.replace(/\/$/, "") !== "/library") {
    return tab;
  }
  if (current.searchParams.get("tab") === "all") return tab;

  current.searchParams.set("tab", "all");
  const completion = waitForNextTabComplete(tab.id);
  await chrome.tabs.update(tab.id, { url: current.href });
  await completion;
  return chrome.tabs.get(tab.id);
}

async function handleScanManagerMessage(managerPort, message) {
  if (message?.type === "status") {
    safePost(managerPort, activeScanState);
    return;
  }

  if (message?.type === "cancel") {
    if (activeLibraryPort && activeScanState.status === "scanning") {
      safePost(activeLibraryPort, { type: "cancel" });
    }
    return;
  }

  if (message?.type !== "start") return;
  if (activeLibraryPort && activeScanState.status === "scanning") {
    safePost(managerPort, activeScanState);
    return;
  }

  const tab = await findLibraryTab();
  if (!tab?.id) throw new Error("Open ChatGPT Library first.");

  activeScanState = {
    type: "status",
    status: "scanning",
    folderPath: message.folderPath || "Library",
    totalObserved: 0,
    pass: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  persistAndBroadcast(activeScanState);

  activeLibraryPort = chrome.tabs.connect(tab.id, { name: "library-scan" });
  activeLibraryTabId = tab.id;
  const thisLibraryPort = activeLibraryPort;

  thisLibraryPort.onMessage.addListener((event) => {
    scanWriteQueue = scanWriteQueue
      .then(() => handleLibraryScanEvent(thisLibraryPort, event))
      .catch((error) => finishScanWithError(error));
  });

  thisLibraryPort.onDisconnect.addListener(() => {
    const wasActive = activeLibraryPort === thisLibraryPort;
    if (wasActive) activeLibraryPort = null;
    if (wasActive && activeScanState.status === "scanning") {
      finishScanWithError(new Error("The Library scan bridge disconnected. Reload the ChatGPT Library tab."));
    }
  });

  const started = safePost(thisLibraryPort, {
    type: "start",
    expectedFolderPath: message.folderPath || "Library",
    knownSignatures: message.knownSignatures || {},
    knownItemPasses: message.knownItemPasses,
    deep: Boolean(message.deep)
  });
  if (!started) finishScanWithError(new Error("The Library scan bridge disconnected before indexing began."));
}

async function handleLibraryScanEvent(libraryPort, event) {
  if (!libraryPort || libraryPort !== activeLibraryPort) return;

  if (event?.type === "progress") {
    const items = event.items || [];
    await rememberFolderUrlsFromItems(items);
    await upsertItemsBatch(items, event.folderPath || "Library");
    const { items: omitted, ...progress } = event;
    activeScanState = {
      ...progress,
      type: "status",
      status: "scanning",
      batchCount: items.length,
      startedAt: activeScanState.startedAt,
      updatedAt: Date.now()
    };
    persistAndBroadcast({ ...activeScanState, type: "progress" });
    return;
  }

  if (event?.type === "complete") {
    await finalizeScan(event.result);
    activeScanState = {
      type: "status",
      status: "complete",
      ...event.result,
      totalObserved: event.result.itemCount,
      startedAt: activeScanState.startedAt,
      updatedAt: Date.now()
    };
    persistAndBroadcast({ ...activeScanState, type: "complete" });
    activeLibraryPort = null;
    activeLibraryTabId = null;
    try { libraryPort.disconnect(); } catch {}
    return;
  }

  if (event?.type === "cancelled") {
    activeScanState = {
      ...activeScanState,
      type: "status",
      status: "cancelled",
      totalObserved: event.totalObserved ?? activeScanState.totalObserved,
      updatedAt: Date.now()
    };
    persistAndBroadcast({ ...activeScanState, type: "cancelled" });
    activeLibraryPort = null;
    activeLibraryTabId = null;
    try { libraryPort.disconnect(); } catch {}
    return;
  }

  if (event?.type === "error") {
    finishScanWithError(new Error(event.error), {
      code: event.code || "index-failed",
      folderPath: event.folderPath || activeScanState.folderPath
    });
  }
}

async function rememberFolderUrlsFromItems(items) {
  const learned = items
    .filter((item) => item?.kind === "folder")
    .map((item) => ({
      path: `${item.folderPath || "Library"} / ${item.name || ""}`,
      url: validateLibraryFolderUrl(item.href || "")
    }))
    .filter((entry) => entry.path && entry.url);
  if (!learned.length) return;

  const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
  let changed = false;
  for (const entry of learned) {
    if (folderUrlsByPath[entry.path] === entry.url) continue;
    folderUrlsByPath[entry.path] = entry.url;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ folderUrlsByPath });
}

function finishScanWithError(error, metadata = {}) {
  activeScanState = {
    ...activeScanState,
    ...metadata,
    type: "status",
    status: "error",
    error: error.message,
    updatedAt: Date.now()
  };
  persistAndBroadcast({ ...activeScanState, type: "error" });
  if (activeLibraryPort) {
    const port = activeLibraryPort;
    activeLibraryPort = null;
    activeLibraryTabId = null;
    try { port.disconnect(); } catch {}
  }
}

function persistAndBroadcast(event) {
  chrome.storage.local.set({ scanRuntimeState: { ...activeScanState, type: "status" } });
  for (const port of managerScanPorts) safePost(port, event);
}

function safePost(port, message) {
  try {
    const result = port.postMessage(message);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
