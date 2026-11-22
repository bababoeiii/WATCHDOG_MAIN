// In-memory state (servers with hashed tokens, portal accounts + sessions, a few settings), saved
// to PostgreSQL (see db.js). The rest of the app reads and changes the objects directly and calls
// save(); a save writes only the records that changed since the last one, in one transaction.
import { MemoryBackend, TABLES } from "./db.js";

// Objects without a prototype, so ids like "__proto__" or "constructor" are plain keys.
const dict = (src) => Object.assign(Object.create(null), src && typeof src === "object" ? src : {});

export class Store {
  /** @param backend PgBackend, or MemoryBackend (default, tests) */
  constructor(backend = new MemoryBackend()) {
    this.backend = backend;
    this.data = Object.fromEntries(TABLES.map((t) => [t, dict()]));
    this.saved = Object.fromEntries(TABLES.map((t) => [t, new Map()])); // id -> JSON as last written
    this.timer = null;
    this.dueAt = 0;
    this.writing = null;
    this.dbOk = true;
    this.lastError = null;
  }

  /** Create a store and load what the database has. */
  static async open(backend) {
    const st = new Store(backend);
    const all = await backend.loadAll();
    for (const t of TABLES) {
      st.data[t] = dict(all[t]);
      for (const [k, v] of Object.entries(all[t] || {})) st.saved[t].set(k, JSON.stringify(v));
    }
    return st;
  }

  get servers() {
    return this.data.servers;
  }

  getKv(key, def = null) {
    return Object.hasOwn(this.data.kv, key) ? this.data.kv[key] : def;
  }

  setKv(key, value) {
    if (value === null || value === undefined) delete this.data.kv[key];
    else this.data.kv[key] = value;
    this.save();
  }

  /**
   * Schedule a write. Important changes use the default 1 s; routine metric updates pass a longer
   * delay so the database isn't written on every report. An earlier deadline always wins.
   */
  save(delayMs = 1000) {
    const due = Date.now() + delayMs;
    if (this.timer && this.dueAt <= due) return;
    clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  /** What changed since the last write: { table: { upsert: [[id, json]], remove: [id] } } */
  diff() {
    const changes = {};
    let any = false;
    for (const t of TABLES) {
      const upsert = [];
      const remove = [];
      const seen = new Set();
      for (const [id, value] of Object.entries(this.data[t])) {
        seen.add(id);
        const json = JSON.stringify(value);
        if (this.saved[t].get(id) !== json) upsert.push([id, json]);
      }
      for (const id of this.saved[t].keys()) if (!seen.has(id)) remove.push(id);
      if (upsert.length || remove.length) {
        changes[t] = { upsert, remove };
        any = true;
      }
    }
    return any ? changes : null;
  }

  /**
   * Write the changes now. Never throws: if the database is unreachable the app keeps running on
   * the in-memory state, logs it, and tries again in 30 s. @returns {Promise<boolean>} written
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.writing) await this.writing; // one write at a time, in order
    const changes = this.diff();
    if (!changes) return true;
    this.writing = (async () => {
      try {
        await this.backend.write(changes);
        for (const [t, { upsert, remove }] of Object.entries(changes)) {
          for (const [id, json] of upsert) this.saved[t].set(id, json);
          for (const id of remove) this.saved[t].delete(id);
        }
        if (!this.dbOk) console.log("Database writes work again");
        this.dbOk = true;
        this.lastError = null;
        return true;
      } catch (e) {
        if (this.dbOk || this.lastError !== e.message) console.error(`Could not save to the database: ${e.message}`);
        this.dbOk = false;
        this.lastError = e.message;
        this.save(30_000);
        return false;
      }
    })();
    try {
      return await this.writing;
    } finally {
      this.writing = null;
    }
  }
}
