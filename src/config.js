// Main server configuration, read from .env
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- .env files
// The .env next to the code, plus optionally another one (WATCHDOG_ENV_FILE, set in the service,
// e.g. /www/wwwroot/WATCHDOG/.env). Both are merged; WATCHDOG_ENV_FILE wins, and what it doesn't
// set comes from the .env next to the code. The same files are read again on reload.
const EXTRA_ENV = (process.env.WATCHDOG_ENV_FILE || "").trim();
/** .env files in priority order (the first one wins). */
export const ENV_FILES = [...new Set([EXTRA_ENV && path.resolve(EXTRA_ENV), path.join(APP_DIR, ".env")].filter(Boolean))];
export const ENV_FILE = ENV_FILES[0];

/**
 * Read and merge ENV_FILES. A missing file is skipped; one that exists but can't be read throws
 * (better to fail than to run on half the settings).
 * @returns {{ values: Record<string,string>, used: string[], missing: string[], keysOf: Record<string,string[]> }}
 */
export function readEnvFiles() {
  const used = [], missing = [], keysOf = {}, parsed = {};
  for (const f of ENV_FILES) {
    try {
      parsed[f] = dotenv.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") { missing.push(f); continue; }
      throw new Error(`can't read ${f}: ${e.code === "EACCES" ? "permission denied for this user" : e.message}`);
    }
    used.push(f);
    keysOf[f] = Object.keys(parsed[f]);
  }
  const values = {};
  for (const f of [...used].reverse()) Object.assign(values, parsed[f]); // earlier files win
  return { values, used, missing, keysOf };
}

// Variables really set in the environment (not from a file) keep priority over the files.
const realEnv = new Set(Object.keys(process.env));
let fromFile = {};
let envInfo = { values: {}, used: [], missing: [...ENV_FILES], keysOf: {} };
function applyEnvFiles(info) {
  for (const k of Object.keys(fromFile)) if (!(k in info.values)) delete process.env[k]; // line removed
  fromFile = {};
  for (const [k, v] of Object.entries(info.values)) {
    if (realEnv.has(k)) continue;
    process.env[k] = v;
    fromFile[k] = v;
  }
  envInfo = info;
}
try {
  applyEnvFiles(readEnvFiles());
} catch (e) {
  console.error(`Watchdog config error: ${e.message}`);
  process.exit(1);
}
/** Which .env files the current settings came from. */
export const envFiles = () => envInfo;

/**
 * Settings that only take effect after a restart (they are used once, at startup).
 * Everything else changes live on reload (SIGHUP, `watchdog-main reload`).
 */
export const RESTART_KEYS = ["botToken", "host", "port", "dataFile", "devNoAuth", "webappUrl", "autoUpdate", "updateCheckMinutes", "updateBranch", "githubToken"];

/** .env names of the config keys, for messages (`recipients` is derived, not a setting). */
export const ENV_NAMES = {
  botToken: "BOT_TOKEN", adminIds: "ADMIN_IDS", alertChatIds: "ALERT_CHAT_IDS", webappUrl: "WEBAPP_URL",
  publicUrl: "PUBLIC_URL", host: "HOST", port: "PORT", dataFile: "DATA_FILE", timezone: "TIMEZONE",
  offlineAfter: "OFFLINE_AFTER_SECONDS", historyMinutes: "HISTORY_MINUTES", reportIntervalMinutes: "HEALTH_REPORT_INTERVAL_MINUTES",
  cpuAlert: "CPU_ALERT_PERCENT", cpuAlertFor: "CPU_ALERT_FOR_SECONDS", ramAlert: "RAM_ALERT_PERCENT", ramAlertFor: "RAM_ALERT_FOR_SECONDS",
  diskAlert: "DISK_ALERT_PERCENT", diskAlertFor: "DISK_ALERT_FOR_SECONDS", tempAlert: "TEMP_ALERT_CELSIUS", tempAlertFor: "TEMP_ALERT_FOR_SECONDS",
  hysteresis: "ALERT_HYSTERESIS", devNoAuth: "DEV_NO_AUTH", subRepo: "SUB_REPO", subBranch: "SUB_BRANCH",
  autoUpdate: "AUTO_UPDATE", updateCheckMinutes: "UPDATE_CHECK_MINUTES", updateBranch: "UPDATE_BRANCH",
  githubToken: "UPDATE_GITHUB_TOKEN", subGithubToken: "SUB_GITHUB_TOKEN",
};

const str = (name, def = "") => (process.env[name] ?? def).toString().trim();
const num = (name, def) => {
  const raw = str(name);
  if (!raw) return def;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`);
  return n;
};
const bool = (name, def = false) => {
  const raw = str(name).toLowerCase();
  return raw ? ["1", "true", "yes", "on"].includes(raw) : def;
};
const ids = (name) =>
  str(name)
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n)) throw new Error(`${name}: "${x}" is not a Telegram ID`);
      return n;
    });

/** Read the .env files again (for a reload). Values from the files win; lines removed from them are dropped. */
function rereadEnvFiles() {
  const info = readEnvFiles();
  if (!info.used.length) throw Object.assign(new Error(`no .env found (${ENV_FILES.join(", ")})`), { code: "ENOENT" });
  // the file WATCHDOG_ENV_FILE points to went missing: don't quietly fall back to the other one
  if (EXTRA_ENV && info.missing.includes(ENV_FILES[0])) throw new Error(`${ENV_FILES[0]} not found (WATCHDOG_ENV_FILE)`);
  applyEnvFiles(info);
}

/** @returns {{cfg: object, problems: string[]}} */
export function readConfig({ reload = false } = {}) {
  if (reload) rereadEnvFiles();
  const webappUrl = str("WEBAPP_URL").replace(/\/+$/, "/");
  let publicUrl = str("PUBLIC_URL").replace(/\/+$/, "");
  if (!publicUrl && webappUrl) {
    try {
      publicUrl = new URL(webappUrl).origin;
    } catch {
      /* ignore */
    }
  }

  const cfg = {
    botToken: str("BOT_TOKEN"),
    adminIds: ids("ADMIN_IDS"),
    alertChatIds: ids("ALERT_CHAT_IDS"),
    webappUrl,
    publicUrl, // what sub servers use as MAIN_SERVER_URL
    // 127.0.0.1 = only reachable through aaPanel/nginx on the same machine (recommended)
    host: str("HOST", "127.0.0.1"),
    port: num("PORT", 8080),
    // relative paths are relative to the main-server folder, wherever it is started from
    dataFile: path.resolve(APP_DIR, str("DATA_FILE", "data/watchdog.json")),
    timezone: str("TIMEZONE"), // e.g. America/Toronto; empty = the machine's time zone

    offlineAfter: num("OFFLINE_AFTER_SECONDS", 30),
    historyMinutes: num("HISTORY_MINUTES", 60),
    reportIntervalMinutes: num("HEALTH_REPORT_INTERVAL_MINUTES", 360),

    cpuAlert: num("CPU_ALERT_PERCENT", 90),
    cpuAlertFor: num("CPU_ALERT_FOR_SECONDS", 120),
    ramAlert: num("RAM_ALERT_PERCENT", 90),
    ramAlertFor: num("RAM_ALERT_FOR_SECONDS", 120),
    diskAlert: num("DISK_ALERT_PERCENT", 90),
    diskAlertFor: num("DISK_ALERT_FOR_SECONDS", 0),
    tempAlert: num("TEMP_ALERT_CELSIUS", 80),
    tempAlertFor: num("TEMP_ALERT_FOR_SECONDS", 60),
    hysteresis: num("ALERT_HYSTERESIS", 5),

    devNoAuth: bool("DEV_NO_AUTH", false),

    // The sub-server project lives in its own repo now: the bot builds its
    // one-line installer from this URL (empty = no one-liner, .env snippet only).
    subRepo: str("SUB_REPO"),
    subBranch: str("SUB_BRANCH"),

    // auto-update from GitHub (the main server must run from a git clone)
    autoUpdate: bool("AUTO_UPDATE", true),
    updateCheckMinutes: num("UPDATE_CHECK_MINUTES", 30),
    updateBranch: str("UPDATE_BRANCH"),
    githubToken: str("UPDATE_GITHUB_TOKEN"),
    // only if SUB_REPO is private and UPDATE_GITHUB_TOKEN cannot read it
    subGithubToken: str("SUB_GITHUB_TOKEN"),
  };

  cfg.recipients = [...new Set([...cfg.adminIds, ...cfg.alertChatIds])];

  const problems = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) problems.push(`PORT must be 1-65535 (got ${cfg.port})`);
  if (!cfg.botToken) problems.push("BOT_TOKEN is not set (get one from @BotFather)");
  if (!cfg.adminIds.length) problems.push("ADMIN_IDS is empty (send /start to your bot to see your Telegram ID)");
  if (!(cfg.offlineAfter >= 10)) problems.push(`OFFLINE_AFTER_SECONDS must be at least 10 (got ${cfg.offlineAfter})`);
  if (!(cfg.historyMinutes >= 1 && cfg.historyMinutes <= 1440)) problems.push("HISTORY_MINUTES must be between 1 and 1440");
  if (!(cfg.hysteresis >= 0)) problems.push("ALERT_HYSTERESIS must be 0 or more");
  for (const k of ["cpuAlertFor", "ramAlertFor", "diskAlertFor", "tempAlertFor", "reportIntervalMinutes"]) {
    if (!(cfg[k] >= 0)) problems.push(`${k} must be 0 or more`);
  }
  return { cfg, problems };
}

export function loadConfig() {
  const { cfg, problems } = readConfig();
  if (problems.length) {
    console.error("Watchdog config error:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  if (!cfg.publicUrl) {
    console.warn("PUBLIC_URL / WEBAPP_URL not set: .env snippets for sub servers will show a placeholder URL");
  }
  return cfg;
}
