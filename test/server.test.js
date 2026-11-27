import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { Monitor } from "../src/monitor.js";
import { Notifier } from "../src/notifier.js";
import { Store } from "../src/store.js";
import { initData, report, testConfig } from "./helpers.js";
import { Accounts } from "../src/accounts.js";
import { EventLog } from "../src/events.js";
import { MemoryBackend } from "../src/db.js";

let base, http, mon, store, accounts, origLog;
before(async () => {
  origLog = console.log;
  console.log = () => {};
  const cfg = testConfig();
  store = new Store();
  const notifier = new Notifier(null, cfg, store, { batchMs: 0 });
  let broadcast = () => {};
  mon = new Monitor(cfg, store, () => {}, (m) => broadcast(m));
  accounts = new Accounts(store, cfg, null);
  const events = new EventLog(new MemoryBackend(), 30);
  const notify = (text, important = false, meta = {}) => events.add({ kind: meta.kind || "main", text, server: meta.server || null, important });
  http = createServer(cfg, mon, notifier, async () => ({ status: "up-to-date" }), { events, accounts, notify, botUsername: () => "test_bot" });
  broadcast = http.broadcast;
  await new Promise((r) => http.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${http.server.address().port}`;
});
after(async () => {
  await http.close();
  clearTimeout(store.timer);
  console.log = origLog;
});

// One page for the browser and Telegram: inside Telegram (Mini App) the login is the signed initData.
const tg = (id) => ({ "X-Telegram-Init-Data": initData(id), "Content-Type": "application/json" });
const admin = tg(42);
const post = (path, body, headers) => fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("Mini App: the website at /app/, Telegram login (owners + linked accounts), Telegram may frame it", async () => {
  for (const p of ["/", "/app/", "/app"]) {
    const r = await fetch(base + p, { redirect: "manual" });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
    assert.match(await r.text(), /telegram-web-app\.js/);
  }
  assert.equal((await fetch(`${base}/api/web/me`)).status, 401);
  const me = await (await fetch(`${base}/api/web/me`, { headers: admin })).json();
  assert.equal(me.me.role, "owner");
  assert.equal(me.me.telegram, true);
  const stranger = await fetch(`${base}/api/web/me`, { headers: tg(7) });
  assert.equal(stranger.status, 403);
  assert.equal((await stranger.json()).telegram_id, 7); // so they can tell an owner their ID
  assert.equal((await fetch(`${base}/api/web/me`, { headers: { "X-Telegram-Init-Data": "auth_date=1&hash=00" } })).status, 401);
  // a staff account linked to Telegram ID 7: same page, its own role, no password needed
  const { account } = accounts.create({ username: "tg-staff", role: "staff", telegramId: 7 }, "test");
  const linked = await (await fetch(`${base}/api/web/me`, { headers: tg(7) })).json();
  assert.equal(linked.me.name, "tg-staff");
  assert.equal(linked.me.role, "staff");
  accounts.update(account.id, { disabled: true });
  assert.equal((await fetch(`${base}/api/web/me`, { headers: tg(7) })).status, 403);
  accounts.remove(account.id);
  // the old dashboard API is gone
  assert.equal((await fetch(`${base}/api/servers`, { headers: admin })).status, 404);
});

test("agent API: token, sanitising, malformed JSON", async () => {
  const r = await (await post("/api/web/servers", { name: "web-1" }, admin)).json();
  assert.match(r.token, /^wd_/);
  assert.match(r.env, /AGENT_TOKEN=wd_/);
  const agent = { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" };

  assert.equal((await post("/api/agent/report", report(), { ...agent, Authorization: "Bearer wd_nope" })).status, 401);
  const ok = await post("/api/agent/report", report({ extra: { cpu: { percent: "<b>x</b>" } } }), agent);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(await ok.json()).sort(), ["id", "name", "ok", "update"]); // no reboot any more
  assert.equal(mon.get("web-1").payload.cpu.percent, null);

  const bad = await post("/api/agent/report", "{not json", agent);
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get("content-type"), /json/);
});

test("owner tools on the website: update a sub server, new token, remove; not for others", async () => {
  const r = await (await post("/api/web/servers", { name: "tools-1" }, admin)).json();
  const id = r.server.id;
  const up = await (await post(`/api/web/servers/${id}/update`, {}, admin)).json();
  assert.equal(up.server.update.requested, true);
  const t = await (await post(`/api/web/servers/${id}/token`, {}, admin)).json();
  assert.notEqual(t.token, r.token);
  assert.equal(mon.authenticate(r.token), null); // old one revoked
  assert.equal(mon.authenticate(t.token).id, id);
  const { account } = accounts.create({ username: "tg-user", role: "user", telegramId: 8, servers: [id] }, "test");
  assert.equal((await post(`/api/web/servers/${id}/update`, {}, tg(8))).status, 403);
  assert.equal((await post(`/api/web/servers/${id}/token`, {}, tg(8))).status, 403);
  assert.equal((await fetch(`${base}/api/web/servers/${id}`, { method: "DELETE", headers: tg(8) })).status, 403);
  assert.equal((await post(`/api/web/main/update`, {}, tg(8))).status, 403);
  assert.equal((await fetch(`${base}/api/web/servers/${id}`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal(mon.get(id), null);
  assert.ok(!accounts.get(account.id).servers.includes(id));
  const main = await (await post(`/api/web/main/update`, {}, admin)).json();
  assert.equal(main.status, "up-to-date");
  accounts.remove(account.id);
});

// Messages are buffered from the moment the socket opens, so none is missed while a test awaits something else.
const openWs = (path = "/ws/web", headers = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + path, { headers });
    ws.inbox = [];
    ws.waiters = [];
    const deliver = (item) => {
      const w = ws.waiters.shift();
      if (w) w(item);
      else ws.inbox.push(item);
    };
    ws.on("message", (m) => deliver({ msg: JSON.parse(m) }));
    ws.on("close", (code) => deliver({ code }));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
const nextMessage = (ws) =>
  ws.inbox.length ? Promise.resolve(ws.inbox.shift()) : new Promise((resolve) => ws.waiters.push(resolve));

test("live updates in Telegram: login as the first message, rejection codes", async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: "auth", initData: initData(42) }));
  const hello = (await nextMessage(ws)).msg;
  assert.equal(hello.type, "hello");
  assert.equal(hello.me.role, "owner");
  const r = await (await post("/api/web/servers", { name: "live-1" }, admin)).json();
  await post("/api/agent/report", report(), { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" });
  let live;
  do live = (await nextMessage(ws)).msg;
  while (!(live.type === "server" && live.point));
  assert.equal(live.server.status, "online");
  ws.close();

  const stranger = await openWs();
  stranger.send(JSON.stringify({ type: "auth", initData: initData(7) }));
  assert.equal((await nextMessage(stranger)).code, 4401);

  const noAuth = await openWs();
  noAuth.send("ping"); // ignored before login
  noAuth.send(JSON.stringify({ type: "hello" }));
  assert.equal((await nextMessage(noAuth)).code, 4401);

  await assert.rejects(openWs("/ws")); // the old dashboard socket is gone
  await assert.rejects(openWs("/ws/web", { Origin: "https://evil.example" }));
});

test("websocket: oversized client messages are refused", async () => {
  const ws = await openWs();
  ws.send("x".repeat(64 * 1024));
  assert.equal((await nextMessage(ws)).code, 1009);
});
