// Core logic: server registry + per-server tokens, up/down/reboot detection,
// threshold alerts with hysteresis, live history for charts, periodic health reports.
import crypto from "node:crypto";
import { esc, fmtClock, fmtDuration, metricsLine, nameHtml, statusMessage, worstDisk } from "./format.js";
import { sanitizeReport, sanitizeVersion } from "./sanitize.js";

/** Builds a raw.githubusercontent.com URL for a file in a public GitHub repo. */
function rawGithubUrl(remote, branch, file) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote || ""));
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/${file}` : null;
}

const REBOOT_TOLERANCE = 60; // seconds of boot-time drift ignored (NTP adjustments)
const HISTORY_CAP = 5000;
const ROUTINE_SAVE_MS = 60_000; // metrics-only changes are written at most once a minute
const WATCH_EVERY_MS = 5000;
const nowSec = () => Date.now() / 1000;
/** Short and full shas of the same commit compare equal. */
export const sameCommit = (a, b) => Boolean(a && b) && (String(a).startsWith(b) || String(b).startsWith(a));
/** How long an "update all" waits for the sub servers before sending its summary. */
export const RUN_TIMEOUT_MS = 5 * 60_000;

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const newToken = () => "wd_" + crypto.randomBytes(24).toString("base64url");

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}

export function historyPoint(ts, p) {
  return [
    Math.round(ts * 10) / 10,
    p.cpu?.percent ?? null,
    p.mem?.percent ?? null,
    p.temp?.max ?? null,
    p.net?.rx_rate ?? null,
    p.net?.tx_rate ?? null,
    worstDisk(p)?.percent ?? null,
  ];
}

export class Monitor {
  /**
   * @param cfg       config from loadConfig()
   * @param store     Store instance
   * @param notify    (text, important?, meta?) => void — meta: { server, kind, telegram } for the event log
   *                  (telegram: false = only log it, the bot already reports it another way)
   * @param broadcast (message) => void   — pushes to dashboard WebSocket clients
   */
  constructor(cfg, store, notify, broadcast) {
    this.cfg = cfg;
    this.store = store;
    this.notify = notify;
    this.broadcast = broadcast;
    this.startedAt = nowSec();
    this.runtime = new Map(); // id -> { history: [], alerts: {} }
    this.updater = null; // the main server's own Updater (set in index.js) — knows the latest commit
    // The sub-server project lives in its own repo (SUB_REPO): index.js sets fetchSubHeads to read
    // that repo's branches, so we know the newest sub-server commit without waiting for each server.
    this.fetchSubHeads = null; // () => Promise<{ branch: sha }>
    this.subHeads = null; // { heads, at, error }
    this.runs = new Set(); // updates the bot is following (one server or many), see startUpdateRun()
    this.byToken = new Map(); // tokenHash -> id
    this.buildRules();

    for (const s of Object.values(store.servers)) {
      if (s.tokenHash) this.byToken.set(s.tokenHash, s.id);
      // data saved by older versions went in unchecked
      if (s.payload) s.payload = sanitizeReport(s.payload);
      if (s.version) s.version = sanitizeVersion(s.version);
    }
    console.log(`Loaded ${Object.keys(store.servers).length} server(s)`);
  }

  /** Alert rules from the thresholds in cfg (again after a reload; alert state is kept per rule). */
  buildRules() {
    this.rules = [
      { key: "cpu", label: "High CPU", unit: "%", threshold: this.cfg.cpuAlert, duration: this.cfg.cpuAlertFor,
        measure: (p) => [p.cpu?.percent, ""] },
      { key: "ram", label: "High RAM", unit: "%", threshold: this.cfg.ramAlert, duration: this.cfg.ramAlertFor,
        measure: (p) => [p.mem?.percent, ""] },
      { key: "disk", label: "Disk almost full", unit: "%", threshold: this.cfg.diskAlert, duration: this.cfg.diskAlertFor,
        measure: (p) => { const d = worstDisk(p); return [d?.percent, d?.mount || ""]; } },
      { key: "temp", label: "High temperature", unit: "°C", threshold: this.cfg.tempAlert, duration: this.cfg.tempAlertFor,
        measure: (p) => [p.temp?.max, p.temp?.max_label || ""] },
    ].filter((r) => r.threshold > 0);
    // a rule that was switched off (threshold 0) must not leave an alert behind
    const keys = new Set(this.rules.map((r) => r.key));
    for (const rt of this.runtime?.values() || []) for (const k of Object.keys(rt.alerts)) if (!keys.has(k)) delete rt.alerts[k];
  }

  // ------------------------------------------------------------------ registry & tokens

  rt(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { history: [], alerts: {} });
    return this.runtime.get(id);
  }

  list() {
    return Object.values(this.store.servers).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return typeof id === "string" && Object.hasOwn(this.store.servers, id) ? this.store.servers[id] : null;
  }

  find(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return null;
    return this.get(q) || this.list().find((s) => s.name.toLowerCase() === q) || null;
  }

  envSnippet(token) {
    return `MAIN_SERVER_URL=${this.cfg.publicUrl || "https://YOUR-MAIN-SERVER"}\nAGENT_TOKEN=${token}`;
  }

  /** One-line install command for a sub server, from the sub-server project's own repo (SUB_REPO). */
  installCommand(token) {
    const repo = this.cfg.subRepo;
    if (!repo || !this.cfg.publicUrl) return null; // no SUB_REPO: the bot gives the .env snippet only
    const branch = this.cfg.subBranch || this.updater?.branch || "main";
    const raw = rawGithubUrl(repo, branch, "install.sh");
    if (!raw) return null;
    return `curl -fsSL ${raw} | sudo bash -s -- --repo ${repo} --branch ${branch} --main ${this.cfg.publicUrl} --token ${token}`;
  }

  /** Newest commit on GitHub (from the main server's last fetch), or null. */
  latestCommit() {
    return this.updater?.info().latest || null;
  }

  // ------------------------------------------------------------------ versions (two repos)

  /** Re-read the sub-server repo's branches, at most every maxAge seconds. */
  async refreshSubHeads(maxAge = 60) {
    if (!this.fetchSubHeads) return this.subHeads;
    if (this.subHeads && nowSec() - this.subHeads.at < maxAge) return this.subHeads;
    this.subHeadsPending ||= this.fetchSubHeads()
      .then((heads) => (this.subHeads = { heads, at: nowSec(), error: null }))
      .catch((e) => (this.subHeads = { heads: this.subHeads?.heads || {}, at: nowSec(), error: e.message }))
      .finally(() => (this.subHeadsPending = null));
    return this.subHeadsPending;
  }

  /** Fresh "latest" for both repos (each at most every maxAge s); never waits more than 15 s. */
  async refreshVersions(maxAge = 60) {
    const u = this.updater;
    const main = u?.enabled && !u.busy && (!u.lastCheck || nowSec() - u.lastCheck > maxAge) ? u.check() : null;
    const limit = new Promise((r) => setTimeout(r, 15_000).unref?.());
    await Promise.race([Promise.allSettled([main, this.refreshSubHeads(maxAge)]), limit]);
  }

  /** Newest sub-server commit for the branch this server follows (SUB_REPO, else the server's own last check). */
  subLatest(s) {
    const branch = s.version?.branch || this.cfg.subBranch || "main";
    const sha = this.subHeads?.heads?.[branch];
    return sha ? sha.slice(0, 7) : s.version?.latest || null;
  }

  /** @returns {"current"|"behind"|"restart"|"unknown"} */
  subVersionState(s) {
    const v = s.version;
    if (!v?.commit) return "unknown";
    if (v.pending_restart) return "restart";
    const latest = this.subLatest(s);
    if (!latest) return "unknown";
    return sameCommit(v.commit, latest) ? "current" : "behind";
  }

  // ------------------------------------------------------------------ updates the bot follows

  /** The followed update a server is part of, if any. */
  runOf(id) {
    for (const run of this.runs) if (run.items.has(id)) return run;
    return null;
  }

  /**
   * Ask these sub servers to update and follow each one's result, so the bot can report it
   * (one summary for many servers, instead of a message per server). run.done resolves with the
   * results once every online server has one, or after timeoutMs. Offline servers keep their
   * update request for when they're back. Several runs can go at once, but not for the same server.
   */
  startUpdateRun(servers, timeoutMs = RUN_TIMEOUT_MS) {
    const busy = servers.filter((s) => this.runOf(s.id));
    if (busy.length) throw new Error(`Already updating: ${busy.map((s) => s.name).join(", ")}`);
    const items = new Map();
    for (const s of servers) {
      const v = s.version || {};
      const it = { id: s.id, name: s.name, from: v.commit || null, to: null, note: null, deliveredAt: null };
      if (s.status === "online" && !v.enabled) {
        it.state = "unavailable";
        it.note = v.reason || "no version info from this server";
      } else {
        it.state = s.status === "online" ? "waiting" : "offline";
        this.requestUpdate(s.id);
      }
      items.set(s.id, it);
    }
    let resolve;
    const run = { items, startedAt: nowSec(), done: new Promise((r) => (resolve = r)) };
    run.finish = () => {
      if (!this.runs.has(run)) return;
      clearTimeout(run.timer);
      this.runs.delete(run);
      for (const it of items.values()) {
        if (it.state !== "waiting") continue;
        it.state = "timeout";
        it.note = this.get(it.id)?.version?.error || null;
      }
      resolve([...items.values()]);
    };
    run.timer = setTimeout(run.finish, timeoutMs);
    run.timer.unref?.();
    this.runs.add(run);
    this.checkRunDone(run);
    return run;
  }

  checkRunDone(run) {
    if (![...run.items.values()].some((it) => it.state === "waiting")) run.finish();
  }

  /** Called on every report of a server whose update the bot is following. */
  followRun(run, it, v, delivered, now) {
    if (it.state === "offline" && delivered) {
      it.state = "waiting"; // came back during the run
      it.from = v?.commit || it.from;
    }
    if (it.state !== "waiting") return;
    if (delivered) {
      // this report picked up the request; its version info is from before the update
      it.deliveredAt = now;
      it.checkBefore = v?.last_check ?? null;
      it.errorBefore = v?.error ?? null;
      return;
    }
    if (!it.deliveredAt || !v) return;
    if (it.from && v.commit && !sameCommit(v.commit, it.from)) {
      it.state = "updated";
      it.to = v.commit;
    } else if (v.error && v.error !== it.errorBefore) {
      it.state = "failed";
      it.note = v.error;
    } else if ((v.last_check ?? 0) > (it.checkBefore ?? 0) && sameCommit(v.latest, v.commit) && !v.pending_restart) {
      it.state = "current"; // it checked GitHub after our request and found nothing new
      it.to = v.commit;
    } else {
      return; // still fetching / installing / restarting
    }
    this.checkRunDone(run);
  }

  requestUpdate(id) {
    const s = this.get(id);
    if (!s) return false;
    s.pendingUpdate = true;
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return true;
  }

  addServer(rawName) {
    const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) throw new Error("Give the server a name");
    if (this.list().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A server called "${name}" already exists`);
    }
    let id = slugify(name);
    for (let i = 2; this.get(id); i++) id = `${slugify(name)}-${i}`;
    const token = newToken();
    const s = {
      id, name, tokenHash: hashToken(token), tokenCreatedAt: nowSec(), createdAt: nowSec(),
      status: "pending", statusSince: nowSec(), lastSeen: null, bootTime: null, offlineReason: null,
      payload: null,
    };
    this.store.servers[id] = s;
    this.byToken.set(s.tokenHash, id);
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return { server: s, token };
  }

  rotateToken(id) {
    const s = this.get(id);
    if (!s) throw new Error("Unknown server");
    if (s.tokenHash) this.byToken.delete(s.tokenHash);
    const token = newToken();
    s.tokenHash = hashToken(token);
    s.tokenCreatedAt = nowSec();
    this.byToken.set(s.tokenHash, id);
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return token;
  }

  removeServer(id) {
    const s = this.get(id);
    if (!s) return false;
    if (s.tokenHash) this.byToken.delete(s.tokenHash);
    delete this.store.servers[id];
    this.runtime.delete(id);
    this.store.save();
    this.broadcast({ type: "removed", id });
    return true;
  }

  authenticate(token) {
    if (!token) return null;
    const id = this.byToken.get(hashToken(token));
    return id ? this.get(id) : null;
  }

  // ------------------------------------------------------------------ views

  summary(s) {
    const rt = this.rt(s.id);
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      status_since: s.statusSince,
      last_seen: s.lastSeen,
      offline_reason: s.offlineReason,
      token_created_at: s.tokenCreatedAt,
      // latest = newest commit in the sub-server repo for this server's branch (not the main server's repo)
      version: s.version ? { ...s.version, latest: this.subLatest(s) } : null,
      pending_update: Boolean(s.pendingUpdate),
      metrics: s.payload,
      alerts: Object.entries(rt.alerts)
        .filter(([, a]) => a.active)
        .map(([key, a]) => ({ key, label: a.label, unit: a.unit, value: a.value, since: a.since, detail: a.detail })),
    };
  }

  snapshot() {
    return this.list().map((s) => this.summary(s));
  }

  history(id) {
    return this.runtime.get(id)?.history || [];
  }

  activeAlerts() {
    const out = [];
    for (const s of this.list()) {
      if (s.status !== "online") continue;
      for (const a of Object.values(this.rt(s.id).alerts)) if (a.active) out.push([s, a]);
    }
    return out;
  }

  serverForText(s) {
    // format.js expects alerts on the object
    return { ...s, alerts: this.rt(s.id).alerts };
  }

  statusText(title) {
    return statusMessage(this.list().map((s) => this.serverForText(s)), title);
  }

  // ------------------------------------------------------------------ agent events

  handleReport(s, raw) {
    const now = nowSec();
    const payload = sanitizeReport(raw);
    const prevStatus = s.status;
    const prevSince = s.statusSince;
    const prevBoot = s.bootTime;
    const boot = payload.boot_time || null;
    const rebooted = Boolean(prevBoot && boot && Math.abs(boot - prevBoot) > REBOOT_TOLERANCE);

    s.payload = payload;
    s.lastSeen = now;
    s.bootTime = boot;
    const rt = this.rt(s.id);
    rt.history.push(historyPoint(now, payload));
    const cutoff = now - this.cfg.historyMinutes * 60;
    while (rt.history.length && (rt.history[0][0] < cutoff || rt.history.length > HISTORY_CAP)) rt.history.shift();

    if (prevStatus === "pending") {
      this.notify(`🆕 ${nameHtml(s)} connected for the first time\n${metricsLine(payload)}`, true, { server: s, kind: "connected" });
    } else if (prevStatus !== "online") {
      this.notify(
        `🟢 ${nameHtml(s)} is <b>back online</b>${rebooted ? " (rebooted)" : ""}\n` +
          `Was down for ${fmtDuration(prevSince ? now - prevSince : null)}\n${metricsLine(payload)}`,
        true,
        { server: s, kind: "online" },
      );
    } else if (rebooted) {
      this.notify(`🔄 ${nameHtml(s)} <b>rebooted</b> (up ${fmtDuration(payload.uptime)})\n${metricsLine(payload)}`, true, { server: s, kind: "reboot" });
    }
    if (prevStatus !== "online") {
      s.status = "online";
      s.statusSince = now;
      s.offlineReason = null;
    }

    s.allowReboot = raw?.allow_reboot === true; // ALLOW_REMOTE_REBOOT on the sub server
    const reboot = Boolean(s.pendingReboot && s.pendingReboot.expires > now);
    if (s.pendingReboot) s.pendingReboot = null; // delivered now, or too late to deliver
    const version = sanitizeVersion(raw?.version);
    const run = this.runOf(s.id);
    const inRun = run?.items.get(s.id);
    // while the bot follows this server's update it reports the result itself: no extra messages
    const versionChanged = this.trackVersion(s, version, Boolean(inRun));
    const update = Boolean(s.pendingUpdate);
    s.pendingUpdate = false;
    if (inRun) this.followRun(run, inRun, version, update, now);

    const alertsChanged = this.evaluateAlerts(s, now);
    // status/version/flag changes are saved right away; plain metrics at most once a minute
    const important = prevStatus !== "online" || rebooted || versionChanged || update || reboot || alertsChanged;
    this.store.save(important ? 1000 : ROUTINE_SAVE_MS);
    this.broadcast({ type: "update", server: this.summary(s), point: rt.history[rt.history.length - 1] });
    return { update, reboot };
  }

  /** Ask an online sub server to reboot (portal). Dropped if it isn't picked up within waitSeconds. */
  requestReboot(id, by, waitSeconds = 120) {
    const s = this.get(id);
    if (!s) return false;
    s.pendingReboot = { by: String(by), at: nowSec(), expires: nowSec() + waitSeconds };
    this.notify(`🔁 ${nameHtml(s)}: reboot requested by <b>${esc(by)}</b>`, true, { server: s, kind: "reboot_request" });
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return true;
  }

  /** @returns {boolean} whether anything worth saving changed */
  trackVersion(s, v, quiet = false) {
    if (!v) return false;
    const prev = s.version || {};
    // quiet (the bot reports this server's update itself): still logged for the portal, no Telegram message
    const telegram = !quiet;
    if (prev.commit && v.commit && prev.commit !== v.commit) {
      this.notify(`⬆️ ${nameHtml(s)} updated <code>${esc(prev.commit)}</code> → <code>${esc(v.commit)}</code>`, false, { server: s, kind: "update", telegram });
    }
    if (v.error && v.error !== prev.error) {
      this.notify(`❗ ${nameHtml(s)}: update failed\n${esc(v.error)}`, true, { server: s, kind: "update_failed", telegram });
    }
    const next = {
      commit: v.commit, branch: v.branch, enabled: v.enabled, auto: v.auto,
      reason: v.reason, error: v.error, app: v.app, pending_restart: v.pending_restart,
      latest: v.latest, last_check: v.last_check, // what the server itself last saw on GitHub
    };
    const changed = JSON.stringify(next) !== JSON.stringify(s.version || null);
    s.version = next;
    return changed;
  }

  handleGoodbye(s, reason) {
    if (s.status !== "online") return;
    const now = nowSec();
    s.status = "offline";
    s.statusSince = now;
    s.offlineReason = reason === "shutdown" ? "shutdown" : "agent_stopped";
    this.notify(
      s.offlineReason === "shutdown"
        ? `⏻ ${nameHtml(s)} is <b>shutting down / rebooting</b>`
        : `⏹ The agent on ${nameHtml(s)} was <b>stopped</b> — no more data from this server`,
      true,
      { server: s, kind: "offline" },
    );
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
  }

  checkOffline() {
    const now = nowSec();
    // If this process itself was paused (machine asleep, VM frozen, event loop blocked), nobody's
    // reports could arrive: restart the grace period instead of declaring every server down.
    if (this.lastTick && now - this.lastTick > (3 * WATCH_EVERY_MS) / 1000) {
      console.warn(`Main server was paused for ${Math.round(now - this.lastTick)}s; resetting the down timers`);
      this.startedAt = now;
    }
    this.lastTick = now;
    for (const s of this.list()) {
      if (s.status !== "online") continue;
      // after a main-server restart, give every sub server a fresh grace period
      const reference = Math.max(s.lastSeen || 0, this.startedAt);
      if (now - reference <= this.cfg.offlineAfter) continue;
      s.status = "offline";
      s.statusSince = s.lastSeen || now;
      s.offlineReason = "timeout";
      for (const a of Object.values(this.rt(s.id).alerts)) a.breachSince = null;
      this.notify(
        `🔴 ${nameHtml(s)} is <b>DOWN</b>\nNo response for ${fmtDuration(now - (s.lastSeen || now))} ` +
          `(last seen ${fmtClock(s.lastSeen)})`,
        true,
        { server: s, kind: "down" },
      );
      this.store.save();
      this.broadcast({ type: "update", server: this.summary(s) });
    }
  }

  /** @returns {boolean} whether an alert started or ended */
  evaluateAlerts(s, now) {
    const alerts = this.rt(s.id).alerts;
    let changed = false;
    for (const rule of this.rules) {
      const [value, detail] = rule.measure(s.payload || {});
      const st = (alerts[rule.key] ||= { label: rule.label, unit: rule.unit, active: false, breachSince: null });
      if (value === null || value === undefined) continue;
      st.value = value;
      st.detail = detail;
      const where = detail ? ` on ${esc(detail)}` : "";
      if (value >= rule.threshold) {
        st.breachSince ??= now;
        if (!st.active && now - st.breachSince >= rule.duration) {
          st.active = true;
          st.since = now;
          changed = true;
          const held = rule.duration ? ` for ${fmtDuration(now - st.breachSince)}` : "";
          this.notify(
            `⚠️ ${nameHtml(s)}: <b>${rule.label}</b>${where}\n` +
              `${Math.round(value)}${rule.unit}${held} (limit ${rule.threshold}${rule.unit})`,
            true,
            { server: s, kind: "alert" },
          );
        }
      } else if (value < rule.threshold - this.cfg.hysteresis) {
        st.breachSince = null;
        if (st.active) {
          const lasted = fmtDuration(now - (st.since || now));
          st.active = false;
          st.since = null;
          changed = true;
          this.notify(
            `✅ ${nameHtml(s)}: ${rule.label.toLowerCase()} resolved${where}\nNow ${Math.round(value)}${rule.unit} (lasted ${lasted})`,
            false,
            { server: s, kind: "resolved" },
          );
        }
      } else if (!st.active) {
        st.breachSince = null; // inside the hysteresis band: restart the clock
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ timers

  start() {
    this.watchTimer = setInterval(() => {
      try {
        this.checkOffline();
      } catch (e) {
        console.error("offline check failed:", e);
      }
    }, WATCH_EVERY_MS);

    // reads the interval every time, so a reload can change it (0 = off)
    this.reportTimer = setInterval(() => {
      const interval = this.cfg.reportIntervalMinutes * 60;
      if (!(interval > 0)) return;
      const now = nowSec();
      const last = Number(this.store.getKv("lastReportTs", 0));
      if (!last) return this.store.setKv("lastReportTs", now);
      if (now - last < interval) return;
      this.store.setKv("lastReportTs", now);
      if (this.list().length) this.notify(this.statusText("🩺 <b>Health report</b>"), false, { kind: "report" });
    }, 30_000);
  }

  stop() {
    clearInterval(this.watchTimer);
    clearInterval(this.reportTimer);
  }
}
