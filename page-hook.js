(() => {
  "use strict";

  if (window.__chatgptLibraryManagerPageHook) return;
  window.__chatgptLibraryManagerPageHook = true;

  const FROM_EXTENSION = "chatgpt-library-manager-extension";
  const FROM_PAGE = "chatgpt-library-manager-page";
  const replayControllers = new Map();
  let captureActive = false;

  function post(type, payload = null) {
    window.postMessage({ source: FROM_PAGE, type, payload }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== FROM_EXTENSION) return;

    if (message.type === "capture-start") {
      captureActive = true;
      post("capture-ready");
      return;
    }
    if (message.type === "capture-stop") {
      captureActive = false;
      return;
    }
    if (message.type === "replay-delete") {
      replayDelete(message.payload).catch((error) => {
        post("replay-result", {
          requestId: message.payload?.requestId,
          status: 0,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }
    if (message.type === "cancel-replays") {
      for (const controller of replayControllers.values()) controller.abort();
      replayControllers.clear();
    }
  });

  async function replayDelete(payload) {
    const { requestId, savedTemplate, targetToken } = payload || {};
    if (!requestId || !savedTemplate || !/^libfile_[a-z0-9_-]+$/i.test(targetToken || "")) {
      throw new Error("The replay request did not contain a valid Library file identity.");
    }

    const { url, init } = buildReplayRequest(savedTemplate, targetToken);
    const controller = new AbortController();
    replayControllers.set(requestId, controller);
    init.signal = controller.signal;

    try {
      const response = await originalFetch(url, init);
      const details = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 240);
      post("replay-result", {
        requestId,
        status: response.status,
        ok: response.ok,
        retryAfter: response.headers.get("retry-after") || "",
        details
      });
    } catch (error) {
      post("replay-result", {
        requestId,
        status: 0,
        ok: false,
        aborted: error?.name === "AbortError",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      replayControllers.delete(requestId);
    }
  }

  function buildReplayRequest(savedTemplate, targetToken) {
    const { template, sourceFull, sourceRaw } = savedTemplate;
    if (!template?.url || !template?.method || !sourceFull || !sourceRaw) {
      throw new Error("The saved ChatGPT delete request is incomplete.");
    }

    const blockedHeaders = new Set([
      "accept-encoding", "connection", "content-length", "cookie", "host", "origin", "referer",
      "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "user-agent"
    ]);
    const headers = new Headers();
    for (const [name, value] of template.headers || []) {
      if (blockedHeaders.has(String(name).toLowerCase())) continue;
      try { headers.set(name, value); } catch {}
    }

    const targetRaw = targetToken.replace(/^libfile_/, "");
    const replace = (value) => String(value || "")
      .split(sourceFull).join(targetToken)
      .split(sourceRaw).join(targetRaw);
    const method = String(template.method).toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      throw new Error("A read-only request cannot be used as a deletion template.");
    }
    const body = replace(template.body || "");
    const init = { method, headers, credentials: "include", cache: "no-store" };
    if (!["GET", "HEAD"].includes(method) && body !== "") init.body = body;
    const url = new URL(replace(template.url), location.href);
    if (url.origin !== "https://chatgpt.com") {
      throw new Error("Delete request replay is restricted to chatgpt.com.");
    }
    return { url: url.href, init };
  }

  function emitCaptured(record) {
    if (captureActive) post("network-request", record);
  }

  async function bodyToText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    try {
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer);
    } catch {}
    try { return String(body); } catch { return ""; }
  }

  function serializeHeaders(value) {
    try { return [...new Headers(value || undefined).entries()]; } catch { return []; }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function libraryManagerFetch(input, init) {
    let requestClone = null;
    try { if (input instanceof Request) requestClone = input.clone(); } catch {}
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const headers = serializeHeaders(init?.headers || input?.headers);
    const bodyPromise = init && Object.prototype.hasOwnProperty.call(init, "body")
      ? bodyToText(init.body)
      : requestClone && !["GET", "HEAD"].includes(method)
        ? requestClone.text().catch(() => "")
        : Promise.resolve("");
    const startedAt = Date.now();
    const responsePromise = originalFetch(input, init);
    Promise.resolve(responsePromise).then(async (response) => {
      emitCaptured({
        transport: "fetch", url, method, headers, body: await bodyPromise, startedAt,
        endedAt: Date.now(), status: response.status, ok: response.ok
      });
    }, async (error) => {
      emitCaptured({
        transport: "fetch", url, method, headers, body: await bodyPromise, startedAt,
        endedAt: Date.now(), status: 0, ok: false, error: String(error)
      });
    });
    return responsePromise;
  };

  const XHR = window.XMLHttpRequest;
  if (!XHR) return;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetRequestHeader = XHR.prototype.setRequestHeader;
  XHR.prototype.open = function libraryManagerOpen(method, url, ...rest) {
    this.__libraryManagerMethod = String(method || "GET").toUpperCase();
    this.__libraryManagerUrl = String(url || "");
    this.__libraryManagerHeaders = [];
    return originalOpen.call(this, method, url, ...rest);
  };
  XHR.prototype.setRequestHeader = function libraryManagerHeader(name, value) {
    this.__libraryManagerHeaders ||= [];
    this.__libraryManagerHeaders.push([String(name), String(value)]);
    return originalSetRequestHeader.call(this, name, value);
  };
  XHR.prototype.send = function libraryManagerSend(body) {
    const startedAt = Date.now();
    this.addEventListener("loadend", () => {
      emitCaptured({
        transport: "xhr",
        url: this.__libraryManagerUrl || "",
        method: this.__libraryManagerMethod || "GET",
        headers: this.__libraryManagerHeaders || [],
        body: typeof body === "string" ? body : "",
        startedAt,
        endedAt: Date.now(),
        status: this.status,
        ok: this.status >= 200 && this.status < 300
      });
    }, { once: true });
    return originalSend.call(this, body);
  };
})();
