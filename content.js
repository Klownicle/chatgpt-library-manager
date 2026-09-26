(() => {
  if (globalThis.__chatgptLibraryManagerBridge) return;
  globalThis.__chatgptLibraryManagerBridge = true;

  let folderPathHint = "Library";
  let hydratedFolderRoute = "";
  let scanInProgress = false;
  let topDockState = null;
  let topDockReady = false;
  let pendingDeleteConfirmation = false;
  let deleteReplayCancelled = false;
  let captureStartedAt = 0;
  let capturedRequests = [];
  let captureReadyResolver = null;
  const replayRequests = new Map();
  const cachedPreviewByImage = new WeakMap();
  const cachedPreviewBySource = new Map();

  const PAGE_HOOK_SOURCE = "chatgpt-library-manager-page";
  const EXTENSION_HOOK_SOURCE = "chatgpt-library-manager-extension";

  document.addEventListener("click", observeNativeDeleteConfirmation, true);
  window.addEventListener("message", handlePageHookMessage);
  window.addEventListener("message", handleDockFrameMessage);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "library-scan") return;
    let cancelled = false;
    let disconnected = false;

    port.onDisconnect.addListener(() => {
      disconnected = true;
      cancelled = true;
    });
    port.onMessage.addListener((message) => {
      if (message?.type === "cancel") {
        cancelled = true;
        return;
      }
      if (message?.type !== "start") return;

      if (scanInProgress) {
        reportScanEvent({ type: "error", error: "An index scan is already running." });
        return;
      }

      scanInProgress = true;
      scanCurrentFolder({
        expectedFolderPath: message.expectedFolderPath || "",
        knownSignatures: message.knownSignatures || {},
        knownItemPasses: message.knownItemPasses,
        deep: Boolean(message.deep),
        isCancelled: () => cancelled,
        onProgress: (progress) => {
          if (!cancelled) reportScanEvent(progress);
        }
      }).then((result) => {
        if (cancelled) {
          if (!disconnected) reportScanEvent({
            type: "cancelled",
            folderPath: result.folderPath,
            totalObserved: result.items.length
          });
          return;
        }
        const { items, ...summary } = result;
        reportScanEvent({
          type: "complete",
          result: { ...summary, itemCount: items.length }
        });
      }).catch((error) => {
        if (cancelled) {
          if (!disconnected) reportScanEvent({ type: "cancelled" });
        } else reportScanEvent({
          type: "error",
          error: error.message,
          code: error.code || "index-failed",
          folderPath: error.folderPath || detectFolderPath()
        });
      }).finally(() => {
        scanInProgress = false;
      });
    });
  });

  function reportScanEvent(event) {
    void sendRuntimeMessageSafely({ type: "library:scanEvent", event });
  }

  function sendRuntimeMessageSafely(message, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "Extension message timed out." }), timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          let runtimeError = null;
          try { runtimeError = chrome.runtime.lastError; } catch {}
          finish(runtimeError
            ? { ok: false, error: runtimeError.message || "Extension message failed." }
            : response);
        });
      } catch (error) {
        finish({ ok: false, error: error.message });
      }
    });
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "library:ping":
        await ensureListView();
        await hydrateFolderPathHintFromUrl();
        return { ready: true, page: describePage() };
      case "library:scanCurrentFolder":
        if (scanInProgress) throw new Error("An index scan is already running.");
        scanInProgress = true;
        try {
          return await scanCurrentFolder(message);
        } finally {
          scanInProgress = false;
        }
      case "library:enterFolder":
        return activateItem(message, "folder");
      case "library:setFolderPathHint":
        folderPathHint = normalizeFolderPath(message.folderPath || "Library");
        hydratedFolderRoute = location.pathname;
        return { ok: true, page: describePage() };
      case "library:openItem":
        return activateItem(message, "file");
      case "library:deleteItemNative":
        return deleteItemNative(message.item || {});
      case "library:calibrateDeleteRequest":
        return calibrateDeleteRequest(message.item || {});
      case "library:replayDeleteItems":
        return replayDeleteItems(message);
      case "library:cancelDeleteReplay":
        deleteReplayCancelled = true;
        postToPageHook("cancel-replays");
        return { cancelled: true };
      case "library:toggleTopDock":
        return toggleTopDock(message.open);
      case "library:closeTopDock":
        return closeTopDock();
      case "library:getDockState":
        return { open: Boolean(topDockState), ready: Boolean(topDockState && topDockReady), height: topDockState?.height || 0 };
      default:
        throw new Error("Unknown Library bridge message.");
    }
  }

  function handlePageHookMessage(event) {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== PAGE_HOOK_SOURCE) return;
    if (message.type === "capture-ready") {
      captureReadyResolver?.();
      captureReadyResolver = null;
      return;
    }
    if (message.type === "network-request") {
      capturedRequests.push(message.payload);
      if (capturedRequests.length > 300) capturedRequests.splice(0, capturedRequests.length - 300);
      return;
    }
    if (message.type === "replay-result") {
      const pending = replayRequests.get(message.payload?.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      replayRequests.delete(message.payload.requestId);
      pending.resolve(message.payload);
    }
  }

  function handleDockFrameMessage(event) {
    const message = event.data;
    if (!message || message.source !== "chatgpt-library-manager-dock" || message.type !== "ready") return;
    if (!topDockState?.frame || event.source !== topDockState.frame.contentWindow) return;
    topDockReady = true;
  }

  function postToPageHook(type, payload = null) {
    window.postMessage({ source: EXTENSION_HOOK_SOURCE, type, payload }, "*");
  }

  async function startNetworkCapture() {
    capturedRequests = [];
    captureStartedAt = Date.now();
    const ready = new Promise((resolve) => { captureReadyResolver = resolve; });
    postToPageHook("capture-start");
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }

  function stopNetworkCapture() {
    captureReadyResolver = null;
    postToPageHook("capture-stop");
  }

  function describePage() {
    return {
      isLibrary: location.pathname.startsWith("/library"),
      libraryTab: new URL(location.href).searchParams.get("tab") || "suggested",
      folderPath: detectFolderPath(),
      title: document.title,
      visibleRows: collectRowElements().length,
      emptyFolder: isExplicitEmptyLibraryView()
    };
  }

  function observeNativeDeleteConfirmation(event) {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button || button !== findDeleteConfirmButton() || pendingDeleteConfirmation) return;

    const items = collectSelectedFilesForDeletion();
    if (!items.length) return;
    pendingDeleteConfirmation = true;
    verifyNativeDeletion(items).finally(() => { pendingDeleteConfirmation = false; });
  }

  function collectSelectedFilesForDeletion() {
    const folderPath = normalizeFolderPath(detectFolderPath());
    return collectRowElements()
      .filter((row) => isRowSelected(row))
      .map((row) => extractItem(row, folderPath))
      .filter((item) => item?.kind === "file")
      .map(({ id, name, folderPath: itemFolderPath, signature }) => ({
        id,
        name,
        folderPath: itemFolderPath,
        signature
      }));
  }

  async function verifyNativeDeletion(items) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const confirmButton = findDeleteConfirmButton();
      if (confirmButton) continue;

      const renderedIds = new Set(
        collectItems(normalizeFolderPath(detectFolderPath())).map((item) => item.id)
      );
      if (items.some((item) => renderedIds.has(item.id))) continue;

      await sendRuntimeMessageSafely({
        type: "library:confirmedItemsDeleted",
        items
      });
      return;
    }
  }

  async function deleteItemNative(item) {
    const prepared = await prepareNativeDelete(item);

    pendingDeleteConfirmation = true;
    try {
      prepared.confirmButton.click();
      await waitForNativeDeletion(item);
    } finally {
      pendingDeleteConfirmation = false;
    }

    return { deleted: true, item };
  }

  async function calibrateDeleteRequest(item) {
    await startNetworkCapture();
    let prepared;
    try {
      prepared = await prepareNativeDelete(item);
      const sourceFull = prepared.match.item.remoteToken || extractRemoteToken(prepared.match.row);
      if (!sourceFull) throw new Error("The calibration file has no readable libfile identity. Update this folder’s index first.");
      const sourceRaw = sourceFull.replace(/^libfile_/, "");
      captureStartedAt = Date.now();
      pendingDeleteConfirmation = true;
      prepared.confirmButton.click();
      let request = null;
      let calibrationError = "";
      try {
        request = await waitForValue(
          () => chooseCapturedDeleteRequest(sourceFull, sourceRaw),
          30000,
          "The file was deleted, but its authenticated request could not be identified."
        );
      } catch (error) {
        calibrationError = error.message;
      }
      await waitForNativeDeletion(item);
      if (!request) return { deleted: true, item, calibrationError };
      return {
        deleted: true,
        item,
        savedTemplate: {
          template: {
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: request.body
          },
          sourceFull,
          sourceRaw,
          calibratedAt: Date.now()
        }
      };
    } finally {
      pendingDeleteConfirmation = false;
      stopNetworkCapture();
    }
  }

  async function prepareNativeDelete(item) {
    if (!item?.id || !item?.name) throw new Error("The selected cached file has no stable identity.");
    let match = findRenderedFile(item);
    if (!match) {
      await searchLibrary(item.name);
      match = await waitForRenderedFile(item, 15000);
    }
    if (!match) throw new Error(`Could not find the exact file “${item.name}” in ChatGPT.`);
    const bridge = findSelectionControl(match.row, item);
    if (!bridge) throw new Error(`Could not select “${item.name}” using ChatGPT’s current Library controls.`);
    bridge.click();
    await waitForValue(() => isRowSelected(match.row, bridge), 5000,
      `ChatGPT did not select “${item.name}”.`);
    const deleteButton = await waitForValue(findBulkDeleteButton, 8000,
      "ChatGPT did not expose its Delete action for the selected file.");
    deleteButton.click();
    const confirmButton = await waitForValue(findDeleteConfirmButton, 120000,
      "ChatGPT did not make its final Delete confirmation available.");
    return { match, confirmButton };
  }

  async function waitForNativeDeletion(item) {
    return waitForValue(() => {
      if (findDeleteConfirmButton()) return false;
      return !findRenderedFile(item);
    }, 120000, `ChatGPT did not confirm that “${item.name}” was deleted.`);
  }

  function chooseCapturedDeleteRequest(sourceFull, sourceRaw) {
    const candidates = capturedRequests.filter((request) => {
      if ((request.startedAt || 0) < captureStartedAt - 250) return false;
      if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
      if (!request.ok) return false;
      const combined = `${request.url || ""}\n${request.body || ""}`;
      return combined.includes(sourceFull) || combined.includes(sourceRaw);
    });
    return candidates.map((request) => {
      const combined = `${request.url || ""}\n${request.body || ""}`;
      let score = 0;
      if (combined.includes(sourceFull)) score += 120;
      if (combined.includes(sourceRaw)) score += 80;
      if (request.method === "DELETE") score += 80;
      if (/delete|trash|recall/i.test(request.url || "")) score += 50;
      if (/library|file|artifact/i.test(request.url || "")) score += 25;
      if (/telemetry|analytics|track|event|log/i.test(request.url || "")) score -= 200;
      return { request, score };
    }).sort((a, b) => b.score - a.score)[0]?.request || null;
  }

  async function replayDeleteItems({ items = [], savedTemplate, concurrency = 5, maxRetries = 6 }) {
    if (!savedTemplate) throw new Error("Calibrate the delete request with one disposable file first.");
    const queue = items.filter((item) => item?.id && /^libfile_[a-z0-9_-]+$/i.test(item.remoteToken || ""));
    if (queue.length !== items.length) throw new Error("One or more selected files need their folder index updated to capture a stable libfile identity.");
    deleteReplayCancelled = false;
    let nextIndex = 0;
    let processed = 0;
    let deleted = 0;
    let absent = 0;
    let failed = 0;
    let expiredTemplate = false;
    const results = [];

    async function worker() {
      while (!deleteReplayCancelled) {
        const index = nextIndex++;
        if (index >= queue.length) return;
        const item = queue[index];
        const startedAt = Date.now();
        const result = await deleteTokenWithRetries(item.remoteToken, savedTemplate, maxRetries);
        const durationMs = Date.now() - startedAt;
        processed += 1;
        if (result.status === "deleted") deleted += 1;
        else if (result.status === "absent") absent += 1;
        else failed += 1;
        if (result.expiredTemplate) expiredTemplate = true;
        const completed = { item, ...result, durationMs };
        results.push(completed);
        await sendRuntimeMessageSafely({
          type: "library:deleteProgress",
          progress: { processed, total: queue.length, deleted, absent, failed, expiredTemplate, completed }
        });
        if (expiredTemplate) {
          deleteReplayCancelled = true;
          postToPageHook("cancel-replays");
          return;
        }
      }
    }

    const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), 30, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { processed, total: queue.length, deleted, absent, failed, expiredTemplate, cancelled: deleteReplayCancelled, results };
  }

  async function deleteTokenWithRetries(targetToken, savedTemplate, maxRetries) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (deleteReplayCancelled) return { status: "failed", error: "Cancelled", attempts: attempt };
      const response = await replayDeleteOnce(savedTemplate, targetToken);
      if (response.ok) return { status: "deleted", attempts: attempt + 1, httpStatus: response.status };
      if ([404, 409].includes(response.status)) return { status: "absent", attempts: attempt + 1, httpStatus: response.status };
      if ([401, 403].includes(response.status)) {
        return { status: "failed", attempts: attempt + 1, httpStatus: response.status, expiredTemplate: true,
          error: `The calibrated request expired (${response.status}). Recalibration is required.` };
      }
      const retryable = response.status === 0 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries || response.aborted) {
        return { status: "failed", attempts: attempt + 1, httpStatus: response.status,
          error: response.error || response.details || `Delete failed (${response.status || "network error"}).` };
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, response.retryAfter)));
    }
    return { status: "failed", error: "Delete retry limit reached." };
  }

  function replayDeleteOnce(savedTemplate, targetToken) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        replayRequests.delete(requestId);
        resolve({ requestId, status: 0, ok: false, error: "The delete request timed out." });
      }, 45000);
      replayRequests.set(requestId, { resolve, timeout });
      postToPageHook("replay-delete", { requestId, savedTemplate, targetToken });
    });
  }

  function retryDelay(attempt, retryAfterValue) {
    const retryAfter = Number(retryAfterValue);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30000, retryAfter * 1000);
    return Math.min(20000, 350 * (2 ** attempt) + Math.floor(Math.random() * 300));
  }

  function findRenderedFileByExactId(id) {
    const folderPath = detectFolderPath();
    const rows = collectRowElements();
    for (const row of rows) {
      const item = extractItem(row, folderPath);
      if (item?.kind === "file" && item.id === id) return { row, item, rows };
    }
    return null;
  }

  function findRenderedFile(item) {
    const exact = findRenderedFileByExactId(item.id);
    if (exact) return exact;
    const folderPath = detectFolderPath();
    const rows = collectRowElements();
    const matches = rows.map((row) => ({ row, item: extractItem(row, folderPath), rows }))
      .filter((match) => match.item?.kind === "file")
      .filter((match) => (
        (item.remoteToken && match.item.remoteToken === item.remoteToken)
        || normalizeText(match.item.name) === normalizeText(item.name)
      ));
    return matches.length === 1 ? matches[0] : null;
  }

  async function waitForExactRenderedFile(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let match = findRenderedFileByExactId(id);
    while (!match && Date.now() < deadline) {
      throwIfLibraryLoadFailed();
      await new Promise((resolve) => setTimeout(resolve, 250));
      match = findRenderedFileByExactId(id);
    }
    return match;
  }

  async function waitForRenderedFile(item, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let match = findRenderedFile(item);
    while (!match && Date.now() < deadline) {
      throwIfLibraryLoadFailed();
      await new Promise((resolve) => setTimeout(resolve, 250));
      match = findRenderedFile(item);
    }
    return match;
  }

  function findSelectionControl(row, item = {}) {
    const controls = [...row.querySelectorAll([
      'button[data-testid^="artifact-checkbox-bridge-libfile_"]',
      'input[type="checkbox"]',
      '[role="checkbox"]',
      'button[aria-label^="Select " i]'
    ].join(","))].filter(isVisible);
    const expected = normalizeText(`Select ${item.name || ""}`).toLowerCase();
    return controls.find((control) => normalizeText(control.getAttribute("aria-label")).toLowerCase() === expected)
      || controls.find((control) => /^select\s+/i.test(control.getAttribute("aria-label") || ""))
      || controls[0]
      || null;
  }

  function isRowSelected(row, control = findSelectionControl(row)) {
    if (row.getAttribute("aria-selected") === "true") return true;
    if (!control) return false;
    if (control instanceof HTMLInputElement && control.checked) return true;
    return control.getAttribute("aria-checked") === "true"
      || control.getAttribute("data-state") === "checked"
      || control.hasAttribute("checked");
  }

  function findDeleteConfirmButton() {
    const legacy = document.querySelector('[data-testid="confirm-delete-recall-file-button"]');
    if (legacy && isEnabledButton(legacy)) return legacy;
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(isVisible);
    for (const dialog of dialogs) {
      const buttons = [...dialog.querySelectorAll("button")].filter((button) => {
        if (!isVisible(button) || !isEnabledButton(button)) return false;
        const description = normalizeText(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
        return /^(?:confirm\s+)?delete(?:\s+(?:file|files|item|items))?$/i.test(description);
      });
      if (buttons.length) return buttons.at(-1);
    }
    return null;
  }

  function isEnabledButton(button) {
    return !button.disabled
      && !button.hasAttribute("disabled")
      && button.getAttribute("aria-disabled") !== "true"
      && !button.hasAttribute("data-visually-disabled");
  }

  function findBulkDeleteButton() {
    const candidates = [...document.querySelectorAll("button")].filter((button) => {
      if (!isVisible(button)) return false;
      if (button === findDeleteConfirmButton() || button.closest('[role="dialog"], [aria-modal="true"]')) return false;
      if (button.closest("[data-page-table-row-actions]")) return false;
      const description = normalizeText(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
      return /(^|\s)(delete|trash|remove)(\s|$)/i.test(description);
    });
    candidates.sort((a, b) => {
      const exact = (button) => /^delete(?:\s*\(\d+\))?$/i.test(normalizeText(button.textContent));
      return Number(exact(b)) - Number(exact(a));
    });
    return candidates[0] || null;
  }

  async function waitForValue(getValue, timeoutMs, errorMessage) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(errorMessage);
  }

  async function scanCurrentFolder({
    expectedFolderPath = "",
    knownSignatures = {},
    knownItemPasses = 2,
    deep = false,
    isCancelled = () => false,
    onProgress = () => {}
  }) {
    if (!location.pathname.startsWith("/library")) {
      throw new Error("Navigate this tab to chatgpt.com/library first.");
    }

    await ensureListView(true);

    throwIfLibraryLoadFailed();

    const folderPath = normalizeFolderPath(detectFolderPath());
    const intendedPath = expectedFolderPath ? normalizeFolderPath(expectedFolderPath) : folderPath;
    if (folderPath !== intendedPath) {
      const error = new Error(
        `Indexing was blocked because ChatGPT is showing “${folderPath}”, but the manager requested “${intendedPath}”.`
      );
      error.code = "folder-mismatch";
      error.folderPath = intendedPath;
      throw error;
    }
    const collected = new Map();
    const emittedSignatures = new Map();
    const originalPositions = new Map();
    let stoppedAtKnownItem = false;
    let complete = false;
    let unchangedPasses = 0;
    let knownBoundaryPasses = 0;
    let pass = 0;
    let movedAtLeastOnce = false;
    let bottomStablePasses = 0;
    let lastSurfaceSnapshot = [];
    const incrementalMode = Object.keys(knownSignatures).length > 0;
    const requiredKnownItemPasses = clampKnownItemPasses(knownItemPasses);
    const scrollDelayRange = await getScrollDelayRange();
    const scanOrderBase = Date.now();
    let incrementalNewOrder = 0;

    if (deep) {
      ensureScanOptimizationStyles();
      const initialSurfaces = findScrollSurfaces();
      rememberSurfacePositions(initialSurfaces, originalPositions);
      for (const surface of initialSurfaces) setSurfacePosition(surface, 0);
      window.scrollTo({ top: 0, behavior: "auto" });
      await waitForListChange(450);
    }

    while (pass < (deep ? 1000 : 1)) {
      if (isCancelled()) throw new Error("Indexing was cancelled.");
      throwIfLibraryLoadFailed();
      pass += 1;
      const beforeCount = collected.size;
      const visibleRows = collectRowElements(pass === 1 ? 0 : 720);
      const visibleItems = await collectItemsWithPortablePreviews(folderPath, visibleRows);
      const batch = [];
      let reachedKnownBoundary = false;
      let discoveredUncachedThisPass = false;

      for (const item of visibleItems) {
        const existingCollected = collected.get(item.id);
        const mergedItem = mergeObservedItem(existingCollected, item);
        const known = knownSignatures[item.id];
        const isUnchangedKnown = Boolean(known && known === mergedItem.signature);
        if (!existingCollected && !isUnchangedKnown) discoveredUncachedThisPass = true;
        const orderedItem = {
          ...mergedItem,
          sourceOrder: existingCollected?.sourceOrder
            ?? (incrementalMode && !isUnchangedKnown
              ? -scanOrderBase + incrementalNewOrder++
              : collected.size),
          preserveSourceOrder: incrementalMode && isUnchangedKnown
        };
        collected.set(orderedItem.id, orderedItem);
        const emissionFingerprint = hashString([
          orderedItem.signature,
          orderedItem.previewUrl || "",
          orderedItem.remoteToken || ""
        ].join("|"));
        if (emittedSignatures.get(orderedItem.id) !== emissionFingerprint) {
          emittedSignatures.set(orderedItem.id, emissionFingerprint);
          batch.push(orderedItem);
        }
        if (isUnchangedKnown) {
          reachedKnownBoundary = true;
        }
      }

      unchangedPasses = collected.size === beforeCount ? unchangedPasses + 1 : 0;
      knownBoundaryPasses = reachedKnownBoundary && !discoveredUncachedThisPass
        ? knownBoundaryPasses + 1
        : 0;

      if (!deep) break;

      const surfaces = findScrollSurfaces(visibleRows);
      rememberSurfacePositions(surfaces, originalPositions);
      lastSurfaceSnapshot = surfaces.map(describeSurface);
      const primary = surfaces[0] || null;
      const renderedTailVisible = isRenderedLibraryTailVisible(visibleRows, primary?.element);
      const atBottom = Boolean(
        surfaces.length
        && surfaces.every((surface) => {
          const tolerance = Math.max(96, Math.min(180, surface.viewport * 0.2));
          return surface.position >= surface.maximum - tolerance;
        })
      );

      onProgress({
        type: "progress",
        folderPath,
        items: batch,
        totalObserved: collected.size,
        pass,
        unchangedPasses,
        knownBoundaryPasses,
        requiredKnownItemPasses,
        waitingForVisibility: false,
        renderedRows: visibleRows.length,
        thumbnailCount: [...collected.values()].filter((item) => item.previewUrl).length,
        renderedTailVisible,
        atBottom,
        scroll: primary ? {
          position: Math.round(primary.position),
          maximum: Math.round(primary.maximum),
          viewport: Math.round(primary.viewport),
          surfaceCount: surfaces.length
        } : null
      });

      // ChatGPT renders a real empty-state instead of any file rows for an
      // empty folder. That is a verified end, not an incomplete scan.
      if (visibleItems.length === 0 && isExplicitEmptyLibraryView()) {
        complete = true;
        break;
      }

      // A populated folder whose complete rendered tail fits in the viewport
      // does not need to scroll. This also covers ChatGPT wrapping a two-row
      // list in a larger unrelated page scroller.
      if (renderedTailVisible && unchangedPasses >= 4 && !isLibraryListLoading()) {
        complete = true;
        break;
      }

      // The Library is normally sorted newest-first. Continue beyond the first
      // unchanged cached row for the configured number of clean verification
      // passes so a temporarily sparse/lazy render does not stop the update early.
      if (incrementalMode && knownBoundaryPasses >= requiredKnownItemPasses) {
        stoppedAtKnownItem = true;
        break;
      }

      bottomStablePasses = atBottom && unchangedPasses > 0 ? bottomStablePasses + 1 : 0;
      // A short folder can expose a scroll container that is already at its
      // maximum, so no programmatic movement is possible. Four unchanged
      // cooldown passes at the real bottom are still sufficient verification.
      if (bottomStablePasses >= 4) {
        complete = true;
        break;
      }

      if (!primary && collected.size > 0 && unchangedPasses >= 4) {
        complete = true;
        break;
      }

      const movedThisPass = await advanceScroll(surfaces, visibleRows);
      movedAtLeastOnce ||= movedThisPass;
      if (movedThisPass || atBottom) await waitForScrollCooldown(scrollDelayRange);
      else await waitForListChange(850);

      // Never claim completion when no actual scrolling surface was moved.
      // Repeatedly nudge the last row because many lazy lists observe that row,
      // rather than the document's raw scrollTop.
      if (!movedThisPass && unchangedPasses >= 7) break;
    }

    if (deep) {
      restoreSurfacePositions(originalPositions);
      await waitForListChange(100);
    }

    if (deep && !complete && !stoppedAtKnownItem) {
      const error = new Error("The Library index stopped before it could verify the end of this folder.");
      error.code = "index-incomplete";
      throw error;
    }

    return {
      ok: true,
      folderPath,
      items: [...collected.values()],
      complete,
      stoppedAtKnownItem,
      knownBoundaryPasses,
      requiredKnownItemPasses,
      passes: pass,
      strategy: deep ? "multi-surface-lazy-scroll" : "visible-rows",
      diagnostics: {
        movedAtLeastOnce,
        unchangedPasses,
        observedRows: collected.size,
        surfaces: lastSurfaceSnapshot
      }
    };
  }

  function mergeObservedItem(existing, incoming) {
    if (!existing) return incoming;
    const merged = {
      ...existing,
      ...incoming,
      modified: incoming.modified || existing.modified || "",
      size: incoming.size || existing.size || "",
      extension: incoming.extension || existing.extension || "",
      href: incoming.href || existing.href || "",
      previewUrl: incoming.previewUrl || existing.previewUrl || "",
      remoteToken: incoming.remoteToken || existing.remoteToken || ""
    };
    merged.signature = hashString(
      `${merged.name}|${merged.modified}|${merged.size}|${merged.kind}|${merged.href}`
    );
    return merged;
  }

  function throwIfLibraryLoadFailed() {
    const main = document.querySelector("main") || document.body;
    const retryButton = [...main.querySelectorAll("button")].find((button) => (
      /^try again$/i.test(normalizeText(button.textContent))
    ));
    if (!retryButton) return;
    const failureRegion = retryButton.parentElement?.parentElement || retryButton.parentElement || main;
    const text = normalizeText(failureRegion.textContent);
    if (!/failed to load files\.?/i.test(text)) return;
    const error = new Error("ChatGPT reported “Failed to load files” while indexing this folder.");
    error.code = "library-load-failed";
    throw error;
  }

  function isExplicitEmptyLibraryView() {
    const main = document.querySelector("main") || document.body;
    const text = normalizeText(main.innerText || main.textContent);
    return /upload a file to start building your library\.?/i.test(text)
      || /this folder is empty\.?/i.test(text)
      || /no files (?:in|inside) this folder\.?/i.test(text);
  }

  function isLibraryListLoading() {
    const main = document.querySelector("main") || document.body;
    const busy = [...main.querySelectorAll("[aria-busy='true'], [role='progressbar'], [role='status']")]
      .some((element) => isVisible(element) && /load|progress|busy/i.test(
        normalizeText(`${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`)
      ));
    if (busy) return true;
    const text = normalizeText(main.innerText || main.textContent);
    return /(?:loading|fetching) (?:more )?(?:files|library items)/i.test(text);
  }

  function isRenderedLibraryTailVisible(rows, scrollElement = null) {
    if (!rows.length) return false;
    const lastRow = rows
      .slice()
      .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom)
      .pop();
    if (!lastRow) return false;
    const rowRect = lastRow.getBoundingClientRect();
    const surfaceRect = scrollElement?.getBoundingClientRect?.();
    const visibleTop = Math.max(0, surfaceRect?.top ?? 0);
    const visibleBottom = Math.min(window.innerHeight, surfaceRect?.bottom ?? window.innerHeight);
    return rowRect.top >= visibleTop - 4 && rowRect.bottom <= visibleBottom + 4;
  }

  function collectItems(folderPath, rows = collectRowElements()) {
    const seen = new Set();
    const items = [];
    for (const row of rows) {
      const item = extractItem(row, folderPath);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  async function collectItemsWithPortablePreviews(folderPath, rows = collectRowElements()) {
    const seen = new Set();
    const items = [];
    const observed = await Promise.all(rows.map(async (row) => {
      const item = extractItem(row, folderPath);
      if (!item || item.previewUrl) return item;
      const previewUrl = await extractPortablePreview(row);
      return previewUrl ? { ...item, previewUrl } : item;
    }));
    for (const item of observed) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  async function ensureListView(requireReady = false) {
    const deadline = Date.now() + (requireReady ? 15000 : 2500);
    let clicked = false;
    while (Date.now() < deadline) {
      if (isListViewLayout()) return true;
      const listButton = [...document.querySelectorAll("button, [role='button']")].find((button) => (
        isVisible(button)
        && normalizeText(button.getAttribute("aria-label") || button.textContent).toLowerCase() === "list view"
      ));
      if (listButton && !clicked) {
        const alreadySelected = listButton.getAttribute("aria-pressed") === "true"
          || listButton.getAttribute("aria-selected") === "true"
          || listButton.getAttribute("data-state") === "on";
        if (!alreadySelected) listButton.click();
        clicked = true;
      }
      throwIfLibraryLoadFailed();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (requireReady) {
      throw new Error("ChatGPT did not finish preparing List view within 15 seconds. Reload the Library and try again.");
    }
    return false;
  }

  function isListViewLayout() {
    const headers = [...document.querySelectorAll("[role='columnheader'], th")]
      .map((header) => normalizeText(header.textContent || header.getAttribute("aria-label")))
      .filter(Boolean);
    return headers.some((header) => /^name$/i.test(header))
      && headers.some((header) => /^modified$/i.test(header))
      && headers.some((header) => /^size$/i.test(header));
  }

  function ensureScanOptimizationStyles() {
    if (document.querySelector("#chatgpt-library-manager-scan-optimizations")) return;
    const style = document.createElement("style");
    style.id = "chatgpt-library-manager-scan-optimizations";
    style.textContent = `
      main [role="row"] {
        content-visibility: auto;
        contain-intrinsic-size: auto 60px;
      }
    `;
    document.documentElement.append(style);
  }

  function collectRowElements(tailLimit = 0) {
    const root = document.querySelector("main") || document.body;
    const semanticCards = [...root.querySelectorAll([
      'input[type="checkbox"][aria-label^="Select " i]',
      '[role="checkbox"][aria-label^="Select " i]',
      'button[aria-label^="Select " i]'
    ].join(","))]
      .map((control) => findLibraryCard(control, root))
      .filter(Boolean);
    let explicitCandidates = [
      ...root.querySelectorAll(
        "tbody tr, [role='row'], [data-testid*='library-item' i], [data-testid*='file-row' i]"
      ),
      ...semanticCards
    ];
    if (tailLimit > 0 && explicitCandidates.length > tailLimit) {
      explicitCandidates = explicitCandidates.slice(-tailLimit);
    }
    const explicit = explicitCandidates.filter(isPlausibleRow);

    if (explicit.length) return mostSpecificRows(explicit);

    const heuristic = [...root.querySelectorAll("div, li")].filter((element) => {
      if (!isPlausibleRow(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.height < 34 || rect.height > 104) return false;
      if (rect.width < Math.min(420, window.innerWidth * 0.55)) return false;
      if (!element.querySelector("img, svg")) return false;
      const text = normalizeText(element.innerText || element.textContent);
      return text.length > 1 && text.length < 700;
    });

    return mostSpecificRows(heuristic);
  }

  function findLibraryCard(control, root) {
    const selectedName = normalizeText(control.getAttribute("aria-label")).replace(/^select\s+/i, "");
    let current = control.parentElement;
    while (current && current !== root) {
      const labels = [...current.querySelectorAll("button[aria-label], a[aria-label]")]
        .map((element) => normalizeText(element.getAttribute("aria-label")));
      const hasActions = labels.some((label) => /^open actions? menu for\s+/i.test(label));
      const hasMatchingItem = !selectedName || labels.some((label) => (
        label === selectedName
        || label.toLowerCase() === `open folder ${selectedName}`.toLowerCase()
        || label.toLowerCase() === `open file ${selectedName}`.toLowerCase()
      ));
      if (hasActions && hasMatchingItem) return current;
      current = current.parentElement;
    }
    return control.closest("[role='row'], li, [data-testid*='library-item' i], [data-testid*='file-row' i]");
  }

  function mostSpecificRows(rows) {
    const unique = [...new Set(rows)];
    return unique.filter(
      (candidate) => !unique.some((other) => other !== candidate && candidate.contains(other))
    );
  }

  function isPlausibleRow(element) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
    if (element.querySelectorAll("[role='columnheader'], th").length >= 2) return false;
    const text = normalizeText(element.innerText || element.textContent);
    if (!text || /^(?:select all\s+)?name\s+modified\s+size$/i.test(text)
      || /^(name|modified|size)$/i.test(text)) return false;
    if (/^(?:filter|filters|parent folders?|back to parent folder)$/i.test(text)) return false;
    if (/\b(search|upload|new)\b/i.test(text) && text.length < 30) return false;
    return true;
  }

  function extractItem(row, folderPath) {
    const lines = String(row.innerText || row.textContent || "")
      .split(/\r?\n/)
      .map(normalizeText)
      .filter(Boolean);
    if (!lines.length) return null;

    const directCells = [...row.children].filter((element) => element.getAttribute("role") === "gridcell");
    const semanticLabels = [...row.querySelectorAll("button[aria-label], a[aria-label], [role='checkbox'][aria-label], input[aria-label]")]
      .map((element) => normalizeText(element.getAttribute("aria-label")))
      .filter(Boolean);
    const directName = semanticLabels.find((label) => !/^(?:open actions? menu for|select)\s+/i.test(label));
    const selectedName = semanticLabels.find((label) => /^select\s+/i.test(label))?.replace(/^select\s+/i, "");
    const actionName = semanticLabels.find((label) => /^open actions? menu for\s+/i.test(label))
      ?.replace(/^open actions? menu for\s+/i, "");
    const semanticName = directName || selectedName || actionName || "";
    const semanticModified = normalizeText(directCells[2]?.innerText || directCells[2]?.textContent);
    const semanticSize = normalizeText(directCells[3]?.innerText || directCells[3]?.textContent);
    const combined = normalizeText(`${semanticName} ${row.getAttribute("aria-label") || ""} ${lines.join(" ")}`);
    const size = isFileSize(semanticSize)
      ? semanticSize
      : (lines.find(isFileSize) || "");
    const modified = looksLikeModifiedDate(semanticModified)
      ? semanticModified
      : (lines.find(looksLikeModifiedDate) || "");
    const hrefElement = row.matches("a[href]") ? row : row.querySelector("a[href]");
    const href = hrefElement?.href || "";
    const name = cleanNameCandidate(semanticName, modified, size)
      || extractFullName(row, lines, modified, size, href);
    if (!name || name.length > 360) return null;
    if (/^(?:filter|filters)$/i.test(name) && !modified && !size && !href) return null;
    if (/^(?:parent folders?|back to parent folder)$/i.test(name)) return null;

    const hasFileExtension = /\.[a-z0-9]{1,10}$/i.test(name.trim());
    const folderSignal = /\bfolder\b/i.test(combined) || /\/folder(?:s)?\//i.test(href);
    const emptySizeSignal = semanticSize === "—"
      || lines.includes("—")
      || directCells.some((cell) => normalizeText(cell.innerText || cell.textContent) === "—");
    const kind = folderSignal || (!hasFileExtension && !size && emptySizeSignal) ? "folder" : "file";
    const previewUrl = extractPreviewUrl(row);
    const remoteToken = extractRemoteToken(row);
    const stableDomId = getStableDomId(row);
    const identitySeed = stableDomId || href || `${folderPath}|${kind}|${name}`;
    const id = `lib_${hashString(identitySeed)}`;
    const signature = hashString(`${name}|${modified}|${size}|${kind}|${href}`);

    return {
      id,
      signature,
      kind,
      name,
      modified,
      size,
      folderPath,
      href,
      previewUrl,
      remoteToken,
      extension: kind === "file" ? getExtension(name) : "",
      indexedAt: Date.now()
    };
  }

  function extractRemoteToken(row) {
    const owner = row.closest("[data-library-selection-id]");
    const direct = owner?.getAttribute("data-library-selection-id") || "";
    if (/^libfile_[a-z0-9_-]+$/i.test(direct)) return direct;
    const markup = `${row.outerHTML || ""} ${owner?.outerHTML || ""}`;
    const token = markup.match(/\blibfile_[a-z0-9_-]+\b/i)?.[0] || "";
    return /^libfile_[a-z0-9_-]+$/i.test(token) ? token : "";
  }

  function extractPreviewUrl(row) {
    const directCandidates = [];
    for (const image of row.querySelectorAll("img")) {
      directCandidates.push(
        image.currentSrc,
        image.src,
        image.getAttribute("data-src"),
        image.getAttribute("data-lazy-src"),
        image.getAttribute("data-thumbnail-url")
      );
    }
    for (const source of row.querySelectorAll("source[srcset], img[srcset]")) {
      const srcset = source.getAttribute("srcset") || "";
      directCandidates.push(...srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]));
    }
    for (const element of [row, ...row.querySelectorAll([
      "[data-src]",
      "[data-thumbnail-url]",
      "[style*='background-image']",
      "[class*='thumbnail' i]",
      "[class*='preview' i]"
    ].join(","))]) {
      directCandidates.push(
        element.getAttribute?.("data-src"),
        element.getAttribute?.("data-thumbnail-url")
      );
      const background = getComputedStyle(element).backgroundImage || "";
      const match = background.match(/url\(["']?(.+?)["']?\)/i);
      if (match) directCandidates.push(match[1]);
    }
    const candidates = directCandidates.map((value) => String(value || "").trim()).filter(Boolean);
    return candidates.find((value) => /^(?:https?:|data:image\/)/i.test(value))
      || "";
  }

  async function extractPortablePreview(row) {
    for (const image of row.querySelectorAll("img")) {
      const source = String(image.currentSrc || image.src || "").trim();
      if (!source) continue;
      if (/^(?:https?:|data:image\/)/i.test(source)) return source;
      if (!source.startsWith("blob:")) continue;

      const cachedForImage = cachedPreviewByImage.get(image);
      if (cachedForImage?.source === source) {
        return cachedForImage.promise ? await cachedForImage.promise : (cachedForImage.value || "");
      }
      if (cachedPreviewBySource.has(source)) return cachedPreviewBySource.get(source) || "";

      const promise = convertBlobPreview(source, image);
      cachedPreviewByImage.set(image, { source, promise, value: "" });
      const value = await promise;
      cachedPreviewByImage.set(image, { source, promise: null, value });
      if (value) cachedPreviewBySource.set(source, value);
      return value;
    }
    return "";
  }

  async function convertBlobPreview(source, image) {
    try {
      const response = await fetch(source);
      if (!response.ok) return makePortablePreviewFromCanvas(image);
      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve(makePortablePreviewFromCanvas(image));
        reader.readAsDataURL(blob);
      });
    } catch {
      return makePortablePreviewFromCanvas(image);
    }
  }

  function makePortablePreviewFromCanvas(image) {
    if (!(image instanceof HTMLImageElement)
      || !image.complete
      || !image.naturalWidth
      || !image.naturalHeight) return "";
    try {
      const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
      const scale = Math.min(1, 256 / longestSide);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return "";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.78);
    } catch {
      return "";
    }
  }

  function extractFullName(row, lines, modified, size, href) {
    const candidates = new Set();
    const add = (value) => {
      const cleaned = cleanNameCandidate(value, modified, size);
      if (cleaned) candidates.add(cleaned);
    };

    const metadataIndex = lines.findIndex((line) => line === modified || line === size || line === "—");
    const nameLines = (metadataIndex > 0 ? lines.slice(0, metadataIndex) : lines)
      .filter((line) => !/^(name|modified|size)$/i.test(line));
    nameLines.forEach(add);
    if (nameLines.length > 1) {
      add(nameLines.join(""));
      add(nameLines.join(" "));
    }

    const attributeSelectors = [
      "[title]",
      "[aria-label]",
      "[data-filename]",
      "[data-file-name]",
      "[data-name]",
      "[download]",
      "[alt]",
      "[class*='truncate']",
      "[class*='ellipsis']",
      "[role='cell']",
      "[role='gridcell']",
      "td"
    ].join(",");

    const elements = [row, ...row.querySelectorAll(attributeSelectors)];
    for (const element of elements) {
      add(element.getAttribute?.("title"));
      add(element.getAttribute?.("aria-label"));
      add(element.getAttribute?.("data-filename"));
      add(element.getAttribute?.("data-file-name"));
      add(element.getAttribute?.("data-name"));
      add(element.getAttribute?.("download"));
      add(element.getAttribute?.("alt"));
      if (element !== row) add(element.textContent);
    }

    if (href) {
      try {
        const url = new URL(href, location.href);
        for (const key of ["filename", "file_name", "name", "title"]) add(url.searchParams.get(key));
        url.pathname.split("/").map(decodeURIComponent).forEach(add);
      } catch {
        // A malformed or app-relative link is not useful as a filename source.
      }
    }

    return [...candidates]
      .filter(isPlausibleName)
      .sort((a, b) => scoreNameCandidate(b) - scoreNameCandidate(a))[0] || "";
  }

  function cleanNameCandidate(value, modified, size) {
    let candidate = normalizeText(value);
    if (!candidate) return "";
    for (const metadata of [modified, size]) {
      if (metadata) candidate = candidate.replace(metadata, " ");
    }
    candidate = candidate
      .replace(/^(?:open|preview|select|download|view)\s+(?:(?:file|folder)\s+)?/i, "")
      .replace(/\s+(?:actions?|options?|menu)$/i, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return candidate;
  }

  function isPlausibleName(value) {
    if (!value || value.length > 360) return false;
    if (/^(name|modified|size|—|more|actions?|options?)$/i.test(value)) return false;
    if (/^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(value)) return false;
    if (isFileSize(value)) return false;
    return true;
  }

  function scoreNameCandidate(value) {
    let score = Math.min(value.length, 360);
    if (/\.[a-z0-9]{1,10}$/i.test(value)) score += 10000;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/i.test(value)) score += 3000;
    if (/\b(?:open|preview|select|download|actions?|options?|modified|size)\b/i.test(value)) score -= 5000;
    if (/https?:\/\//i.test(value)) score -= 8000;
    return score;
  }

  function getStableDomId(row) {
    const keys = ["librarySelectionId", "pageTableSelectionId", "fileId", "folderId", "itemId", "id"];
    let current = row;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      for (const key of keys) {
        const value = current.dataset?.[key] || (key === "id" ? current.id : "");
        if (value && !/^headlessui|^radix/i.test(value)) return `${key}:${value}`;
      }
    }
    return "";
  }

  async function activateItem({ id, name }, expectedKind, allowSearch = true) {
    let match = findRenderedItem(id, name, expectedKind);
    if (!match && expectedKind === "folder") {
      match = await waitForRenderedItem(id, name, expectedKind, 20000);
    }
    if (!match && expectedKind === "file" && allowSearch) {
      const hasSearchQuery = new URL(location.href).searchParams.has("search");
      if (!hasSearchQuery) await searchLibrary(name);
      match = await waitForRenderedItem(id, name, expectedKind, 10000);
    }
    if (!match) throw new Error(`Could not find ${expectedKind} “${name}” in the loaded Library results.`);

    const { row, item, rows } = match;
    const beforePathname = location.pathname;
    const targets = row.matches("a, button") ? [row] : [...row.querySelectorAll("a, button")];
    const expectedFolderLabel = `open folder ${item.name}`.toLowerCase();
    const target = (expectedKind === "folder"
      ? targets.find((element) => normalizeText(element.getAttribute("aria-label")).toLowerCase() === expectedFolderLabel)
      : null)
      || targets.find((element) => normalizeText(element.getAttribute("aria-label")) === item.name)
      || targets.find((element) => normalizeText(element.textContent) === item.name)
      || targets.find((element) => !/^open actions? menu/i.test(element.getAttribute("aria-label") || ""))
      || row;
    if (expectedKind === "folder") {
      const folderPath = detectFolderPath();
      folderPathHint = `${folderPath} / ${item.name}`;
      target.scrollIntoView({ block: "center" });
      // Reply to the background before ChatGPT destroys this document during
      // a full folder navigation. The background verifies the new URL and
      // waits for the next page's rows before continuing a nested chain.
      setTimeout(() => {
        if (target.isConnected) target.click();
      }, 0);
      return { ok: true, activated: item, navigationStarted: true, beforePathname };
    }
    target.scrollIntoView({ block: "center" });
    await waitForListChange(100);
    target.click();
    return { ok: true, activated: item };
  }

  async function waitForRenderedItem(id, name, expectedKind, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let match = findRenderedItem(id, name, expectedKind);
    while (!match && Date.now() < deadline) {
      throwIfLibraryLoadFailed();
      await new Promise((resolve) => setTimeout(resolve, 250));
      match = findRenderedItem(id, name, expectedKind);
    }
    return match;
  }

  function findRenderedItem(id, name, expectedKind) {
    const folderPath = detectFolderPath();
    const rows = collectRowElements();
    for (const row of rows) {
      const item = extractItem(row, folderPath);
      if (!item || item.kind !== expectedKind) continue;
      if ((id && item.id === id) || item.name === name) return { row, item, rows };
    }

    if (expectedKind === "folder") {
      const expectedLabel = `open folder ${name}`.toLowerCase();
      const control = [...document.querySelectorAll("button[aria-label], a[aria-label]")].find((element) => (
        isVisible(element)
        && normalizeText(element.getAttribute("aria-label")).toLowerCase() === expectedLabel
      ));
      if (control) {
        const row = control.closest("[role='row'], tr, [data-testid*='library-item' i], [data-testid*='file-row' i]")
          || control.parentElement;
        if (row) {
          const extracted = extractItem(row, folderPath);
          const item = extracted?.kind === "folder"
            ? extracted
            : {
                id: id || `lib_${hashString(`${folderPath}|folder|${name}`)}`,
                kind: "folder",
                name,
                folderPath
              };
          return { row, item, rows: rows.length ? rows : [row] };
        }
      }
    }
    return null;
  }

  async function searchLibrary(name) {
    const input = document.querySelector(
      "input[type='search'], input[placeholder*='search' i], [role='searchbox']"
    );
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, name);
    else input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForListChange(900);
    return true;
  }

  function detectFolderPath() {
    const breadcrumb = document.querySelector(
      "nav[aria-label*='breadcrumb' i], [data-testid*='breadcrumb' i]"
    );
    if (breadcrumb) {
      const parts = [...breadcrumb.querySelectorAll("a, button, [aria-current]")]
        .map((element) => normalizeText(element.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" / ");
    }
    return folderPathHint;
  }

  async function hydrateFolderPathHintFromUrl() {
    if (hydratedFolderRoute === location.pathname) return;
    hydratedFolderRoute = location.pathname;
    if (!location.pathname.startsWith("/library/d/")) {
      folderPathHint = "Library";
      return;
    }
    try {
      const { folderUrlsByPath = {} } = await chrome.storage.local.get("folderUrlsByPath");
      const match = Object.entries(folderUrlsByPath).find(([, value]) => {
        try {
          const url = new URL(value, location.origin);
          return url.origin === location.origin && url.pathname === location.pathname;
        } catch {
          return false;
        }
      });
      if (match?.[0]) folderPathHint = normalizeFolderPath(match[0]);
    } catch {}
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

  async function toggleTopDock(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !topDockState;
    if (!shouldOpen) return closeTopDock();
    // Recreate an existing dock when an explicit open request arrives. This
    // replaces a stale/blank extension frame after an extension reload.
    if (topDockState) closeTopDock();

    await ensureListView();

    const main = document.querySelector("main, [role='main']");
    const pageShell = [...document.body.children].find((element) => (
      element.id !== "chatgpt-library-manager-top-dock"
      && main
      && (element === main || element.contains(main))
    )) || main?.parentElement;
    if (!pageShell) throw new Error("Could not locate the ChatGPT page shell for docking.");

    const { topDockHeight = 340 } = await chrome.storage.local.get("topDockHeight");
    const height = Math.max(220, Math.min(Math.round(window.innerHeight * 0.68), topDockHeight));
    const host = document.createElement("div");
    host.id = "chatgpt-library-manager-top-dock";
    Object.assign(host.style, {
      position: "fixed",
      zIndex: "2147483646",
      inset: "0 0 auto 0",
      height: `${height}px`,
      background: "#080a0c",
      borderBottom: "1px solid #343c44",
      boxShadow: "0 12px 36px rgba(0,0,0,.38)"
    });

    const shadow = host.attachShadow({ mode: "open" });
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("explorer.html?mode=topdock");
    frame.title = "ChatGPT Library Manager";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block" });
    const resizeHandle = document.createElement("div");
    resizeHandle.title = "Drag to resize Library Manager";
    Object.assign(resizeHandle.style, {
      position: "absolute",
      zIndex: "2",
      left: "0",
      right: "0",
      bottom: "-4px",
      height: "9px",
      cursor: "ns-resize",
      background: "transparent"
    });
    shadow.append(frame, resizeHandle);
    topDockReady = false;

    const original = {
      height: pageShell.style.height,
      marginTop: pageShell.style.marginTop,
      maxHeight: pageShell.style.maxHeight
    };
    const applyHeight = (nextHeight) => {
      const bounded = Math.max(220, Math.min(Math.round(window.innerHeight * 0.75), nextHeight));
      host.style.height = `${bounded}px`;
      pageShell.style.height = `calc(100svh - ${bounded}px)`;
      pageShell.style.maxHeight = `calc(100svh - ${bounded}px)`;
      pageShell.style.marginTop = `${bounded}px`;
      if (topDockState) topDockState.height = bounded;
      window.dispatchEvent(new Event("resize"));
      return bounded;
    };

    let dragStartY = 0;
    let dragStartHeight = height;
    const onPointerMove = (event) => applyHeight(dragStartHeight + event.clientY - dragStartY);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      if (topDockState) chrome.storage.local.set({ topDockHeight: topDockState.height });
    };
    resizeHandle.addEventListener("pointerdown", (event) => {
      dragStartY = event.clientY;
      dragStartHeight = topDockState?.height || height;
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      event.preventDefault();
    });

    topDockState = { host, frame, pageShell, original, height, onPointerMove, onPointerUp };
    document.body.append(host);
    applyHeight(height);
    try {
      await waitForValue(
        () => topDockReady,
        6000,
        "The Library Manager dock did not finish loading. Reload the ChatGPT Library tab and try again."
      );
    } catch (error) {
      closeTopDock();
      throw error;
    }
    return { open: true, ready: true, height };
  }

  function closeTopDock() {
    if (!topDockState) return { open: false };
    const { host, pageShell, original, onPointerMove, onPointerUp } = topDockState;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    pageShell.style.height = original.height;
    pageShell.style.maxHeight = original.maxHeight;
    pageShell.style.marginTop = original.marginTop;
    host.remove();
    topDockState = null;
    topDockReady = false;
    window.dispatchEvent(new Event("resize"));
    return { open: false };
  }

  function findScrollSurfaces(rows = collectRowElements()) {
    const primary = findPrimaryLibraryScroller(rows);
    if (primary) return [describeScrollableElement(primary, rows)];

    const elements = new Set();
    if (document.scrollingElement) elements.add(document.scrollingElement);

    for (const row of rows) {
      let current = row.parentElement;
      while (current) {
        elements.add(current);
        current = current.parentElement;
      }
    }

    document.querySelectorAll(
      "[data-radix-scroll-area-viewport], [data-virtuoso-scroller], [class*='scroll'], main, [role='main']"
    ).forEach((element) => elements.add(element));

    return [...elements]
      .filter((element) => element instanceof HTMLElement)
      .map((element) => {
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        const style = getComputedStyle(element);
        const rowsInside = rows.filter((row) => element.contains(row)).length;
        const ancestorDistance = rows.reduce((nearest, row) => {
          if (!element.contains(row)) return nearest;
          let current = row;
          let distance = 0;
          while (current && current !== element && distance < 1000) {
            current = current.parentElement;
            distance += 1;
          }
          return current === element ? Math.min(nearest, distance) : nearest;
        }, 1000);
        const overflowBonus = /(auto|scroll|overlay)/.test(style.overflowY) ? 1000000000000 : 0;
        const proximityBonus = Math.max(0, 1000 - ancestorDistance) * 1000000;
        const score = overflowBonus + proximityBonus + rowsInside * 1000 + maximum;
        return {
          element,
          position: element.scrollTop,
          maximum,
          viewport: element.clientHeight || window.innerHeight,
          rowsInside,
          ancestorDistance,
          overflowY: style.overflowY,
          score
        };
      })
      .filter((surface) => (
        surface.maximum > 3
        && surface.viewport > 80
        && surface.rowsInside > 0
        && (surface.element === document.scrollingElement || !/(hidden|clip)/.test(surface.overflowY))
      ))
      .sort((a, b) => b.score - a.score);
  }

  function findPrimaryLibraryScroller(rows) {
    const grid = document.querySelector("[role='grid'][aria-label*='library files' i], [role='grid'][aria-label*='library' i]")
      || rows[0]?.closest("[role='grid']");
    let current = grid?.parentElement || rows[0]?.parentElement || null;
    let bestFallback = null;
    while (current && current !== document.documentElement) {
      const maximum = Math.max(0, current.scrollHeight - current.clientHeight);
      if (maximum > 3 && current.clientHeight > 80) {
        const overflowY = getComputedStyle(current).overflowY;
        if (/(auto|scroll|overlay)/.test(overflowY)) return current;
        if (!bestFallback && !/(hidden|clip)/.test(overflowY)) bestFallback = current;
      }
      current = current.parentElement;
    }
    return bestFallback;
  }

  function describeScrollableElement(element, rows) {
    const style = getComputedStyle(element);
    const rowsInside = rows.filter((row) => element.contains(row)).length;
    return {
      element,
      position: element.scrollTop,
      maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      viewport: element.clientHeight || window.innerHeight,
      rowsInside,
      ancestorDistance: 0,
      overflowY: style.overflowY,
      score: Number.MAX_SAFE_INTEGER
    };
  }

  function rememberSurfacePositions(surfaces, originalPositions) {
    for (const surface of surfaces) {
      if (!originalPositions.has(surface.element)) {
        originalPositions.set(surface.element, surface.element.scrollTop);
      }
    }
  }

  function restoreSurfacePositions(originalPositions) {
    for (const [element, top] of originalPositions) {
      if (!element.isConnected) continue;
      element.scrollTop = top;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }

  function setSurfacePosition(surface, top) {
    const before = surface.element.scrollTop;
    const target = Math.max(0, Math.min(surface.maximum, top));
    if (surface.element === document.scrollingElement) {
      window.scrollTo({ top: target, behavior: "auto" });
    } else if (typeof surface.element.scrollTo === "function") {
      surface.element.scrollTo({ top: target, behavior: "auto" });
    } else {
      surface.element.scrollTop = target;
    }
    surface.element.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));
    return Math.abs(surface.element.scrollTop - before) > 1;
  }

  async function advanceScroll(surfaces, rows) {
    const startingPositions = new Map(surfaces.map((surface) => [surface.element, surface.element.scrollTop]));

    for (const surface of surfaces) {
      const step = Math.max(320, surface.viewport * 0.72);
      try {
        surface.element.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: step,
          view: window
        }));
      } catch {}
      setSurfacePosition(surface, surface.element.scrollTop + step);
    }

    const lastRow = rows
      .slice()
      .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom)
      .pop();
    if (lastRow) {
      lastRow.scrollIntoView({ block: "end", inline: "nearest", behavior: "auto" });
    }

    // IntersectionObserver-based lists often load only after their sentinel sees
    // a scroll/resize cycle, even if setting scrollTop already changed the view.
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Some React scroll containers restore their previous position during the
    // same frame. Reapply the nudge once after layout and verify real movement.
    for (const surface of surfaces) {
      const start = startingPositions.get(surface.element) || 0;
      if (surface.element.scrollTop <= start + 1 && start < surface.maximum - 1) {
        setSurfacePosition(surface, start + Math.max(320, surface.viewport * 0.72));
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return surfaces.some((surface) => (
      Math.abs(surface.element.scrollTop - (startingPositions.get(surface.element) || 0)) > 1
    ));
  }

  function describeSurface(surface) {
    const element = surface.element;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      testId: element.getAttribute("data-testid") || "",
      overflowY: surface.overflowY,
      position: Math.round(element.scrollTop),
      maximum: Math.round(Math.max(0, element.scrollHeight - element.clientHeight)),
      viewport: Math.round(element.clientHeight),
      rowsInside: surface.rowsInside,
      ancestorDistance: surface.ancestorDistance
    };
  }

  function waitForListChange(milliseconds) {
    return new Promise((resolve) => {
      const rows = collectRowElements();
      const root = rows[0]?.closest("[role='grid']")
        || findPrimaryLibraryScroller(rows)
        || document.querySelector("main")
        || document.body;
      let quietTimer;
      let hardTimer;
      const done = () => {
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, 180);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      quietTimer = setTimeout(done, milliseconds);
      hardTimer = setTimeout(done, Math.max(1400, milliseconds * 2));
    });
  }

  async function getScrollDelayRange() {
    let maximumSeconds = 12;
    try {
      const setting = await chrome.storage.local.get("scrollDelayMaxSeconds");
      maximumSeconds = Number(setting.scrollDelayMaxSeconds ?? 12);
    } catch {}
    maximumSeconds = Math.max(5, Math.min(60, Math.round(maximumSeconds) || 12));
    return {
      minimumMs: (maximumSeconds - 4) * 1000,
      maximumMs: maximumSeconds * 1000
    };
  }

  async function waitForScrollCooldown({ minimumMs, maximumMs }) {
    const cooldown = minimumMs + Math.floor(Math.random() * (maximumMs - minimumMs + 1));
    const startedAt = Date.now();
    await waitForListChange(Math.min(1400, cooldown));
    const remaining = cooldown - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  function waitForPageVisible(isCancelled) {
    return new Promise((resolve) => {
      let cancellationTimer;
      const finish = () => {
        clearInterval(cancellationTimer);
        document.removeEventListener("visibilitychange", check);
        resolve();
      };
      const check = () => {
        if (!document.hidden || isCancelled()) finish();
      };
      document.addEventListener("visibilitychange", check);
      cancellationTimer = setInterval(check, 700);
      check();
    });
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function looksLikeModifiedDate(value) {
    return /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(value)
      || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}(?:,\s*\d{4})?$/i.test(value)
      || /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(value);
  }

  function isFileSize(value) {
    return /^\d[\d,]*(?:\.\d+)?\s*(?:bytes?|kb|mb|gb|tb)$/i.test(value);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clampKnownItemPasses(value) {
    return Math.max(2, Math.min(100, Math.round(Number(value)) || 2));
  }

  function getExtension(name) {
    return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
})();
