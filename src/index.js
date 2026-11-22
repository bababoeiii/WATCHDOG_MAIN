// Watchdog main server — entry point.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_NAMES, loadConfig, readConfig, RESTART_KEYS } from "./config.js";
import { Store } from "./store.js";
import { Monitor } from "./monitor.js";
import { Notifier } from "./notifier.js";
import { createBot, runBot } from "./bot.js";
import { createServer } from "./server.js";
import { esc, setTimezone } from "./format.js";
import { EventLog } from "./events.js";
import { Accounts } from "./accounts.js";
import { createMailer } from "./mailer.js";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
if (!setTimezone(cfg.timezone)) console.warn(`Unknown TIMEZONE "${cfg.timezone}", using the machine's time zone`);

// Log stray async errors instead of crashing: a crash would drop live history and alert state.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
const store = new Store(cfg.dataFile);

// The monitor pushes to the dashboard through `broadcast`, which exists once the HTTP server does.
let broadcast = () => {};
const notifier = new Notifier(null, cfg, store);

// Every notification goes into the event log (the web portal's history, also while muted),
// then to Telegram — unless meta.telegram is false (the bot reports that one another way).
const events = new EventLog(path.join(path.dirname(cfg.dataFile), "events.jsonl"), cfg.notifyHistoryDays);
function notify(text, important = false, meta = {}) {
  events.add({ kind: meta.kind || "main", text, server: meta.server || null, important, muted: notifier.isMuted() });
  if (meta.telegram !== false) notifier.send(text, important);
}
const accounts = new Accounts(store, cfg, createMailer(cfg));
const monitor = new Monitor(cfg, store, notify, (msg) => broadcast(msg));

// ---------------------------------------------------------------- auto-update (optional)
let updaterMod = null;
try {
  updaterMod = await import("./updater.js");
  monitor.updater = await updaterMod.createUpdater({
    appDir: APP_DIR,
    branch: cfg.updateBranch || undefined,
    auto: cfg.autoUpdate,
    intervalMinutes: cfg.updateCheckMinutes,
    githubToken: cfg.githubToken,
    log: (m) => console.log(`[update] ${m}`),
  });
} catch (e) {
  console.log(`Auto-update unavailable: ${e.message}`);
}
const u = monitor.updater;
// The sub-server project has its own repo: read its branches so /version knows which sub servers are behind.
function setSubRepo() {
  monitor.fetchSubHeads = cfg.subRepo && updaterMod?.remoteHeads
    ? () => updaterMod.remoteHeads(cfg.subRepo, { githubToken: cfg.subGithubToken || cfg.githubToken })
    : null;
  monitor.subHeads = null;
}
setSubRepo();
console.log(u?.enabled ? `Auto-update ${cfg.autoUpdate ? "on" : "off"}: ${u.remote} (${u.branch}) @ ${u.info().commit}` : `Auto-update off: ${u?.reason || "src/updater.js missing"}`);

let restarting = false;
function restartForUpdate(r, quiet = false) {
  if (!updaterMod?.isSupervised()) {
    notify(`⬆️ Main server updated <code>${r.from}</code> → <code>${r.to}</code>. Restart it to run the new version.`, false, { kind: "main" });
    return false;
  }
  if (restarting) return true;
  restarting = true;
  if (!quiet) notify(`⬆️ Main server updated <code>${r.from}</code> → <code>${r.to}</code>, restarting…`, false, { kind: "main" });
  setTimeout(() => shutdown("update"), 500);
  return true;
}

/**
 * Update the main server now (from /update, the bot's buttons or the dashboard).
 * deferRestart: install but don't restart yet; the caller runs r.restartNow() when it's ready
 * (the bot first sends its "update all" summary).
 */
async function updateMain(source, { deferRestart = false } = {}) {
  if (!u?.enabled) throw new Error(`Auto-update unavailable: ${u?.reason || "not installed from git"}`);
  const r = await u.update();
  console.log(`[update] ${source}: ${r.status}`);
  if (r.status === "restart") {
    if (!deferRestart) r.restarting = restartForUpdate(r);
    else if ((r.restarting = Boolean(updaterMod?.isSupervised()))) r.restartNow = () => restartForUpdate(r, true);
  }
  return { ...r, version: u.info() };
}

// ---------------------------------------------------------------- bot + http
const realBot = createBot(cfg, monitor, notifier, {}, updateMain, accounts);
notifier.api = realBot.api;

const botUsername = () => realBot.botInfo?.username || null; // throws until the bot connected: the portal catches it
const http = createServer(cfg, monitor, notifier, updateMain, { events, accounts, notify, botUsername });
broadcast = http.broadcast;

http.server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${cfg.port} on ${cfg.host} is already in use. Choose another PORT in .env (npm run setup), then update the aaPanel config (npm run nginx).`);
  } else if (e.code === "EACCES") {
    console.error(`No permission to use port ${cfg.port}. Use a port above 1024.`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
http.server.listen(cfg.port, cfg.host, () => {
  console.log(`Watchdog main server listening on http://${cfg.host}:${cfg.port}`);
  console.log(`Sub servers connect to: ${cfg.publicUrl || "(set PUBLIC_URL)"}`);
});

monitor.start();
events.start();
monitor.refreshSubHeads(0);
setInterval(() => monitor.refreshSubHeads(0), cfg.updateCheckMinutes * 60_000).unref();

// ---------------------------------------------------------------- reload (.env) without a restart
// `watchdog-main reload` / `systemctl reload watchdog-main` send SIGHUP. Settings that are only used
// at startup (RESTART_KEYS) are reported as "needs a restart" and keep their current value.
function reloadConfig() {
  let next, problems;
  try {
    ({ cfg: next, problems } = readConfig({ reload: true }));
  } catch (e) {
    return console.error(`[reload] failed, nothing changed: ${e.code === "ENOENT" ? ".env not found" : e.message}`);
  }
  if (problems.length) return console.error(`[reload] failed, nothing changed: ${problems.join("; ")}`);
  const same = (k) => JSON.stringify(cfg[k]) === JSON.stringify(next[k]);
  const changed = Object.keys(next).filter((k) => !same(k));
  const live = changed.filter((k) => !RESTART_KEYS.includes(k));
  const later = changed.filter((k) => RESTART_KEYS.includes(k));
  for (const k of live) cfg[k] = next[k];
  if (live.includes("timezone") && !setTimezone(cfg.timezone)) console.warn(`[reload] unknown TIMEZONE "${cfg.timezone}"`);
  if (live.some((k) => /Alert/.test(k))) monitor.buildRules();
  if (live.some((k) => ["subRepo", "subGithubToken"].includes(k))) {
    setSubRepo();
    monitor.refreshSubHeads(0);
  }
  const names = (keys) => keys.filter((k) => ENV_NAMES[k]).map((k) => ENV_NAMES[k]).join(", ") || "nothing";
  console.log(`[reload] ok · changed now: ${names(live)} · needs a restart: ${names(later)}`);
}
process.on("SIGHUP", reloadConfig);
u?.start(
  (r) => (r.status === "restart" ? restartForUpdate(r) : null),
  (e) => {
    console.error(`[update] ${e.message}`);
    if (store.getKv("lastUpdateError") !== e.message) {
      store.setKv("lastUpdateError", e.message);
      notify(`❗ Main server auto-update failed\n${esc(e.message)}`, true, { kind: "main" });
    }
  },
);

let announced = false;
runBot(realBot, cfg, () => {
  if (announced) return;
  announced = true;
  const now = u?.info().commit;
  const before = store.getKv("mainCommit");
  if (now && before && now !== before) {
    notify(`⬆️ Main server is now running <code>${now}</code> (was <code>${before}</code>).`, false, { kind: "main" });
  } else {
    notify(`🐕 Watchdog main server started${now ? ` (<code>${now}</code>)` : ""} — ${monitor.list().length} server(s) registered.`, false, { kind: "main" });
  }
  if (now) store.setKv("mainCommit", now);
  store.setKv("lastUpdateError", null);
  realBot.sendMenu?.().catch((e) => console.error("button bar:", e.message));
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})`);
  monitor.stop();
  events.stop();
  u?.stop();
  store.flush();
  setTimeout(() => process.exit(0), 8000).unref(); // never hang
  await notifier.flush(5000); // let queued Telegram messages go out first
  realBot.stop().catch(() => {});
  await http.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
