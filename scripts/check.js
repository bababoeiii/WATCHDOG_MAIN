#!/usr/bin/env node
// Self-check of a main-server install: `watchdog-main test` (or `node scripts/check.js`).
// Reads .env, then checks Telegram, the local port, the public HTTPS address, the data file
// and both GitHub repos. Changes nothing. Exit code 1 if any check failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFiles, ENV_FILES, readConfig } from "../src/config.js";
import { createUpdater, remoteHeads } from "../src/updater.js";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = { ok: 0, warn: 0, fail: 0 };
const line = (kind, label, detail = "") => {
  results[kind]++;
  const icon = { ok: "✔", warn: "⚠", fail: "✖" }[kind];
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ""}`);
};
const ok = (l, d) => line("ok", l, d);
const warn = (l, d) => line("warn", l, d);
const fail = (l, d) => line("fail", l, d);
const why = (e) => e?.cause?.code || e?.cause?.message || e?.message || String(e);

async function getJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- .env
console.log(`Checking ${APP_DIR}\n`);
const env = envFiles();
if (!env.used.length) {
  fail(".env", `not found: ${ENV_FILES.join(", ")} (run the installer or copy .env.example)`);
  process.exit(1);
}
// Several files are merged: the first one wins, the next ones fill in what it doesn't set.
for (const f of ENV_FILES) {
  if (env.missing.includes(f)) {
    (f === ENV_FILES[0] && ENV_FILES.length > 1 ? fail : warn)(".env", `${f} not found${f === ENV_FILES[0] ? " (WATCHDOG_ENV_FILE points to it)" : ""}`);
    continue;
  }
  const mode = fs.statSync(f).mode & 0o777;
  const role = ENV_FILES.length === 1 ? "" : f === env.used[0] ? " (wins)" : " (fills in the rest)";
  if (mode & 0o077) warn(".env permissions", `${f}: ${mode.toString(8)}, readable by other users; it holds the bot token (chmod 600)`);
  else ok(".env", `${f}${role}`);
}
if (env.used.length > 1) {
  const first = new Set(env.keysOf[env.used[0]]);
  const filled = [...new Set(env.used.slice(1).flatMap((f) => env.keysOf[f]))].filter((k) => !first.has(k));
  if (filled.length) ok(".env merge", `taken from ${env.used.slice(1).join(", ")}: ${filled.join(", ")}`);
}

const { cfg, problems } = readConfig();
if (problems.length) {
  for (const p of problems) fail("config", p);
  console.log(`\n${results.fail} problem(s) in .env — fix them first.`);
  process.exit(1);
}
ok("config", "all values valid");

// ---------------------------------------------------------------- Telegram
const tg = (method, params = {}) =>
  getJson(`https://api.telegram.org/bot${cfg.botToken}/${method}?${new URLSearchParams(params)}`);
let botId = null;
try {
  const { body } = await tg("getMe");
  if (body?.ok) {
    botId = body.result.id;
    ok("BOT_TOKEN", `@${body.result.username}`);
  } else fail("BOT_TOKEN", `Telegram says: ${body?.description || "invalid"} (get a token from @BotFather)`);
} catch (e) {
  fail("Telegram", `can't reach api.telegram.org: ${why(e)}`);
}

if (botId) {
  for (const id of cfg.adminIds) {
    const { body } = await tg("getChat", { chat_id: id }).catch(() => ({}));
    if (body?.ok) ok(`admin ${id}`, [body.result.first_name, body.result.username && `@${body.result.username}`].filter(Boolean).join(" "));
    else warn(`admin ${id}`, "unknown to the bot: send /start to the bot from this account, or it gets no notifications");
  }
  for (const id of cfg.alertChatIds) {
    const { body } = await tg("getChat", { chat_id: id }).catch(() => ({}));
    if (!body?.ok) {
      fail(`ALERT_CHAT_IDS ${id}`, `${body?.description || "not reachable"} (is the bot in this group? group IDs start with -100)`);
      continue;
    }
    const m = await tg("getChatMember", { chat_id: id, user_id: botId }).catch(() => ({}));
    const status = m.body?.result?.status;
    const canPost = m.body?.result?.can_send_messages !== false && !["left", "kicked"].includes(status);
    if (canPost) ok(`ALERT_CHAT_IDS ${id}`, `"${body.result.title}" (bot is ${status})`);
    else fail(`ALERT_CHAT_IDS ${id}`, `"${body.result.title}": the bot can't post there (${status || "unknown"})`);
  }
  if (!cfg.alertChatIds.length) ok("ALERT_CHAT_IDS", "none (notifications go to the admins only)");
}

// ---------------------------------------------------------------- HTTP
const localHost = ["0.0.0.0", "::", ""].includes(cfg.host) ? "127.0.0.1" : cfg.host;
const local = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${cfg.port}`;
let running = false;
try {
  const { body } = await getJson(`${local}/healthz`, 3000);
  running = Boolean(body?.ok);
  if (running) ok("local port", `${local} answers (${body.servers} server(s) registered)`);
  else fail("local port", `${local} answers, but not like Watchdog (another program on this port?)`);
} catch (e) {
  fail("local port", `${local}: ${why(e)} — is the service running? (watchdog-main start)`);
}

if (!cfg.publicUrl) {
  warn("PUBLIC_URL", "not set: sub servers don't know where to report");
} else if (!/^https:\/\//i.test(cfg.publicUrl)) {
  warn("PUBLIC_URL", `${cfg.publicUrl} is not https: sub-server tokens travel unencrypted`);
}
if (cfg.publicUrl) {
  try {
    const { status, body } = await getJson(`${cfg.publicUrl}/healthz`);
    if (body?.ok) ok("public URL", `${cfg.publicUrl} reaches this server (sub servers can report)`);
    else if (status >= 300 && status < 400) fail("public URL", `${cfg.publicUrl}/healthz redirects (${status}): check the nginx proxy block (npm run nginx)`);
    else fail("public URL", `${cfg.publicUrl}/healthz → HTTP ${status}: nginx doesn't proxy to port ${cfg.port}? (npm run nginx)`);
  } catch (e) {
    fail("public URL", `${cfg.publicUrl}: ${why(e)} (DNS, firewall or SSL certificate)`);
  }
}
if (cfg.webappUrl) {
  if (!/^https:\/\//i.test(cfg.webappUrl)) fail("WEBAPP_URL", "must be https:// (Telegram refuses Mini Apps over http)");
  else {
    try {
      const res = await fetch(cfg.webappUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) ok("dashboard", cfg.webappUrl);
      else fail("dashboard", `${cfg.webappUrl} → HTTP ${res.status}`);
    } catch (e) {
      fail("dashboard", `${cfg.webappUrl}: ${why(e)}`);
    }
  }
} else {
  warn("WEBAPP_URL", "not set: no dashboard button in Telegram");
}

// ---------------------------------------------------------------- data file
try {
  const dir = path.dirname(cfg.dataFile);
  fs.accessSync(dir, fs.constants.W_OK);
  if (fs.existsSync(cfg.dataFile)) {
    const data = JSON.parse(fs.readFileSync(cfg.dataFile, "utf8"));
    fs.accessSync(cfg.dataFile, fs.constants.W_OK);
    ok("data file", `${cfg.dataFile} (${Object.keys(data.servers || {}).length} server(s))`);
  } else {
    ok("data file", `${cfg.dataFile} doesn't exist yet (created on first use)`);
  }
} catch (e) {
  fail("data file", `${cfg.dataFile}: ${e.code === "EACCES" ? "not writable by this user" : e.message}`);
}

// ---------------------------------------------------------------- GitHub (two repos)
const u = await createUpdater({ appDir: APP_DIR, branch: cfg.updateBranch || undefined, githubToken: cfg.githubToken, auto: cfg.autoUpdate, log: () => {} });
if (!u.enabled) {
  warn("auto-update", `off: ${u.reason}`);
} else {
  try {
    const heads = await remoteHeads(u.remote, { githubToken: cfg.githubToken });
    if (heads[u.branch]) {
      const latest = heads[u.branch].slice(0, 7);
      const at = u.info().commit;
      ok("main repo", `${u.remote} (${u.branch}) · running ${at}${at === latest ? ", up to date" : `, GitHub has ${latest}`}`);
    } else fail("main repo", `${u.remote} has no branch "${u.branch}"`);
  } catch (e) {
    fail("main repo", `${u.remote}: ${e.message} (private repo? set UPDATE_GITHUB_TOKEN)`);
  }
}
if (!cfg.subRepo) {
  warn("SUB_REPO", "not set: no one-line installer, and /version can't tell which sub servers are behind");
} else {
  const branch = cfg.subBranch || "main";
  try {
    const heads = await remoteHeads(cfg.subRepo, { githubToken: cfg.subGithubToken || cfg.githubToken });
    if (heads[branch]) ok("sub repo", `${cfg.subRepo} (${branch}) · latest ${heads[branch].slice(0, 7)}`);
    else fail("sub repo", `${cfg.subRepo} has no branch "${branch}" (SUB_BRANCH)`);
  } catch (e) {
    fail("sub repo", `${cfg.subRepo}: ${e.message} (private repo? set SUB_GITHUB_TOKEN)`);
  }
}

console.log(
  `\n${results.fail ? "✖" : "✔"} ${results.ok} ok · ${results.warn} warning(s) · ${results.fail} failed` +
    (running ? "" : "\n  (the service isn't answering; start it with: watchdog-main start)"),
);
process.exit(results.fail ? 1 : 0);
