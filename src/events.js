// Event log for the web portal: every notification (also while muted) plus who-did-what entries.
// Kept in memory and appended to data/events.jsonl; entries older than the retention are dropped.
import fs from "node:fs";

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
   * @param file           path of the .jsonl file
   * @param retentionDays  NOTIFY_HISTORY_DAYS
   */
  constructor(file, retentionDays = 30) {
    this.file = file;
    this.retentionDays = retentionDays;
    this.events = []; // oldest first
    this.nextId = 1;
    this.listeners = new Set();
    this.load();
  }

  cutoff() {
    return Date.now() / 1000 - this.retentionDays * 86400;
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const keep = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.id === "number" && typeof e.ts === "number") keep.push(e);
      } catch {
        /* a half-written last line after a crash: skip it */
      }
    }
    this.events = keep;
    this.nextId = keep.length ? keep[keep.length - 1].id + 1 : 1;
    this.prune(true);
  }

  /** Drop old entries; rewrite the file when anything was dropped (or `force`). */
  prune(force = false) {
    const cut = this.cutoff();
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cut) drop++;
    if (this.events.length - drop > MAX_EVENTS) drop = this.events.length - MAX_EVENTS;
    if (drop) this.events.splice(0, drop);
    if (!drop && !force) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : ""), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`Could not rewrite ${this.file}: ${e.message}`);
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
    try {
      fs.appendFileSync(this.file, JSON.stringify(e) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`Could not write ${this.file}: ${err.message}`);
    }
    if (this.events.length > MAX_EVENTS) this.prune();
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
    this.timer = setInterval(() => this.prune(), 3600_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
