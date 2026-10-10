import { createServer, type Server } from "node:http";
import { mkdir, writeFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  stripOriginalsForWire,
  type ViewerDocument,
  type ViewerOriginals,
} from "./viewer-document.js";
import { VIEWER_PAGE_HTML } from "./viewer-page.js";
import { contextPruneDir } from "./paths.js";

/** Fixed port so every pi process opens the same local viewer. Override with PI_CONTEXT_PRUNE_VIEWER_PORT (tests). */
export function getViewerPort(): number {
  const raw = process.env.PI_CONTEXT_PRUNE_VIEWER_PORT;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 17342;
}
export function getViewerUrl(): string {
  return `http://127.0.0.1:${getViewerPort()}/`;
}
/** Bump when HTML shell changes; used to detect a stale in-memory server from an older pi process. */
export const VIEWER_UI_MARKER = 'data-pruner-viewer="5"';

// Tests must set PI_CONTEXT_PRUNE_HOME so they never clobber the live snapshot.
function viewerDir(): string {
  const override = process.env.PI_CONTEXT_PRUNE_HOME ?? process.env.OMP_CONTEXT_PRUNE_HOME;
  if (override && override.length > 0) return override;
  return contextPruneDir();
}

export function getViewerSnapshotPath(): string {
  return join(viewerDir(), "viewer-latest.json");
}
export function getViewerOriginalsPath(): string {
  return join(viewerDir(), "viewer-originals.json");
}
export function getViewerPagePath(): string {
  return join(viewerDir(), "viewer.html");
}

// Tab refcount: POST /api/hello ++, /api/bye --; last bye → delayed stop (refresh-safe).
// Heartbeat only renews lastSeen; 60s with no touch is a lost-bye fallback.
// Use node:http (not Bun.serve): Pi loads extensions under Node.
export const VIEWER_TAB_STOP_DELAY_MS = 300;
const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_CHECK_MS = 15_000;

type ServerHandle = {
  stop: () => void;
};

// Survive extension hot-reload: module locals reset, but the previous listen()
// stays bound on the same Node process. Keep the handle on globalThis so the
// next load can close it before binding again.
const GLOBAL_KEY = "__piContextPruneViewerServer";

type GlobalViewerState = {
  handle: ServerHandle | null;
  lastHeartbeat: number;
  tabCount: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setInterval> | null;
};

function globalState(): GlobalViewerState {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: GlobalViewerState;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      handle: null,
      lastHeartbeat: 0,
      tabCount: 0,
      stopTimer: null,
      idleTimer: null,
    };
  }
  return g[GLOBAL_KEY]!;
}

function clearStopTimer(): void {
  const s = globalState();
  if (s.stopTimer) {
    clearTimeout(s.stopTimer);
    s.stopTimer = null;
  }
}

function touchHeartbeat(): void {
  globalState().lastHeartbeat = Date.now();
}

/** Tab finished loading (or refreshed). Cancels a pending empty-stop. */
function onTabHello(): void {
  const s = globalState();
  clearStopTimer();
  s.tabCount += 1;
  touchHeartbeat();
}

/** Tab closed / navigated away. Last tab schedules a short delayed stop. */
function onTabBye(): void {
  const s = globalState();
  s.tabCount = Math.max(0, s.tabCount - 1);
  touchHeartbeat();
  if (s.tabCount > 0) return;
  clearStopTimer();
  s.stopTimer = setTimeout(() => {
    s.stopTimer = null;
    if (globalState().tabCount === 0) {
      stopViewerServer();
    }
  }, VIEWER_TAB_STOP_DELAY_MS);
  s.stopTimer.unref?.();
}

function getLocalServer(): ServerHandle | null {
  return globalState().handle;
}

function setLocalServer(handle: ServerHandle | null): void {
  globalState().handle = handle;
}

async function ensureDir(): Promise<void> {
  await mkdir(viewerDir(), { recursive: true });
}

/** Always rewrite the page asset so the next GET / picks up UI changes after extension reload. */
export async function publishViewerAssets(): Promise<void> {
  await ensureDir();
  const pagePath = getViewerPagePath();
  const tmp = `${pagePath}.tmp`;
  await writeFile(tmp, VIEWER_PAGE_HTML, "utf-8");
  await rename(tmp, pagePath);
}

export async function publishViewerDocument(doc: ViewerDocument): Promise<void> {
  await ensureDir();
  // Keep UI asset in sync with every publish (covers extension upgrades).
  await publishViewerAssets();
  const { document: wire, originals } = stripOriginalsForWire(doc);
  const snapPath = getViewerSnapshotPath();
  const snapTmp = `${snapPath}.tmp`;
  await writeFile(snapTmp, JSON.stringify(wire), "utf-8");
  await rename(snapTmp, snapPath);
  const origPath = getViewerOriginalsPath();
  const origTmp = `${origPath}.tmp`;
  await writeFile(origTmp, JSON.stringify(originals), "utf-8");
  await rename(origTmp, origPath);
  // Drop cache so next expand sees this publish even if mtime resolution is coarse.
  originalsCache = null;
}

// Cache full originals map by file mtime — /api/original used to re-parse the whole JSON per expand.
type OriginalsCache = { mtimeMs: number; map: ViewerOriginals };
let originalsCache: OriginalsCache | null = null;

async function readOriginalsMap(): Promise<ViewerOriginals | null> {
  try {
    const path = getViewerOriginalsPath();
    const st = await stat(path);
    if (originalsCache && originalsCache.mtimeMs === st.mtimeMs) {
      return originalsCache.map;
    }
    const raw = await readFile(path, "utf-8");
    const map = JSON.parse(raw) as ViewerOriginals;
    originalsCache = { mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    originalsCache = null;
    return null;
  }
}

async function readOriginalBody(id: string): Promise<string | null> {
  if (!id) return null;
  const map = await readOriginalsMap();
  if (!map || typeof map[id] !== "string") return null;
  return map[id];
}

async function readLatestSnapshot(): Promise<string> {
  try {
    return await readFile(getViewerSnapshotPath(), "utf-8");
  } catch {
    return JSON.stringify({
      sessionId: "empty",
      sessionLabel: "empty",
      timestamp: 0,
      rows: [],
      stats: {
        messageCount: 0,
        totalMessageCount: 0,
        prunedToolCount: 0,
        summaryCount: 0,
        branchEntryCount: 0,
        truncated: false,
      },
    });
  }
}

async function readPageHtml(): Promise<string> {
  try {
    return await readFile(getViewerPagePath(), "utf-8");
  } catch {
    return VIEWER_PAGE_HTML;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function isViewerUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${getViewerPort()}/api/health`, {
      signal: AbortSignal.timeout(400),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when the process on the viewer port is serving the current UI shell (not an old in-memory page). */
async function isViewerUiCurrent(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${getViewerPort()}/?probe=${Date.now()}`, {
      signal: AbortSignal.timeout(800),
      headers: { "cache-control": "no-store" },
    });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes(VIEWER_UI_MARKER);
  } catch {
    return false;
  }
}

/** Stop the in-process viewer server (last-tab / stale heartbeat / quit / tests). */
export function stopViewerServer(): void {
  const state = globalState();
  clearStopTimer();
  if (state.idleTimer) {
    clearInterval(state.idleTimer);
    state.idleTimer = null;
  }
  state.tabCount = 0;
  if (state.handle) {
    state.handle.stop();
    state.handle = null;
  }
}

/**
 * Pi fires session_shutdown on /new, /resume, /fork, reload, and quit.
 * Only quit means the process is going away — switch/reload must keep the
 * shared tree tab alive (handlers read HTML + latest from disk on each request).
 */
export function handleViewerSessionShutdown(reason: string): void {
  if (reason === "quit") {
    stopViewerServer();
  }
}

/** Lost-bye fallback: no hello/heartbeat/poll for HEARTBEAT_STALE_MS → stop. */
function armIdleWatch(): void {
  const state = globalState();
  if (state.idleTimer) return;
  state.idleTimer = setInterval(() => {
    const s = globalState();
    if (!s.handle) return;
    if (Date.now() - s.lastHeartbeat > HEARTBEAT_STALE_MS) {
      stopViewerServer();
    }
  }, HEARTBEAT_CHECK_MS);
  state.idleTimer.unref?.();
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers);
  res.end(body);
}

function startLocalServer(): Promise<void> {
  // Hot-reload leaves the previous listen() alive; always take ownership cleanly.
  if (getLocalServer()) {
    stopViewerServer();
  }

  const boot = globalState();
  boot.lastHeartbeat = Date.now();
  boot.tabCount = 0;
  clearStopTimer();

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", getViewerUrl());
      const method = req.method ?? "GET";

      void (async () => {
        try {
          if (url.pathname === "/api/health") {
            send(res, 200, "ok", { "cache-control": "no-store" });
            return;
          }
          // Tab boot: increment refcount (not on heartbeat — that would explode).
          if (url.pathname === "/api/hello" && method === "POST") {
            onTabHello();
            send(res, 200, "ok", { "cache-control": "no-store" });
            return;
          }
          if (url.pathname === "/api/heartbeat" && method === "POST") {
            touchHeartbeat();
            send(res, 200, "ok", { "cache-control": "no-store" });
            return;
          }
          if (url.pathname === "/api/bye" && (method === "POST" || method === "GET")) {
            onTabBye();
            send(res, 200, "ok", { "cache-control": "no-store" });
            return;
          }
          if (url.pathname === "/api/meta") {
            touchHeartbeat();
            const raw = await readLatestSnapshot();
            let meta = {
              sessionId: "empty",
              timestamp: 0,
              messageCount: 0,
            };
            try {
              const doc = JSON.parse(raw) as {
                sessionId?: string;
                timestamp?: number;
                stats?: { messageCount?: number };
              };
              meta = {
                sessionId: doc.sessionId ?? "empty",
                timestamp: doc.timestamp ?? 0,
                messageCount: doc.stats?.messageCount ?? 0,
              };
            } catch {
              // keep empty meta
            }
            send(res, 200, JSON.stringify(meta), {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            return;
          }
          if (url.pathname === "/api/original") {
            touchHeartbeat();
            const id = url.searchParams.get("id") ?? "";
            const text = await readOriginalBody(id);
            if (text == null) {
              send(res, 404, JSON.stringify({ error: "not found", id }), {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              return;
            }
            send(res, 200, JSON.stringify({ id, text }), {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            return;
          }
          if (url.pathname === "/api/latest") {
            touchHeartbeat();
            const body = await readLatestSnapshot();
            send(res, 200, body, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            return;
          }
          if (url.pathname === "/" || url.pathname === "/index.html") {
            touchHeartbeat();
            // Always read from disk so UI upgrades apply without restarting the handler body.
            const html = await readPageHtml();
            send(res, 200, html, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store, no-cache, must-revalidate",
              pragma: "no-cache",
            });
            return;
          }
          send(res, 404, "not found");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(res, 500, message);
        }
      })();
    });

    server.once("error", (err) => {
      reject(err);
    });

    server.listen(getViewerPort(), "127.0.0.1", () => {
      setLocalServer({
        stop: () => {
          // Drop open sockets so the port frees immediately on reload/shutdown.
          const anyServer = server as Server & { closeAllConnections?: () => void };
          anyServer.closeAllConnections?.();
          server.close();
        },
      });
      armIdleWatch();
      resolve();
    });
  });
}

export type OpenViewerOptions = {
  /** Open the system browser. Default true. Tests must pass false. */
  openBrowser?: boolean;
  /** Open even when the shared server is already up. */
  forceOpen?: boolean;
};

export type OpenViewerResult = {
  url: string;
  openedBrowser: boolean;
  alreadyRunning: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensure the shared localhost viewer is up with the *current* UI.
 * Publish the snapshot before calling this.
 *
 * Never kill other OS processes. Auto-kill previously took down live pi sessions
 * (and their chats) that happened to own the port.
 */
export async function openViewer(options: OpenViewerOptions = {}): Promise<OpenViewerResult> {
  await publishViewerAssets();

  let alreadyRunning = false;

  if (await isViewerUp()) {
    if (await isViewerUiCurrent()) {
      // Healthy shared server (ours or another process with current UI) — reuse.
      alreadyRunning = true;
    } else if (getLocalServer()) {
      // We own a stale handler (hot-reload left old routes). Rebind this process only.
      stopViewerServer();
      await sleep(50);
    } else {
      throw new Error(
        `port ${getViewerPort()} still serves an old viewer UI from another/stuck process. ` +
          `Close that pi session, or free the port manually:\n` +
          `  kill $(lsof -t -iTCP:${getViewerPort()} -sTCP:LISTEN)`,
      );
    }
  }

  if (!alreadyRunning) {
    try {
      await startLocalServer();
    } catch (err) {
      if (await isViewerUp() && (await isViewerUiCurrent())) {
        alreadyRunning = true;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to start pruner viewer on ${getViewerUrl()}: ${message}. ` +
            `If the port is busy: kill $(lsof -t -iTCP:${getViewerPort()} -sTCP:LISTEN)`,
        );
      }
    }
  }

  if (!(await isViewerUiCurrent())) {
    throw new Error(
      `pruner viewer UI marker missing after start — check ${getViewerPagePath()}`,
    );
  }

  touchHeartbeat();
  const url = `${getViewerUrl()}?v=${Date.now()}`;

  // Only auto-open when we had to start the server, unless caller forceOpen.
  const shouldOpen =
    options.openBrowser !== false && (options.forceOpen === true || !alreadyRunning);
  if (shouldOpen) {
    openBrowser(url);
  }
  return { url, openedBrowser: shouldOpen, alreadyRunning };
}

/** Test/smoke helper: stop any in-process server. */
export function __stopViewerServerForTests(): void {
  stopViewerServer();
}

// Extension hot-reload re-evaluates this module: close any prior handle immediately.
stopViewerServer();
