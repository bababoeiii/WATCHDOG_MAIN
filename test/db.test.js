// PostgreSQL storage. Runs against a real database when TEST_DATABASE_URL is set
// (e.g. postgres://watchdog:PASSWORD@127.0.0.1:5432/watchdog_test — its wd_* tables are emptied);
// skipped otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importLegacyFiles, PgBackend, safeUrl } from "../src/db.js";
import { Store } from "../src/store.js";
import { EventLog } from "../src/events.js";
import { tmpFile } from "./helpers.js";

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : "set TEST_DATABASE_URL to run the PostgreSQL tests";
let db;

const wipe = () => db.pool.query("TRUNCATE wd_servers, wd_accounts, wd_sessions, wd_kv, wd_events");

before(async () => {
  if (!URL) return;
  db = new PgBackend(URL);
  await db.init();
  await db.init(); // creating the tables twice is fine
  await wipe();
});
after(async () => {
  if (db) await db.close();
});

test("safeUrl hides the password", () => {
  assert.equal(safeUrl("postgres://wd:s3cret@127.0.0.1:5432/wd"), "postgres://wd:***@127.0.0.1:5432/wd");
  assert.equal(safeUrl("postgres://127.0.0.1/wd"), "postgres://127.0.0.1/wd");
});

test("store: saves to PostgreSQL and loads back (rows changed, rows removed, odd keys)", { skip }, async () => {
  await wipe();
  const st = await Store.open(db);
  st.servers["web-1"] = { id: "web-1", name: "Web 1", payload: { cpu: { percent: 12.5 } }, tokenHash: "ab" };
  st.servers.__proto__ = { id: "__proto__", name: "odd" };
  st.data.accounts.a1 = { id: "a1", username: "alice", servers: ["web-1"] };
  st.data.sessions.h1 = { who: { type: "account", id: "a1" }, expires: 9e9 };
  st.setKv("muteUntil", 123.5);
  st.setKv("mainCommit", "abc1234");
  assert.equal(await st.flush(), true);
  let back = await Store.open(db);
  assert.equal(back.servers["web-1"].payload.cpu.percent, 12.5);
  assert.equal(back.servers.__proto__.name, "odd");
  assert.equal(back.data.accounts.a1.username, "alice");
  assert.equal(back.getKv("muteUntil"), 123.5);
  assert.equal(back.getKv("mainCommit"), "abc1234");

  delete st.servers.__proto__;
  st.setKv("muteUntil", null);
  st.servers["web-1"].name = "Web One";
  assert.equal(await st.flush(), true);
  back = await Store.open(db);
  assert.deepEqual(Object.keys(back.servers), ["web-1"]);
  assert.equal(back.servers["web-1"].name, "Web One");
  assert.equal(back.getKv("muteUntil"), null);
  clearTimeout(st.timer);
});

test("notification log: written, loaded after a restart, old ones deleted", { skip }, async () => {
  await wipe();
  let log = new EventLog(db, 30);
  await log.load();
  log.add({ kind: "down", text: "🔴 <b>web-1</b> is DOWN", server: { id: "web-1", name: "web-1" }, important: true });
  log.add({ kind: "audit", text: "alice rebooted web-1", server: { id: "web-1", name: "web-1" }, actor: "alice" });
  await log.stop();
  await db.insertEvents([{ id: 999, ts: Date.now() / 1000 - 40 * 86400, kind: "down", text: "ancient" }]);
  log = new EventLog(db, 30);
  await log.load();
  assert.deepEqual(log.events.map((e) => e.text), ["🔴 web-1 is DOWN", "alice rebooted web-1"]);
  assert.equal(log.events[0].important, true);
  assert.equal(log.events[1].actor, "alice");
  assert.equal(log.nextId, 1000); // after the highest id ever used
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM wd_events WHERE text = 'ancient'");
  assert.equal(rows[0].n, 0);
});

test("first start: data of the file-based version is imported once", { skip }, async () => {
  await wipe();
  const dataFile = tmpFile("watchdog.json");
  const eventsFile = path.join(path.dirname(dataFile), "events.jsonl");
  fs.writeFileSync(dataFile, JSON.stringify({
    servers: { "db-1": { id: "db-1", name: "db-1", tokenHash: "x" } },
    kv: { mainCommit: "def5678" },
    accounts: { b1: { id: "b1", username: "bob" } },
    sessions: {},
  }));
  fs.writeFileSync(eventsFile, `${JSON.stringify({ id: 7, ts: Date.now() / 1000, kind: "online", server: "db-1", text: "back" })}\nhalf-writ`);
  const msg = await importLegacyFiles(db, dataFile, eventsFile);
  assert.match(msg, /1 server\(s\), 1 account\(s\), 0 session\(s\), 1 setting\(s\), 1 notification\(s\)/);
  assert.ok(!fs.existsSync(dataFile) && !fs.existsSync(eventsFile)); // renamed …imported-…
  assert.ok(fs.readdirSync(path.dirname(dataFile)).some((f) => f.startsWith("watchdog.json.imported-")));
  const st = await Store.open(db);
  assert.equal(st.servers["db-1"].name, "db-1");
  assert.equal(st.getKv("mainCommit"), "def5678");
  assert.equal(await importLegacyFiles(db, dataFile, eventsFile), null); // nothing left to import

  // the database has data now: a file that shows up again is left alone
  fs.writeFileSync(dataFile, "{}");
  assert.match(await importLegacyFiles(db, dataFile, eventsFile), /not imported/);
  assert.ok(fs.existsSync(dataFile));
});

test("a wrong DATABASE_URL fails with a clear message (password hidden)", { skip }, async () => {
  const bad = new PgBackend(URL.replace(/\/[^/?]+(\?|$)/, "/watchdog_no_such_db$1"));
  await assert.rejects(bad.init({ tries: 1 }), (e) => /can't use PostgreSQL at postgres:\/\/[^:]+:\*\*\*@.*watchdog_no_such_db.*does not exist/.test(e.message));
  await bad.close();
});
