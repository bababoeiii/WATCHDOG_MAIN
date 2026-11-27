// HTTP: the sub-server API, and the website (portal.js) — which is also the Telegram Mini App.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPortal } from "./portal.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** @param portalDeps { events, accounts, notify, botUsername } — the website (login page at /); omit to leave it out */
export function createServer(cfg, monitor, notifier, updateMain, portalDeps = null) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // aaPanel/nginx on the same machine
  app.use(express.json({ limit: "256kb" }));

  // ---------------------------------------------------------------- sub servers: per-server token
  const agentAuth = (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    const server = m && monitor.authenticate(m[1].trim());
    if (!server) return res.status(401).json({ error: "invalid or revoked token" });
    req.server = server;
    next();
  };

  // ---------------------------------------------------------------- sub server API
  app.post("/api/agent/report", agentAuth, (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(422).json({ error: "JSON body required" });
    const { update } = monitor.handleReport(req.server, req.body);
    res.json({ ok: true, id: req.server.id, name: req.server.name, update });
  });

  app.post("/api/agent/goodbye", agentAuth, (req, res) => {
    monitor.handleGoodbye(req.server, String(req.body?.reason || ""));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- website (login page at /)
  const portal = portalDeps ? createPortal({ app, cfg, monitor, notifier, publicDir: PUBLIC_DIR, updateMain, ...portalDeps }) : null;

  // ---------------------------------------------------------------- misc + static
  app.get("/healthz", (req, res) => res.json({ ok: true, servers: monitor.list().length, db: monitor.store.dbOk !== false }));

  // malformed JSON or other request errors: a short JSON answer instead of an HTML error page
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`${req.method} ${req.path}:`, err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.type || err.message });
  });

  // ---------------------------------------------------------------- WebSocket (the website's live updates)
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/ws/web" && portal) return portal.handleUpgrade(req, socket, head); // nginx proxies /ws*
    socket.destroy();
  });

  /** Monitor changes (server updated / removed) → the website's live clients. */
  const broadcast = (message) => portal?.onServerChange(message);

  /** Stop accepting connections and close every open one (dashboard sockets included). */
  const close = () =>
    new Promise((resolve) => {
      portal?.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, broadcast, close };
}
