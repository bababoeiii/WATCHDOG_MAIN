#!/usr/bin/env node
// For `watchdog-main health`: the sub servers as the database has them (and whether it answers).
import { readConfig } from "../src/config.js";
import { PgBackend } from "../src/db.js";

const { cfg } = readConfig();
const db = new PgBackend(cfg.databaseUrl);
try {
  const { rows } = await db.pool.query("SELECT data FROM wd_servers");
  const list = rows.map((r) => r.data).sort((a, b) => a.name.localeCompare(b.name));
  const n = (st) => list.filter((s) => s.status === st).length;
  if (!list.length) console.log("  none yet (/add <name> in Telegram, or Servers on the website)");
  else {
    console.log(`${n("offline") ? "⚠" : "✔"} 🟢 ${n("online")} online · 🔴 ${n("offline")} offline · ⚪ ${n("pending")} never connected`);
    const when = (t) => (t ? new Date(t * 1000).toLocaleString("sv-SE").slice(0, 16) : "?");
    const reason = { timeout: "no reports", shutdown: "shut down", agent_stopped: "agent stopped" };
    for (const s of list.filter((s) => s.status === "offline")) console.log(`   🔴 ${s.name} — since ${when(s.statusSince)} (${reason[s.offlineReason] || "offline"})`);
  }
} catch (e) {
  console.log(`✖ can't read the database: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
