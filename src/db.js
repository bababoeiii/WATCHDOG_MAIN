// PostgreSQL storage (DATABASE_URL). Servers, portal accounts, sessions and settings are rows with a
// JSON document each; the notification log is a table of its own. Tables are created on start.
//
// MemoryBackend has the same methods and keeps everything in memory (tests).
import fs from "node:fs";
import pg from "pg";

export const TABLES = ["servers", "accounts", "sessions", "kv"]; // one row per key, data = JSON

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wd_servers  (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wd_accounts (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wd_sessions (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wd_kv       (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wd_events (
  id        bigint PRIMARY KEY,
  ts        double precision NOT NULL,
  kind      text NOT NULL,
  server    text,
  name      text,
  important boolean NOT NULL DEFAULT false,
  muted     boolean NOT NULL DEFAULT false,
  actor     text,
  text      text NOT NULL
);
CREATE INDEX IF NOT EXISTS wd_events_ts ON wd_events (ts);
CREATE INDEX IF NOT EXISTS wd_events_server ON wd_events (server, id);
`;
const EVENT_COLS = ["id", "ts", "kind", "server", "name", "important", "muted", "actor", "text"];
const rowToEvent = (r) => {
  const e = { id: Number(r.id), ts: r.ts, kind: r.kind, server: r.server, name: r.name, important: r.important, muted: r.muted, text: r.text };
  if (r.actor) e.actor = r.actor;
  return e;
};

/** Hide the password when a connection string shows up in a message. */
export const safeUrl = (url) => String(url || "").replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");

export class PgBackend {
  constructor(url) {
    this.url = url;
    this.pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (e) => console.error(`PostgreSQL: ${e.message}`)); // idle client lost; the pool reconnects
  }

  /** Connect and create the tables. Retries a few times (the database may still be starting). */
  async init({ tries = 5, delayMs = 3000 } = {}) {
    for (let i = 1; ; i++) {
      try {
        await this.pool.query(SCHEMA);
        return;
      } catch (e) {
        if (i >= tries) throw new Error(`can't use PostgreSQL at ${safeUrl(this.url)}: ${e.message}`);
        console.warn(`PostgreSQL not reachable (${e.message}), retrying in ${delayMs / 1000}s …`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  /** @returns {{ servers: {}, accounts: {}, sessions: {}, kv: {} }} */
  async loadAll() {
    const out = {};
    for (const t of TABLES) {
      const { rows } = await this.pool.query(`SELECT id, data FROM wd_${t}`);
      out[t] = Object.fromEntries(rows.map((r) => [r.id, r.data]));
    }
    return out;
  }

  async isEmpty() {
    const { rows } = await this.pool.query(
      `SELECT (SELECT count(*) FROM wd_servers) + (SELECT count(*) FROM wd_accounts) + (SELECT count(*) FROM wd_kv) + (SELECT count(*) FROM wd_events) AS n`,
    );
    return Number(rows[0].n) === 0;
  }

  /**
   * One transaction: for each table, rows to write ({ id: jsonString }) and ids to delete.
   * @param {Record<string, { upsert: [string, string][], remove: string[] }>} changes
   */
  async write(changes) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [t, { upsert, remove }] of Object.entries(changes)) {
        if (!TABLES.includes(t)) throw new Error(`unknown table ${t}`);
        if (upsert.length) {
          await client.query(
            `INSERT INTO wd_${t} (id, data, updated_at)
             SELECT id, data::jsonb, now() FROM unnest($1::text[], $2::text[]) AS x(id, data)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [upsert.map((u) => u[0]), upsert.map((u) => u[1])],
          );
        }
        if (remove.length) await client.query(`DELETE FROM wd_${t} WHERE id = ANY($1::text[])`, [remove]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- notification log
  async loadEvents(sinceTs, limit) {
    const { rows } = await this.pool.query(`SELECT * FROM wd_events WHERE ts >= $1 ORDER BY id DESC LIMIT $2`, [sinceTs, limit]);
    return rows.reverse().map(rowToEvent);
  }
  async maxEventId() {
    const { rows } = await this.pool.query("SELECT coalesce(max(id), 0) AS m FROM wd_events");
    return Number(rows[0].m);
  }
  async insertEvents(list) {
    if (!list.length) return;
    const cols = EVENT_COLS.map((c) => list.map((e) => e[c] ?? (c === "important" || c === "muted" ? false : null)));
    await this.pool.query(
      `INSERT INTO wd_events (${EVENT_COLS.join(", ")})
       SELECT * FROM unnest($1::bigint[], $2::float8[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::bool[], $8::text[], $9::text[])
       ON CONFLICT (id) DO NOTHING`,
      cols,
    );
  }
  async pruneEvents(beforeTs) {
    await this.pool.query("DELETE FROM wd_events WHERE ts < $1", [beforeTs]);
  }

  async close() {
    await this.pool.end();
  }
}

/** Same interface, nothing leaves memory. For tests. */
export class MemoryBackend {
  constructor() {
    this.tables = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
    this.events = [];
  }
  async init() {}
  async ping() {}
  async loadAll() {
    return Object.fromEntries(TABLES.map((t) => [t, Object.fromEntries([...this.tables[t]].map(([k, v]) => [k, JSON.parse(v)]))]));
  }
  async isEmpty() {
    return !this.events.length && TABLES.every((t) => t === "sessions" || !this.tables[t].size);
  }
  async write(changes) {
    if (this.fail) throw new Error(this.fail);
    for (const [t, { upsert, remove }] of Object.entries(changes)) {
      for (const [id, json] of upsert) this.tables[t].set(id, json);
      for (const id of remove) this.tables[t].delete(id);
    }
  }
  async loadEvents(sinceTs, limit) {
    return this.events.filter((e) => e.ts >= sinceTs).slice(-limit).map((e) => ({ ...e }));
  }
  async maxEventId() {
    return this.events.reduce((m, e) => Math.max(m, e.id), 0);
  }
  async insertEvents(list) {
    for (const e of list) if (!this.events.some((x) => x.id === e.id)) this.events.push({ ...e });
  }
  async pruneEvents(beforeTs) {
    this.events = this.events.filter((e) => e.ts >= beforeTs);
  }
  async close() {}
}

/**
 * First start on an empty database: bring over what the file-based versions stored
 * (data/watchdog.json and data/events.jsonl), then rename those files so it happens once.
 * @returns a summary line, or null when there was nothing to import
 */
export async function importLegacyFiles(backend, dataFile, eventsFile) {
  const hasData = fs.existsSync(dataFile);
  const hasEvents = fs.existsSync(eventsFile);
  if (!hasData && !hasEvents) return null;
  if (!(await backend.isEmpty())) {
    return `${hasData ? dataFile : eventsFile} still exists, but the database already has data: not imported (delete or rename the file)`;
  }
  let counts = { servers: 0, accounts: 0, sessions: 0, kv: 0, events: 0 };
  if (hasData) {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const changes = {};
    for (const t of TABLES) {
      const entries = Object.entries(parsed[t] && typeof parsed[t] === "object" ? parsed[t] : {});
      changes[t] = { upsert: entries.map(([k, v]) => [k, JSON.stringify(v)]), remove: [] };
      counts[t] = entries.length;
    }
    await backend.write(changes);
  }
  if (hasEvents) {
    const list = [];
    for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
      try {
        const e = line.trim() && JSON.parse(line);
        if (e && typeof e.id === "number" && typeof e.ts === "number") list.push(e);
      } catch {
        /* half-written line */
      }
    }
    for (let i = 0; i < list.length; i += 1000) await backend.insertEvents(list.slice(i, i + 1000));
    counts.events = list.length;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  for (const f of [dataFile, eventsFile]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.imported-${stamp}`);
  return `Imported into PostgreSQL: ${counts.servers} server(s), ${counts.accounts} account(s), ${counts.sessions} session(s), ${counts.kv} setting(s), ${counts.events} notification(s) (the old files were renamed *.imported-${stamp})`;
}
