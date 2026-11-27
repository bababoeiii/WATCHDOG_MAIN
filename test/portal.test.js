// Website: accounts, second step, Telegram login, permissions, event log, live updates.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { Monitor } from "../src/monitor.js";
import { Notifier } from "../src/notifier.js";
import { Store } from "../src/store.js";
import { EventLog } from "../src/events.js";
import { MemoryBackend } from "../src/db.js";
import { Accounts, base32Decode, base32Encode, checkPassword, hashPassword, totpCode, verifyTelegramLogin, verifyTotp } from "../src/accounts.js";
import { createMailer } from "../src/mailer.js";
import { BOT_TOKEN, report, testConfig } from "./helpers.js";

// ---------------------------------------------------------------- units
test("TOTP matches the RFC 6238 test vectors (SHA-1, last 6 digits)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(secret).toString(), "12345678901234567890");
  for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1234567890, "005924"], [2000000000, "279037"]]) {
    assert.equal(totpCode(secret, Math.floor(t / 30)), code);
  }
  const at = 1234567890 * 1000;
  assert.equal(verifyTotp(secret, "005924", { at }), Math.floor(1234567890 / 30));
  assert.equal(verifyTotp(secret, "000000", { at }), null);
  assert.equal(verifyTotp(secret, "12345", { at }), null);
});

test("passwords: scrypt hash, wrong password fails, garbage hash fails", () => {
  const h = hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$/);
  assert.ok(checkPassword("correct horse battery", h));
  assert.ok(!checkPassword("correct horse batterY", h));
  assert.ok(!checkPassword("x", "nonsense"));
  assert.notEqual(hashPassword("same"), hashPassword("same")); // salted
});

const signTelegram = (data, token = BOT_TOKEN) => {
  const check = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(token).digest();
  return { ...data, hash: crypto.createHmac("sha256", secret).update(check).digest("hex") };
};

test("Telegram login widget data: valid, tampered, foreign bot, expired", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = signTelegram({ id: 42, first_name: "F", username: "f", auth_date: now });
  assert.equal(verifyTelegramLogin(good, BOT_TOKEN).id, 42);
  assert.equal(verifyTelegramLogin({ ...good, id: 43 }, BOT_TOKEN), null);
  assert.equal(verifyTelegramLogin(signTelegram({ id: 42, auth_date: now }, "999:other"), BOT_TOKEN), null);
  assert.equal(verifyTelegramLogin(signTelegram({ id: 42, auth_date: now - 7200 }), BOT_TOKEN), null);
  assert.equal(verifyTelegramLogin(null, BOT_TOKEN), null);
});

test("event log: kept across restarts, old entries dropped, newest first, filtered", async () => {
  const be = new MemoryBackend();
  await be.insertEvents([{ id: 1, ts: Date.now() / 1000 - 40 * 86400, kind: "down", server: "a", text: "old" }]);
  let log = new EventLog(be, 30);
  await log.load();
  assert.equal(log.events.length, 0); // 40 days old: gone
  assert.equal(be.events.length, 0);
  for (let i = 0; i < 5; i++) log.add({ kind: i % 2 ? "alert" : "down", text: `<b>e${i}</b>`, server: { id: i < 3 ? "a" : "b", name: "x" } });
  await log.stop();
  log = new EventLog(be, 30); // "restart"
  await log.load();
  assert.equal(log.events.length, 5);
  assert.equal(log.events[0].text, "e0"); // stored as plain text
  assert.ok(log.nextId > 5);
  const all = log.query({ visible: () => true });
  assert.deepEqual(all.map((e) => e.text), ["e4", "e3", "e2", "e1", "e0"]);
  assert.deepEqual(log.query({ visible: (e) => e.server === "a" }).map((e) => e.text), ["e2", "e1", "e0"]);
  assert.deepEqual(log.query({ kind: "alert", visible: () => true }).map((e) => e.text), ["e3", "e1"]);
  assert.deepEqual(log.query({ before: all[1].id, limit: 2, visible: () => true }).map((e) => e.text), ["e2", "e1"]);
});

test("event log: kept in memory while the database is away, written when it's back", async () => {
  const be = new MemoryBackend();
  const log = new EventLog(be, 30);
  await log.load();
  const insert = be.insertEvents.bind(be);
  be.insertEvents = async () => { throw new Error("down"); };
  const orig = console.error;
  console.error = () => {};
  log.add({ kind: "down", text: "a" });
  await new Promise((r) => setTimeout(r, 10));
  console.error = orig;
  assert.equal(be.events.length, 0);
  assert.equal(log.pending.length, 1);
  be.insertEvents = insert;
  log.add({ kind: "online", text: "b" });
  await log.stop();
  assert.deepEqual(be.events.map((e) => e.text), ["a", "b"]);
});

// ---------------------------------------------------------------- the portal over HTTP
let base, http, mon, store, notifier, events, accounts, smtp, mails = [], origLog;

/** Minimal SMTP server that keeps every message (enough for nodemailer without TLS). */
function fakeSmtp() {
  return net.createServer((sock) => {
    let data = false, body = "";
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n")) {
        if (data) {
          if (line === ".") { data = false; mails.push(body); sock.write("250 OK\r\n"); body = ""; }
          else body += line + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (!line) continue;
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250 test\r\n");
        else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
}
const lastCode = () => /\b(\d{6})\b/.exec(mails.at(-1) || "")?.[1];

before(async () => {
  origLog = console.log;
  console.log = () => {};
  smtp = fakeSmtp();
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  const cfg = testConfig({ smtpHost: "127.0.0.1", smtpPort: smtp.address().port, smtpSecure: false, smtpFrom: "wd@test", sessionDays: 7 });
  store = new Store();
  notifier = new Notifier(null, cfg, store, { batchMs: 0 });
  events = new EventLog(new MemoryBackend(), 30);
  const notify = (text, important = false, meta = {}) =>
    events.add({ kind: meta.kind || "main", text, server: meta.server || null, important, muted: notifier.isMuted() });
  accounts = new Accounts(store, cfg, createMailer(cfg));
  let broadcast = () => {};
  mon = new Monitor(cfg, store, notify, (m) => broadcast(m));
  http = createServer(cfg, mon, notifier, async () => ({ status: "up-to-date" }), { events, accounts, notify, botUsername: () => "test_bot" });
  broadcast = http.broadcast;
  await new Promise((r) => http.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${http.server.address().port}`;
});
after(async () => {
  await http.close();
  smtp.close();
  clearTimeout(store.timer);
  console.log = origLog;
});

/** A browser: keeps the session cookie. */
class Client {
  cookie = "";
  async req(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch { /* html */ }
    return { status: res.status, json, res };
  }
  get = (p) => this.req("GET", p);
  post = (p, b = {}) => this.req("POST", p, b);
}
const agentReport = (token, extra = {}) =>
  fetch(`${base}/api/agent/report`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...report(), ...extra }) }).then((r) => r.json());
const codeNow = (secret, after = -1) => {
  const step = Math.max(Math.floor(Date.now() / 30_000), after + 1); // a code is accepted once: use the next step
  return totpCode(secret, step);
};

const owner = new Client(), alice = new Client(), bob = new Client();
const ids = {};

test("page + security headers; API needs a login; CSRF guards", async () => {
  const page = await fetch(`${base}/`);
  assert.equal((await fetch(`${base}/portal/`)).status, 404); // gone: the home page is the login page
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org$/); // only Telegram may frame it
  assert.equal((await new Client().get("/api/web/me")).status, 401);
  assert.equal((await new Client().get("/api/web/events")).status, 401);
  assert.equal((await new Client().req("POST", "/api/web/login", "username=a&password=b", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await new Client().req("POST", "/api/web/login", { username: "a", password: "b" }, { Origin: "https://evil.example" })).status, 403);
  const cfg = (await new Client().get("/api/web/config")).json;
  assert.equal(cfg.bot_username, "test_bot");
  assert.equal(cfg.email_codes, true);
});

test("owner logs in with Telegram (ADMIN_IDS); strangers and a bad signature can't", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await new Client().post("/api/web/login/telegram", signTelegram({ id: 7, first_name: "X", auth_date: now }))).status, 403);
  assert.equal((await new Client().post("/api/web/login/telegram", { id: 42, auth_date: now, hash: "00" })).status, 401);
  const r = await owner.post("/api/web/login/telegram", signTelegram({ id: 42, first_name: "F", auth_date: now }));
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("set-cookie"), /HttpOnly/i);
  assert.equal((await owner.get("/api/web/me")).json.me.role, "owner");
});

test("one-time login link from the bot (/login): works once, only for ADMIN_IDS", async () => {
  const token = accounts.loginLink(42);
  const c = new Client();
  assert.equal((await c.post("/api/web/login/link", { token })).status, 200);
  assert.equal((await c.get("/api/web/me")).json.me.role, "owner");
  assert.equal((await new Client().post("/api/web/login/link", { token })).status, 401); // used
  assert.equal((await new Client().post("/api/web/login/link", { token: accounts.loginLink(7) })).status, 401); // not an admin
});

test("owner adds servers and creates staff + user accounts with invite links", async () => {
  for (const name of ["web-1", "db-1"]) {
    const r = await owner.post("/api/web/servers", { name });
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^wd_/);
    ids[name] = r.json.server.id;
    ids[`${name}:token`] = r.json.token;
  }
  const a = await owner.post("/api/web/accounts", { username: "Alice", role: "staff", servers: [ids["web-1"], "nonexistent"] });
  assert.equal(a.status, 200);
  assert.equal(a.json.account.username, "alice");
  assert.deepEqual(a.json.account.servers, [ids["web-1"]]); // unknown ids dropped
  ids.alice = a.json.account.id;
  ids.aliceInvite = /#invite=(.+)$/.exec(a.json.invite_url)[1];
  const b = await owner.post("/api/web/accounts", { username: "bob", role: "user", servers: [ids["db-1"]] });
  ids.bob = b.json.account.id;
  ids.bobInvite = /#invite=(.+)$/.exec(b.json.invite_url)[1];
  assert.equal((await owner.post("/api/web/accounts", { username: "alice", role: "user" })).status, 400); // taken
  assert.equal((await owner.post("/api/web/accounts", { username: "x", role: "user" })).status, 400); // too short
  assert.equal((await owner.post("/api/web/accounts", { username: "carol", role: "god" })).status, 400);
  // invited accounts can't log in yet
  assert.equal((await new Client().post("/api/web/login", { username: "alice", password: "whatever-long" })).status, 401);
});

test("invite: authenticator app setup (password rules, wrong code, then done)", async () => {
  const inv = ids.aliceInvite;
  assert.equal((await alice.get(`/api/web/invite/${inv}`)).json.username, "alice");
  assert.equal((await alice.get(`/api/web/invite/not-a-real-token`)).status, 404);
  const t = await alice.post(`/api/web/invite/${inv}/totp`);
  assert.match(t.json.qr, /^<svg/);
  assert.match(t.json.url, /^otpauth:\/\/totp\/Watchdog:alice\?secret=/);
  ids.aliceSecret = t.json.secret;
  assert.equal((await alice.post(`/api/web/invite/${inv}/finish`, { password: "short", method: "totp", code: codeNow(t.json.secret) })).status, 400);
  assert.equal((await alice.post(`/api/web/invite/${inv}/finish`, { password: "alice-password-1", method: "totp", code: "000000" })).status, 400);
  const ok = await alice.post(`/api/web/invite/${inv}/finish`, { password: "alice-password-1", method: "totp", code: codeNow(t.json.secret) });
  assert.equal(ok.status, 200);
  assert.equal((await alice.get("/api/web/me")).json.me.role, "staff");
  assert.equal((await new Client().get(`/api/web/invite/${inv}`)).status, 404); // used up
});

test("invite: e-mail code setup", async () => {
  const inv = ids.bobInvite;
  assert.equal((await bob.post(`/api/web/invite/${inv}/email`, { email: "not-an-email" })).status, 400);
  assert.equal((await bob.post(`/api/web/invite/${inv}/email`, { email: "bob@example.com" })).status, 200);
  assert.equal((await bob.post(`/api/web/invite/${inv}/email`, { email: "bob@example.com" })).status, 400); // wait a minute
  const code = lastCode();
  assert.match(code, /^\d{6}$/);
  assert.equal((await bob.post(`/api/web/invite/${inv}/finish`, { password: "bob-password-12", method: "email", code: "111111" === code ? "222222" : "111111" })).status, 400);
  assert.equal((await bob.post(`/api/web/invite/${inv}/finish`, { password: "bob-password-12", method: "email", code })).status, 200);
  assert.equal((await bob.get("/api/web/me")).json.me.role, "user");
});

test("login: password + authenticator code (a code works once); password + e-mail code", async () => {
  const c = new Client();
  assert.equal((await c.post("/api/web/login", { username: "alice", password: "wrong-password" })).status, 401);
  const step1 = await c.post("/api/web/login", { username: "ALICE", password: "alice-password-1" });
  assert.equal(step1.status, 200);
  assert.equal(step1.json.method, "totp");
  assert.equal(c.cookie, ""); // no session before the second step
  const a = accounts.get(ids.alice);
  assert.equal((await c.post("/api/web/login/verify", { ticket: step1.json.ticket, code: totpCode(ids.aliceSecret, a.lastTotpStep) })).status, 401); // reused
  assert.equal((await c.post("/api/web/login/verify", { ticket: step1.json.ticket, code: codeNow(ids.aliceSecret, a.lastTotpStep) })).status, 200);
  assert.equal((await c.get("/api/web/me")).json.me.name, "alice");

  const b = new Client();
  const s1 = await b.post("/api/web/login", { username: "bob", password: "bob-password-12" });
  assert.equal(s1.json.method, "email");
  assert.match(s1.json.email, /^bo.*@example\.com$/);
  assert.equal((await b.post("/api/web/login/verify", { ticket: s1.json.ticket, code: lastCode() })).status, 200);
});

test("too many wrong passwords: locked for a while", async () => {
  const c = new Client();
  for (let i = 0; i < 10; i++) await c.req("POST", "/api/web/login", { username: "lockme", password: `nope-${i}` }, { "X-Forwarded-For": "1.1.1.1" });
  assert.equal((await c.post("/api/web/login", { username: "lockme", password: "again" })).status, 429);
});

test("roles: who sees which servers and events; who may add servers, manage accounts", async () => {
  // reports make events: web-1 (alice's) and db-1 (bob's)
  await agentReport(ids["web-1:token"]);
  await agentReport(ids["db-1:token"]);
  const names = async (c) => (await c.get("/api/web/overview")).json.servers.map((s) => s.name).sort();
  assert.deepEqual(await names(owner), ["db-1", "web-1"]);
  assert.deepEqual(await names(alice), ["web-1"]);
  assert.deepEqual(await names(bob), ["db-1"]);

  const evNames = async (c, q = "") => [...new Set((await c.get(`/api/web/events${q}`)).json.events.map((e) => e.name || (e.kind === "audit" ? "audit" : "main")))].sort();
  assert.deepEqual(await evNames(alice), ["web-1"]); // no audit, no main-server events, no db-1
  assert.deepEqual(await evNames(bob), ["db-1"]);
  assert.ok((await evNames(owner)).includes("audit"));
  assert.equal((await alice.get(`/api/web/events?server=${ids["db-1"]}`)).json.events.length, 0); // asking for it doesn't help

  assert.equal((await alice.get("/api/web/accounts")).status, 403);
  assert.equal((await bob.post("/api/web/servers", { name: "bob-box" })).status, 403);

  // staff: a server they add is assigned to them
  const added = await alice.post("/api/web/servers", { name: "web-2" });
  assert.equal(added.status, 200);
  assert.deepEqual(await names(alice), ["web-1", "web-2"]);
  assert.equal((await alice.post(`/api/web/servers/${ids["web-1"]}/reboot`)).status, 404); // remote reboot is gone
});

test("live: each viewer gets only their servers' events", async () => {
  const open = (c) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws/web`, { headers: { Cookie: c.cookie } });
      const got = [];
      ws.on("message", (m) => got.push(JSON.parse(m)));
      ws.on("open", () => resolve({ ws, got }));
      ws.on("error", reject);
    });
  const a = await open(alice), b = await open(bob);
  const closedWith = await new Promise((r) => {
    // no cookie and no Telegram login as the first message: closed, nothing sent
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/web`);
    const got = [];
    ws.on("message", (m) => got.push(m));
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", initData: "auth_date=1&hash=00" })));
    ws.on("close", (code) => r({ code, got: got.length }));
  });
  assert.deepEqual(closedWith, { code: 4401, got: 0 });
  mon.handleGoodbye(mon.get(ids["web-1"]), "shutdown"); // web-1 goes offline → event + server update
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(a.got.some((m) => m.type === "event" && m.event.server === ids["web-1"]));
  assert.ok(a.got.some((m) => m.type === "server" && m.server.status === "offline"));
  assert.ok(!b.got.some((m) => (m.type === "event" && m.event.server === ids["web-1"]) || (m.type === "server" && m.server.id === ids["web-1"])));
  a.ws.close();
  b.ws.close();
});

test("muted notifications are still logged, marked muted", async () => {
  notifier.mute(10);
  await agentReport(ids["web-1:token"]); // back online
  notifier.unmute();
  const e = (await owner.get(`/api/web/events?server=${ids["web-1"]}&kind=online`)).json.events[0];
  assert.equal(e.muted, true);
});

test("owner: reassign, disable, reset, delete; can't lock themselves out; logins end at once", async () => {
  assert.equal((await owner.req("PATCH", `/api/web/accounts/${ids.bob}`, { servers: [ids["web-1"]] })).status, 200);
  assert.deepEqual((await bob.get("/api/web/overview")).json.servers.map((s) => s.name), ["web-1"]);
  assert.equal((await owner.req("PATCH", `/api/web/accounts/${ids.bob}`, { disabled: true })).status, 200);
  assert.equal((await bob.get("/api/web/me")).status, 401);
  const reset = await owner.post(`/api/web/accounts/${ids.alice}/reset`);
  assert.match(reset.json.invite_url, /#invite=/);
  assert.equal((await alice.get("/api/web/me")).status, 401);
  assert.equal((await new Client().post("/api/web/login", { username: "alice", password: "alice-password-1" })).status, 401);
  assert.equal((await owner.req("DELETE", `/api/web/accounts/${ids.bob}`, {})).status, 200);
  assert.equal((await owner.get("/api/web/accounts")).json.accounts.some((a) => a.id === ids.bob), false);
  // an owner account can't demote/disable/delete itself
  const o = await owner.post("/api/web/accounts", { username: "owner2", role: "owner" });
  const own = new Client();
  const inv = /#invite=(.+)$/.exec(o.json.invite_url)[1];
  const t = await own.post(`/api/web/invite/${inv}/totp`);
  await own.post(`/api/web/invite/${inv}/finish`, { password: "owner2-password", method: "totp", code: codeNow(t.json.secret) });
  for (const [m, p, b] of [["PATCH", "", { role: "user" }], ["PATCH", "", { disabled: true }], ["DELETE", "", {}], ["POST", "/reset", {}]]) {
    assert.equal((await own.req(m, `/api/web/accounts/${o.json.account.id}${p}`, b)).status, 400);
  }
  // a removed server disappears from every assignment
  mon.removeServer(ids["web-1"]);
  http.broadcast({ type: "removed", id: ids["web-1"] });
  assert.ok(!accounts.all().some((a) => a.servers.includes(ids["web-1"])));
});

test("owner: who can see a server, chosen on the server (staff/user only; logged; others can't)", async () => {
  const add = await owner.post("/api/web/servers", { name: "access-box" });
  const sid = add.json.server.id;
  const u = await owner.post("/api/web/accounts", { username: "carol", role: "user" });
  const carol = u.json.account.id;
  const o = await owner.post("/api/web/accounts", { username: "dave", role: "owner" });
  let r = await owner.get(`/api/web/servers/${sid}/access`);
  assert.equal(r.status, 200);
  assert.ok(r.json.candidates.some((a) => a.username === "carol"));
  assert.ok(!r.json.candidates.some((a) => a.username === "dave")); // owners see everything anyway
  r = await owner.post(`/api/web/servers/${sid}/access`, { account_id: carol });
  assert.deepEqual(r.json.assigned.map((a) => a.username), ["carol"]);
  assert.ok(accounts.get(carol).servers.includes(sid));
  assert.equal((await owner.post(`/api/web/servers/${sid}/access`, { account_id: o.json.account.id })).status, 400);
  assert.equal((await owner.post(`/api/web/servers/nope/access`, { account_id: carol })).status, 404);
  assert.equal((await owner.post(`/api/web/servers/${sid}/access`, { account_id: "nope" })).status, 404);
  const staff = new Client();
  const inv = /#invite=(.+)$/.exec((await owner.post("/api/web/accounts", { username: "erin", role: "staff", servers: [sid] })).json.invite_url)[1];
  const t = await staff.post(`/api/web/invite/${inv}/totp`);
  await staff.post(`/api/web/invite/${inv}/finish`, { password: "erin-password-1", method: "totp", code: codeNow(t.json.secret) });
  assert.equal((await staff.get(`/api/web/servers/${sid}/access`)).status, 403);
  assert.equal((await staff.post(`/api/web/servers/${sid}/access`, { account_id: carol })).status, 403);
  r = await owner.req("DELETE", `/api/web/servers/${sid}/access/${carol}`, {});
  assert.deepEqual(r.json.assigned.map((a) => a.username), ["erin"]);
  assert.ok(!accounts.get(carol).servers.includes(sid));
  const audit = (await owner.get("/api/web/events?kind=audit")).json.events.map((e) => e.text);
  assert.ok(audit.some((x) => /gave carol access to access-box/.test(x)));
  assert.ok(audit.some((x) => /removed carol's access to access-box/.test(x)));
});
