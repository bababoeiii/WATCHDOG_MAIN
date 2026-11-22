// Event log for the web portal: every notification (also while muted) plus who-did-what entries.
// Stored in PostgreSQL (wd_events); the last NOTIFY_HISTORY_DAYS are also kept in memory for fast
// filtering per viewer. Older entries are deleted.
const MAX_EVENTS = 50_000; // safety cap, whatever the retention
const TEXT_LIMIT = 2000;

/** Telegram HTML → plain text (the portal escapes it again when showing it). */
export function plain(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .slice(0, TEXT_LIMIT);
}

/** Kinds of events, for the portal's filter. "audit" (who did what) is only shown to owners. */
export const KINDS = {
  down: "Down", offline: "Stopped / shut down", online: "Back online", connected: "First connection",
  reboot: "Rebooted", reboot_request: "Reboot requested", alert: "Alert", resolved: "Alert resolved", update: "Updated", update_failed: "Update failed",
  main: "Main server", report: "Health report", audit: "Activity",
};

export class EventLog {
  /**
   * @param backend        PgBackend / MemoryBackend (db.js)
   * @param retentionDays  NOTIFY_HISTORY_DAYS
   */
  constructor(backend, retentionDays = 30) {
    this.backend = backend;
    this.retentionDays = retentionDays;
    this.events = []; // oldest first
    this.nextId = 1;
    this.listeners = new Set();
    this.pending = []; // not yet written (database unreachable)
  }

  cutoff() {
    return Date.now() / 1000 - this.retentionDays * 86400;
  }

  /** Load the recent history from the database (call once at start). */
  async load() {
    this.nextId = (await this.backend.maxEventId()) + 1; // before pruning: ids never go back
    await this.backend.pruneEvents(this.cutoff());
    this.events = await this.backend.loadEvents(this.cutoff(), MAX_EVENTS);
  }

  /** Drop entries older than the retention, in memory and in the database. */
  async prune() {
    const cut = this.cutoff();
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cut) drop++;
    if (this.events.length - drop > MAX_EVENTS) drop = this.events.length - MAX_EVENTS;
    if (drop) this.events.splice(0, drop);
    try {
      await this.backend.pruneEvents(cut);
    } catch (e) {
      console.error(`Could not prune old notifications: ${e.message}`);
    }
  }

  /** Write what's waiting; on failure it stays queued and goes out with the next event or prune. */
  async persist() {
    if (this.persisting || !this.pending.length) return;
    this.persisting = true;
    const batch = this.pending.splice(0);
    try {
      await this.backend.insertEvents(batch);
    } catch (e) {
      this.pending.unshift(...batch.slice(-5000)); // keep the newest if the database stays away
      console.error(`Could not save notifications to the database: ${e.message}`);
    } finally {
      this.persisting = false;
    }
  }

  /**
   * @param {object} e
   * @param {string} e.kind       one of KINDS
   * @param {string} e.text       Telegram HTML or plain text
   * @param {object} [e.server]   the server it is about (null: about the main server / all of them)
   * @param {boolean} [e.important]
   * @param {boolean} [e.muted]   notifications were muted, so it didn't go to Telegram
   * @param {string} [e.actor]    who did it (audit entries)
   */
  add({ kind, text, server = null, important = false, muted = false, actor = null }) {
    const e = {
      id: this.nextId++,
      ts: Math.round((Date.now() / 1000) * 10) / 10,
      kind: KINDS[kind] ? kind : "main",
      server: server?.id ?? null,
      name: server?.name ?? null,
      important: Boolean(important),
      muted: Boolean(muted),
      text: plain(text),
      ...(actor ? { actor: String(actor).slice(0, 80) } : {}),
    };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.pending.push(e);
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("event listener failed:", err);
      }
    }
    return e;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Newest first. `visible(e)` decides what this viewer may see.
   * @param {{ before?: number, limit?: number, server?: string, kind?: string, visible: (e) => boolean }} q
   */
  query({ before = Infinity, limit = 100, server = "", kind = "", visible }) {
    const out = [];
    const max = Math.max(1, Math.min(500, Number(limit) || 100));
    for (let i = this.events.length - 1; i >= 0 && out.length < max; i--) {
      const e = this.events[i];
      if (e.id >= before) continue;
      if (server && e.server !== server) continue;
      if (kind && e.kind !== kind) continue;
      if (!visible(e)) continue;
      out.push(e);
    }
    return out;
  }

  start() {
    this.timer = setInterval(() => {
      this.prune();
      this.persist();
    }, 3600_000);
    this.timer.unref?.();
  }

  /** Stop the timer and write what's still waiting. */
  async stop() {
    clearInterval(this.timer);
    while (this.persisting) await new Promise((r) => setTimeout(r, 20));
    await this.persist();
  }
}
