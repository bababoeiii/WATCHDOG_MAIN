// Website (the login page is the home page, /): log in with a password + second step or with Telegram, then see the
// notifications of the servers you may see, live. Staff and owners add servers and reboot them;
// owners manage accounts. Roles:
//   owner — every server, main-server events, activity log, accounts
//   staff — assigned servers; can add servers (assigned to them) and reboot their servers
//   user  — assigned servers, read only
import path from "node:path";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { KINDS } from "./events.js";
import { MIN_PASSWORD, ROLE_LABEL, verifyTelegramLogin } from "./accounts.js";

const COOKIE = "wd_session";
const REBOOT_WAIT_S = 120; // a reboot request is dropped if the server doesn't pick it up in time

/** No Origin header (same-site navigation, curl) is fine; a different or unparsable one is not. */
function sameOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param o.app        express app
 * @param o.cfg, o.monitor, o.notifier, o.events (EventLog), o.accounts (Accounts)
 * @param o.notify     (text, important, meta) => void — logs + Telegram, like the monitor's
 * @param o.botUsername () => string|null — for the Telegram login button
 * @param o.publicDir  folder with portal.html
 */
export function createPortal({ app, cfg, monitor, notifier, events, accounts, notify, botUsername, publicDir }) {
  // ---------------------------------------------------------------- who may see what
  const canSeeServer = (who, id) => who.servers === null || who.servers.has(id);
  const canSee = (who, e) => (e.kind === "audit" ? who.role === "owner" : e.server ? canSeeServer(who, e.server) : who.role === "owner");
  const mayOperate = (who) => who.role === "owner" || who.role === "staff";
  const audit = (who, text, server = null) => events.add({ kind: "audit", text, server, actor: who?.name || "?" });

  const serverView = (s) => {
    const sum = monitor.summary(s);
    const now = Date.now() / 1000;
    return {
      id: s.id, name: s.name, status: s.status, status_since: s.statusSince, last_seen: s.lastSeen,
      offline_reason: s.offlineReason, alerts: sum.alerts, version: s.version?.commit || null,
      allow_reboot: Boolean(s.allowReboot), reboot_pending: Boolean(s.pendingReboot && s.pendingReboot.expires > now),
      metrics: s.payload || null, // the latest report: CPU, RAM, disks, temperatures, network, processes …
    };
  };
  const meView = (who) => ({
    name: who.name, role: who.role, role_label: ROLE_LABEL[who.role],
    servers: who.servers === null ? null : [...who.servers], can_operate: mayOperate(who), is_owner: who.role === "owner",
    self_id: who.accountId || null,
  });
  const origin = (req) => cfg.publicUrl || `${req.protocol}://${req.get("host")}`;
  const inviteUrl = (req, token) => `${origin(req)}/#invite=${token}`;

  // ---------------------------------------------------------------- request helpers
  const ipOf = (req) => req.ip || req.socket.remoteAddress || "";
  const setSession = (req, res, who) => {
    const token = accounts.startSession(who, { ip: ipOf(req), ua: req.get("user-agent") });
    const days = Number(cfg.sessionDays) || 7;
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: days * 86400_000 });
  };
  const identify = (req) => accounts.identify(parseCookies(req.get("cookie"))[COOKIE]);

  /** async route with errors answered as JSON ({ error }) */
  const router = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      const status = e.status || 400;
      if (status >= 500) console.error(`portal ${req.method} ${req.path}:`, e);
      if (!res.headersSent) res.status(status).json({ error: status >= 500 ? "internal error" : e.message });
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });

  // API: no caching, no framing; changes must be JSON from this site (forms on other sites can't
  // send that, so no CSRF)
  app.use("/api/web", (req, res, next) => {
    res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    if (req.method !== "GET") {
      if (!req.is("application/json")) return res.status(415).json({ error: "JSON only" });
      if (!sameOrigin(req.get("origin"), req.get("host"))) return res.status(403).json({ error: "wrong origin" });
    }
    next();
  });

  const auth = (req, res, next) => {
    const who = identify(req);
    if (!who) return res.status(401).json({ error: "Please log in" });
    req.who = who;
    next();
  };
  const ownerOnly = (req, res, next) => (req.who.role === "owner" ? next() : res.status(403).json({ error: "Owners only" }));
  const operatorsOnly = (req, res, next) => (mayOperate(req.who) ? next() : res.status(403).json({ error: "Not allowed for your role" }));

  // ---------------------------------------------------------------- the page (home page)
  app.get("/", (req, res) => {
    res.set({
      "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://*.telegram.org https://t.me; frame-src https://oauth.telegram.org; connect-src 'self' wss: ws:; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    res.sendFile(path.join(publicDir, "portal.html"));
  });

  // ---------------------------------------------------------------- login
  app.get("/api/web/config", (req, res) => {
    let bot = null;
    try {
      bot = botUsername();
    } catch {
      /* bot not connected yet */
    }
    res.json({ bot_username: bot, email_codes: accounts.emailAvailable(), min_password: MIN_PASSWORD });
  });

  app.get("/api/web/me", auth, (req, res) => res.json({ me: meView(req.who) }));

  app.post("/api/web/login", router(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw fail(400, "Enter your username and password");
    res.json(await accounts.login(String(username), String(password), ipOf(req)));
  }));

  app.post("/api/web/login/verify", router(async (req, res) => {
    const a = accounts.verify(String(req.body?.ticket || ""), String(req.body?.code || ""), ipOf(req));
    setSession(req, res, { type: "account", id: a.id });
    res.json({ ok: true });
  }));

  app.post("/api/web/login/telegram", router(async (req, res) => {
    const tg = verifyTelegramLogin(req.body, cfg.botToken);
    if (!tg) throw fail(401, "Telegram login could not be verified. Try again.");
    const who = accounts.telegramIdentity(tg);
    if (!who) throw fail(403, `This Telegram account (ID ${tg.id}) has no access. Ask an owner to link it to your account.`);
    setSession(req, res, who);
    res.json({ ok: true });
  }));

  // one-time link from the bot's /login command (the token is in the URL #fragment, so link
  // previews and server logs never see it; the page posts it here)
  app.post("/api/web/login/link", router(async (req, res) => {
    const who = accounts.useLoginLink(String(req.body?.token || ""));
    if (!who) throw fail(401, "This login link has expired or was already used. Send /login to the bot for a new one.");
    setSession(req, res, who);
    res.json({ ok: true });
  }));

  app.post("/api/web/logout", (req, res) => {
    const token = parseCookies(req.get("cookie"))[COOKIE];
    if (token) accounts.endSession(token);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- invite: set password + second step
  const inviteAccount = (req) => {
    const a = accounts.byInvite(String(req.params.token || ""));
    if (!a) throw fail(404, "This invite link is invalid or has expired. Ask an owner for a new one.");
    return a;
  };
  app.get("/api/web/invite/:token", router(async (req, res) => {
    const a = inviteAccount(req);
    res.json({ username: a.username, role: ROLE_LABEL[a.role], email: a.email, email_codes: accounts.emailAvailable(), min_password: MIN_PASSWORD });
  }));
  app.post("/api/web/invite/:token/totp", router(async (req, res) => {
    inviteAccount(req);
    const { secret, url } = accounts.inviteTotp(req.params.token);
    const qr = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    res.json({ secret, url, qr });
  }));
  app.post("/api/web/invite/:token/email", router(async (req, res) => {
    inviteAccount(req);
    await accounts.inviteEmail(req.params.token, String(req.body?.email || ""));
    res.json({ ok: true });
  }));
  app.post("/api/web/invite/:token/finish", router(async (req, res) => {
    const { password, method, code } = req.body || {};
    const a = accounts.finishInvite(req.params.token, { password, method, code });
    audit({ name: a.username }, `${a.username} set up their login (${a.twofa === "totp" ? "authenticator app" : "e-mail codes"})`);
    setSession(req, res, { type: "account", id: a.id });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- notifications
  const visibleServers = (who) => monitor.list().filter((s) => canSeeServer(who, s.id));

  app.get("/api/web/overview", auth, (req, res) => {
    const kinds = Object.fromEntries(Object.entries(KINDS).filter(([k]) => k !== "audit" || req.who.role === "owner"));
    res.json({
      now: Date.now() / 1000,
      me: meView(req.who),
      servers: visibleServers(req.who).map(serverView),
      muted_until: notifier.isMuted() ? notifier.mutedUntil() : null,
      kinds,
      retention_days: events.retentionDays,
      thresholds: Object.fromEntries(monitor.rules.map((r) => [r.key, r.threshold])),
      history_minutes: cfg.historyMinutes,
    });
  });

  // the last HISTORY_MINUTES of one server, for the charts
  app.get("/api/web/servers/:id/history", auth, (req, res) => {
    const s = monitor.get(req.params.id);
    if (!s || !canSeeServer(req.who, s.id)) return res.status(404).json({ error: "Unknown server" });
    res.json({ now: Date.now() / 1000, history: monitor.history(s.id) });
  });

  app.get("/api/web/events", auth, (req, res) => {
    const { before, limit, server, kind, exclude } = req.query;
    const skip = exclude ? String(exclude) : "";
    const list = events.query({
      before: before ? Number(before) : Infinity,
      limit,
      server: server ? String(server) : "",
      kind: kind ? String(kind) : "",
      visible: (e) => e.kind !== skip && canSee(req.who, e),
    });
    res.json({ events: list });
  });

  // ---------------------------------------------------------------- servers: add, reboot (staff + owners)
  app.post("/api/web/servers", auth, operatorsOnly, router(async (req, res) => {
    const { server, token } = monitor.addServer(req.body?.name);
    if (req.who.accountId && req.who.role !== "owner") accounts.assign(req.who.accountId, server.id); // staff see what they add
    audit(req.who, `${req.who.name} added server ${server.name}`, server);
    res.json({ server: serverView(server), token, env: monitor.envSnippet(token), install: monitor.installCommand(token) });
  }));

  app.post("/api/web/servers/:id/reboot", auth, operatorsOnly, router(async (req, res) => {
    const s = monitor.get(req.params.id);
    if (!s || !canSeeServer(req.who, s.id)) throw fail(404, "Unknown server");
    if (s.status !== "online") throw fail(409, `${s.name} is offline: it can't receive the reboot (a machine that is off can't be started from here).`);
    if (!s.allowReboot) throw fail(409, `${s.name} doesn't allow remote reboots. Set ALLOW_REMOTE_REBOOT=true in its .env and restart its agent.`);
    monitor.requestReboot(s.id, req.who.name, REBOOT_WAIT_S);
    audit(req.who, `${req.who.name} rebooted ${s.name}`, s);
    res.json({ ok: true, server: serverView(s) });
  }));

  // ---------------------------------------------------------------- accounts (owners)
  const serverNames = () => monitor.list().map((s) => ({ id: s.id, name: s.name }));
  const notSelf = (req, what) => {
    if (req.who.accountId === req.params.id) throw fail(400, `You can't ${what} your own account`);
  };

  app.get("/api/web/accounts", auth, ownerOnly, (req, res) => {
    res.json({ accounts: accounts.all().map((a) => accounts.view(a)), servers: serverNames(), telegram_owners: cfg.adminIds });
  });

  app.post("/api/web/accounts", auth, ownerOnly, router(async (req, res) => {
    const { username, role, servers, email, telegram_id } = req.body || {};
    const known = new Set(monitor.list().map((s) => s.id));
    const { account, inviteToken } = accounts.create(
      { username, role, servers: (servers || []).filter((id) => known.has(id)), email, telegramId: telegram_id },
      req.who.name,
    );
    audit(req.who, `${req.who.name} created ${ROLE_LABEL[account.role].toLowerCase()} account ${account.username}`);
    res.json({ account: accounts.view(account), invite_url: inviteUrl(req, inviteToken) });
  }));

  app.patch("/api/web/accounts/:id", auth, ownerOnly, router(async (req, res) => {
    const b = req.body || {};
    if (b.role !== undefined || b.disabled !== undefined) notSelf(req, b.disabled ? "disable" : "change the role of");
    const known = new Set(monitor.list().map((s) => s.id));
    const a = accounts.update(req.params.id, {
      role: b.role, disabled: b.disabled, email: b.email, telegramId: b.telegram_id,
      servers: Array.isArray(b.servers) ? b.servers.filter((id) => known.has(id)) : undefined,
    });
    const what = [b.role !== undefined && `role ${b.role}`, b.servers !== undefined && "servers", b.disabled !== undefined && (b.disabled ? "disabled" : "enabled"), b.email !== undefined && "e-mail", b.telegram_id !== undefined && "Telegram ID"].filter(Boolean).join(", ");
    audit(req.who, `${req.who.name} changed ${a.username}: ${what || "nothing"}`);
    res.json({ account: accounts.view(a) });
  }));

  app.post("/api/web/accounts/:id/reset", auth, ownerOnly, router(async (req, res) => {
    notSelf(req, "reset");
    const a = accounts.get(req.params.id);
    if (!a) throw fail(404, "Unknown account");
    const token = accounts.reset(a.id);
    audit(req.who, `${req.who.name} reset the login of ${a.username}`);
    res.json({ account: accounts.view(a), invite_url: inviteUrl(req, token) });
  }));

  app.delete("/api/web/accounts/:id", auth, ownerOnly, router(async (req, res) => {
    notSelf(req, "delete");
    const a = accounts.get(req.params.id);
    if (!a || !accounts.remove(a.id)) throw fail(404, "Unknown account");
    audit(req.who, `${req.who.name} deleted account ${a.username}`);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- live updates (WebSocket /ws/web)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const clients = new Set();
  const send = (ws, msg) => ws.readyState === 1 && ws.bufferedAmount < 1 << 20 && ws.send(JSON.stringify(msg));

  /** Called from the HTTP server's "upgrade" for /ws/web. The session cookie is the login. */
  const handleUpgrade = (req, socket, head) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const who = accounts.identify(token);
    if (!who || !sameOrigin(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.who = who;
      ws.token = token;
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("message", (m) => String(m) === "ping" && send(ws, { type: "pong" }));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      clients.add(ws);
      send(ws, { type: "hello", me: meView(who) });
    });
  };

  const offEvents = events.onEvent((e) => {
    for (const ws of clients) if (canSee(ws.who, e)) send(ws, { type: "event", event: e });
  });

  /** The monitor's broadcasts (server changed / removed), passed on to whoever may see that server. */
  const onServerChange = (msg) => {
    if (msg.type === "removed") {
      accounts.forgetServer(msg.id);
      for (const ws of clients) send(ws, { type: "removed", id: msg.id });
      return;
    }
    if (msg.type !== "update" || !msg.server) return;
    const s = monitor.get(msg.server.id);
    if (!s) return;
    let view = null;
    for (const ws of clients) {
      if (canSeeServer(ws.who, s.id)) send(ws, { type: "server", server: (view ||= serverView(s)), ...(msg.point ? { point: msg.point } : {}) });
    }
  };

  // every 30 s: drop dead sockets, and re-check each login (account disabled, servers re-assigned …)
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const who = accounts.identify(ws.token);
      if (!who) {
        ws.close(4401, "logged out");
        clients.delete(ws);
        continue;
      }
      const changed = JSON.stringify(meView(who)) !== JSON.stringify(meView(ws.who));
      ws.who = who;
      if (changed) send(ws, { type: "reload" }); // assignments changed: the page fetches again
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    offEvents();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };

  return { handleUpgrade, onServerChange, close };
}
