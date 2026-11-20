// Telegram bot: status, alerts, token management for sub servers, dashboard launcher.
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { esc, fmtClock, fmtDateTime, fmtDuration, splitMessage, TELEGRAM_LIMIT } from "./format.js";
import { RUN_TIMEOUT_MS } from "./monitor.js";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
/** Labels of the button bar under the message box (a tap sends exactly this text). */
export const MENU = {
  status: "📊 Status", alerts: "⚠️ Alerts", servers: "🖥 Servers", version: "🏷 Version",
  dashboard: "📈 Dashboard", mute: "🔕 Mute 1h", unmute: "🔔 Unmute", updateAll: "⬆️ Update all",
};
/** Bump when the bar changes, so admins get the new one once after an update (sendMenu). */
export const MENU_VERSION = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const COMMANDS = [
  { command: "status", description: "Status of all servers" },
  { command: "alerts", description: "Servers down + active alerts" },
  { command: "servers", description: "List servers and their tokens" },
  { command: "add", description: "Add a sub server: /add web-1" },
  { command: "token", description: "New token for a server: /token web-1" },
  { command: "remove", description: "Remove a server: /remove web-1" },
  { command: "version", description: "Versions of main + sub servers" },
  { command: "update", description: "Update from GitHub: /update all | subs | main | <name>" },
  { command: "dashboard", description: "Open the live dashboard" },
  { command: "mute", description: "Mute notifications: /mute 60" },
  { command: "unmute", description: "Turn notifications back on" },
  { command: "help", description: "Help" },
];

const HELP =
  "🐕 <b>Watchdog</b> — main server\n\n" +
  "<b>Servers</b>\n" +
  "/add &lt;name&gt; — create a sub server and get its token\n" +
  "/token &lt;name&gt; — replace a server's token (the old one stops working)\n" +
  "/remove &lt;name&gt; — remove a server and revoke its token\n" +
  "/servers — list servers\n\n" +
  "<b>Monitoring</b>\n" +
  "/status — CPU, RAM, disk, temperature of every server\n" +
  "/alerts — servers down + active alerts\n" +
  "/dashboard — live charts\n" +
  "/mute 60 · /unmute — silence notifications\n\n" +
  "<b>Updates</b> (from your GitHub repo)\n" +
  "/version — which version each server runs\n" +
  "/update all — both sides: sub servers, then the main server, one summary\n" +
  "/update subs — all sub servers only, one summary\n" +
  "/update main · /update &lt;name&gt; — just the main server / one sub server\n" +
  "(/version has buttons for all of these, plus one per sub server that is behind)\n\n" +
  "To connect a server: /add it here, then put the two lines you get into the <code>.env</code> " +
  "of the sub-server project on that machine and start it.";

export function createBot(cfg, monitor, notifier, botOptions = {}, updateMain = null) {
  const bot = new Bot(cfg.botToken, botOptions);
  const isPrivate = (ctx) => ctx.chat?.type === "private";

  /**
   * The button bar under the message box (Telegram "reply keyboard"), always shown in private chats.
   * Not in groups: everyone there would see it, and the bot ignores non-admins anyway.
   * The 🔕/🔔 button shows the current mute state as of the last message that carried the bar.
   */
  const menuKeyboard = () => {
    const kb = new Keyboard().text(MENU.status).text(MENU.alerts).row().text(MENU.servers).text(MENU.version).row();
    if (cfg.webappUrl) kb.webApp(MENU.dashboard, cfg.webappUrl);
    else kb.text(MENU.dashboard);
    return kb.text(notifier.isMuted() ? MENU.unmute : MENU.mute).row().text(MENU.updateAll).persistent().resized();
  };
  const withMenu = (ctx) => (isPrivate(ctx) ? { reply_markup: menuKeyboard() } : {});

  const statusKeyboard = (ctx) => {
    const kb = new InlineKeyboard().text("🔄 Refresh", "refresh");
    if (cfg.webappUrl && isPrivate(ctx)) kb.webApp("📈 Dashboard", cfg.webappUrl);
    return kb;
  };

  const tokenMessage = (s, token, headline) => {
    const install = monitor.installCommand(token);
    return (
      `${headline}\n\nPut this in the <code>.env</code> of the sub server:\n` +
      `<pre>${esc(monitor.envSnippet(token))}</pre>\n` +
      (install
        ? `Or install it in one go on the sub server (Linux + systemd, auto-updates from GitHub):\n<pre>${esc(install)}</pre>\n`
        : `Then start it (<code>sudo bash install.sh</code> or <code>npm start</code>).\n\n`) +
      `🔐 The token is shown only this once. Lost it? /token ${esc(s.id)}`
    );
  };

  /** Reply with a message of any length; the keyboard goes on the last part. */
  const replyLong = async (ctx, text, extra = {}) => {
    const parts = splitMessage(text);
    const { reply_markup, ...rest } = extra;
    for (let i = 0; i < parts.length; i++) {
      await ctx.reply(parts[i], { ...HTML, ...rest, ...(i === parts.length - 1 && reply_markup ? { reply_markup } : {}) });
    }
  };

  const unknown = (ctx, q) => {
    const names = monitor.list().map((s) => esc(s.name)).join(", ") || "none yet";
    return ctx.reply(`No server called <b>${esc(q)}</b>.\nServers: ${names}`, HTML);
  };

  // ---- access control: only ADMIN_IDS may use the bot
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid && cfg.adminIds.includes(uid)) return next();
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: "Not allowed" });
    if (isPrivate(ctx) && ctx.message?.text?.startsWith("/start")) {
      return ctx.reply(
        `⛔ You are not allowed to use this bot.\nYour Telegram ID is <code>${uid}</code> — ` +
          "add it to <code>ADMIN_IDS</code> on the main server if this is your bot.",
        HTML,
      );
    }
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { ...HTML, reply_markup: isPrivate(ctx) ? menuKeyboard() : statusKeyboard(ctx) }));

  const showStatus = (ctx) => replyLong(ctx, monitor.statusText(), { reply_markup: statusKeyboard(ctx) });
  bot.command("status", showStatus);

  bot.callbackQuery("refresh", async (ctx) => {
    const text = monitor.statusText();
    if (text.length > TELEGRAM_LIMIT - 96) {
      await ctx.answerCallbackQuery({ text: "Sending a fresh status…" }); // too long to edit in place
      return replyLong(ctx, text, { reply_markup: statusKeyboard(ctx) });
    }
    try {
      await ctx.editMessageText(text, { ...HTML, reply_markup: statusKeyboard(ctx) });
    } catch {
      /* message is not modified */
    }
    await ctx.answerCallbackQuery({ text: "Updated" });
  });

  const showAlerts = (ctx) => {
    const offline = monitor.list().filter((s) => s.status === "offline");
    const alerts = monitor.activeAlerts();
    if (!offline.length && !alerts.length) return ctx.reply("✅ All clear — no servers down, no active alerts.");
    const now = Date.now() / 1000;
    const lines = ["⚠️ <b>Active problems</b>", ""];
    for (const s of offline) lines.push(`🔴 <b>${esc(s.name)}</b> offline since ${fmtClock(s.statusSince)}`);
    for (const [s, a] of alerts) {
      const where = a.detail ? ` on ${esc(a.detail)}` : "";
      lines.push(`⚠️ <b>${esc(s.name)}</b>: ${a.label}${where} — ${Math.round(a.value)}${a.unit} (for ${fmtDuration(now - a.since)})`);
    }
    return replyLong(ctx, lines.join("\n"));
  };
  bot.command("alerts", showAlerts);

  const showServers = (ctx) => {
    const list = monitor.list();
    if (!list.length) return ctx.reply("No servers yet. Add one with /add &lt;name&gt;", HTML);
    const icon = { online: "🟢", offline: "🔴", pending: "⚪" };
    const lines = ["🖥 <b>Servers</b>", ""];
    for (const s of list) {
      const state = s.status === "pending" ? "never connected" : s.status === "online" ? "online" : `offline since ${fmtClock(s.statusSince)}`;
      lines.push(`${icon[s.status]} <b>${esc(s.name)}</b> <code>${esc(s.id)}</code> — ${state}`);
      lines.push(`    token created ${fmtDateTime(s.tokenCreatedAt)}`);
    }
    return replyLong(ctx, lines.join("\n"));
  };
  bot.command("servers", showServers);

  bot.command("add", async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply("For safety, tokens are only sent in a private chat with the bot.");
    const name = ctx.match?.trim();
    if (!name) return ctx.reply("Usage: /add &lt;name&gt;\nExample: /add web-1", HTML);
    try {
      const { server, token } = monitor.addServer(name);
      return ctx.reply(tokenMessage(server, token, `✅ Server <b>${esc(server.name)}</b> added.`), HTML);
    } catch (e) {
      return ctx.reply(`❌ ${esc(e.message)}`, HTML);
    }
  });

  bot.command("token", (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply("For safety, tokens are only sent in a private chat with the bot.");
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /token &lt;name&gt;", HTML);
    const s = monitor.find(q);
    if (!s) return unknown(ctx, q);
    return ctx.reply(
      `Make a new token for <b>${esc(s.name)}</b>?\nThe current token stops working immediately, so update the sub server's .env right after.`,
      { ...HTML, reply_markup: new InlineKeyboard().text("🔑 New token", `tok:${s.id}`).text("Cancel", "cancel") },
    );
  });

  bot.callbackQuery(/^tok:(.+)$/, async (ctx) => {
    const s = monitor.get(ctx.match[1]);
    if (!s) return ctx.answerCallbackQuery({ text: "Server no longer exists" });
    const token = monitor.rotateToken(s.id);
    await ctx.editMessageText(tokenMessage(s, token, `🔑 New token for <b>${esc(s.name)}</b>. The old one is revoked.`), HTML);
    return ctx.answerCallbackQuery();
  });

  bot.command("remove", (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /remove &lt;name&gt;", HTML);
    const s = monitor.find(q);
    if (!s) return unknown(ctx, q);
    return ctx.reply(`Remove <b>${esc(s.name)}</b>? Its token is revoked and it stops being monitored.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text("🗑 Remove", `rm:${s.id}`).text("Cancel", "cancel"),
    });
  });

  bot.callbackQuery(/^rm:(.+)$/, async (ctx) => {
    const s = monitor.get(ctx.match[1]);
    if (!s || !monitor.removeServer(s.id)) return ctx.answerCallbackQuery({ text: "Already removed" });
    await ctx.editMessageText(`🗑 Removed <b>${esc(s.name)}</b>. Its token no longer works.`, HTML);
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.editMessageText("Cancelled.");
    return ctx.answerCallbackQuery();
  });

  // ---- versions & updates
  // The main server and the sub servers live in two repos (WATCHDOG_MAIN / WATCHDOG_SUB):
  // each side is compared with the latest commit of its own repo.
  const repoName = (url) => (/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url || "")) || [])[1] || String(url || "");
  const subMark = (s) => {
    const st = monitor.subVersionState(s);
    if (st === "behind") return ` ⬆️ behind (latest <code>${esc(monitor.subLatest(s))}</code>)`;
    return st === "current" ? " ✅" : st === "restart" ? " ⏳ restart pending" : "";
  };
  const mainMark = (mv) =>
    !mv.latest ? "" : mv.commit === mv.latest ? " ✅" : mv.pending_restart ? " ⏳ restart pending" : ` ⬆️ behind (latest <code>${mv.latest}</code>)`;
  const subServers = () => monitor.list().filter((s) => s.status !== "pending");

  const versionText = async () => {
    await monitor.refreshVersions();
    const mv = monitor.updater?.info();
    const lines = ["🏷 <b>Versions</b>", ""];
    if (mv?.enabled) {
      lines.push(`<b>Main server</b>: <code>${mv.commit}</code> on ${esc(mv.branch)}${mainMark(mv)}`);
      lines.push(`    ${esc(repoName(mv.remote))} · auto-update ${mv.auto ? "on" : "off"}`);
      if (mv.error) lines.push(`    ❗ ${esc(mv.error)}`);
    } else {
      lines.push(`<b>Main server</b>: auto-update off (${esc(mv?.reason || "not a git install")})`);
    }
    lines.push("", `<b>Sub servers</b>${cfg.subRepo ? ` · ${esc(repoName(cfg.subRepo))}` : ""}`);
    if (!cfg.subRepo) lines.push("    <i>SUB_REPO not set: \"behind\" uses each server's own last check</i>");
    else if (monitor.subHeads?.error) lines.push(`    ❗ can't read SUB_REPO: ${esc(monitor.subHeads.error)}`);
    for (const s of monitor.list()) {
      const v = s.version;
      let state;
      if (s.status === "pending") state = "never connected";
      else if (!v?.commit) state = `no version info${v?.reason ? ` (${esc(v.reason)})` : ""}`;
      else state = `<code>${esc(v.commit)}</code>${subMark(s)}${v.auto === false ? " · manual updates" : ""}`;
      lines.push(`${s.status === "online" ? "🟢" : s.status === "pending" ? "⚪" : "🔴"} <b>${esc(s.name)}</b>: ${state}${s.pendingUpdate ? " · update requested" : ""}`);
      if (v?.error) lines.push(`    ❗ ${esc(v.error)}`);
    }
    if (!monitor.list().length) lines.push("    none yet — /add &lt;name&gt;");
    return lines.join("\n");
  };
  /** /version buttons: refresh, both sides, only the sub servers, and one per sub server that is behind. */
  const versionKeyboard = () => {
    const kb = new InlineKeyboard().text("🔄 Refresh", "ver:refresh").row().text("⬆️ Update all", "upd:all").text("⬆️ Update subs", "upd:subs");
    const behind = monitor.list().filter((s) => s.version?.enabled && monitor.subVersionState(s) === "behind").slice(0, 20);
    behind.forEach((s, i) => {
      if (i % 2 === 0) kb.row();
      kb.text(`⬆️ ${s.name}`, `upd:s:${s.id}`);
    });
    return kb;
  };

  /** What "update all" (withMain) or "update subs" would do, shown before it runs. */
  const planText = async (withMain) => {
    await monitor.refreshVersions();
    const lines = withMain
      ? ["⬆️ <b>Update everything?</b>", "", "Sub servers first, then the main server (it restarts last).", ""]
      : ["⬆️ <b>Update all sub servers?</b>", "", "The main server is left as it is.", ""];
    const subs = subServers();
    for (const s of subs) {
      const v = s.version;
      let what;
      if (s.status !== "online") what = "offline — updates when it's back";
      else if (!v?.enabled) what = `auto-update unavailable${v?.reason ? ` (${esc(v.reason)})` : ""}`;
      else {
        const st = monitor.subVersionState(s);
        what = st === "behind" ? `<code>${esc(v.commit)}</code> → <code>${esc(monitor.subLatest(s))}</code>` : st === "current" ? "up to date" : "will check GitHub";
      }
      lines.push(`• <b>${esc(s.name)}</b>: ${what}`);
    }
    if (!subs.length) lines.push("• no connected sub servers");
    if (withMain) {
      const mv = monitor.updater?.info();
      const main = !mv?.enabled
        ? `auto-update off (${esc(mv?.reason || "not a git install")})`
        : mv.latest && mv.commit !== mv.latest ? `<code>${mv.commit}</code> → <code>${mv.latest}</code>` : mv.latest ? "up to date" : "will check GitHub";
      lines.push(`• <b>Main server</b>: ${main}`);
    }
    return lines.join("\n");
  };

  /** "⬆️ Update all" from the button bar: show the plan, run after ✅ (same buttons as under /version). */
  const askUpdateAll = async (ctx) => {
    ctx.replyWithChatAction("typing").catch(() => {});
    return replyLong(ctx, await planText(true), { reply_markup: new InlineKeyboard().text("✅ Update now", "upd:all:go").text("Cancel", "cancel") });
  };

  /** Update the main server; with deferRestart the caller restarts it later via result.restartNow(). */
  const mainUpdate = async ({ deferRestart = false } = {}) => {
    if (!updateMain) return { text: "Main server: updates not available" };
    try {
      const r = await updateMain("telegram", { deferRestart });
      if (r.status === "up-to-date") return { text: `Main server: already up to date (<code>${r.version.commit}</code>)` };
      if (r.status === "busy") return { text: "Main server: an update is already running" };
      if (r.status === "updated") return { text: `Main server: pulled <code>${r.from}</code> → <code>${r.to}</code> (no main-server changes, no restart)` };
      return {
        text: r.restarting ? `Main server: updating <code>${r.from}</code> → <code>${r.to}</code>, restarting…` : `Main server: updated to <code>${r.to}</code>, restart it to apply`,
        restartNow: r.restartNow,
      };
    } catch (e) {
      return { text: `Main server: ❗ ${esc(e.message)}` };
    }
  };

  const RESULT = {
    updated: (it) => `✅ <b>${esc(it.name)}</b>: <code>${esc(it.from)}</code> → <code>${esc(it.to)}</code>`,
    current: (it) => `➖ <b>${esc(it.name)}</b>: already up to date (<code>${esc(it.to)}</code>)`,
    failed: (it) => `❗ <b>${esc(it.name)}</b>: failed, rolled back — ${esc(it.note)}`,
    offline: (it) => `🔴 <b>${esc(it.name)}</b>: offline — updates when it comes back`,
    unavailable: (it) => `⏸ <b>${esc(it.name)}</b>: auto-update unavailable (${esc(it.note)})`,
    timeout: (it) => `⏱ <b>${esc(it.name)}</b>: no result after ${RUN_TIMEOUT_MS / 60_000} min${it.note ? ` (last error: ${esc(it.note)})` : ""}`,
  };
  const summaryText = (results, mainLine) => {
    const count = (st) => results.filter((it) => it.state === st).length;
    const parts = [["updated", "updated"], ["current", "up to date"], ["failed", "failed"], ["offline", "offline"], ["timeout", "no result"], ["unavailable", "unavailable"]]
      .map(([st, label]) => (count(st) ? `${count(st)} ${label}` : null))
      .filter(Boolean);
    const lines = ["⬆️ <b>Update summary</b>", ""];
    if (results.length) {
      lines.push(`<b>Sub servers</b>: ${parts.join(" · ")}`);
      for (const it of results) lines.push(RESULT[it.state](it));
    } else {
      lines.push("<b>Sub servers</b>: none connected");
    }
    if (mainLine) lines.push("", mainLine);
    return lines.join("\n");
  };

  /**
   * Every sub server, wait for their results, then (withMain) the main server; one summary at the end.
   * withMain = false: only the sub servers ("update subs").
   */
  const updateMany = async (ctx, withMain) => {
    const subs = subServers();
    let run = null;
    try {
      run = subs.length ? monitor.startUpdateRun(subs) : null;
    } catch (e) {
      return ctx.reply(`⏳ ${esc(e.message)} — wait for that result first.`, HTML);
    }
    if (!subs.length && !withMain) return ctx.reply("No connected sub servers.");
    const waitNote = `One summary follows when they're done (at most ${RUN_TIMEOUT_MS / 60_000} min).`;
    await ctx.reply(
      !subs.length
        ? "⬆️ No connected sub servers — updating the main server…"
        : withMain
          ? `⬆️ Updating ${subs.length} sub server(s) first, then the main server.\n${waitNote}`
          : `⬆️ Updating ${subs.length} sub server(s); the main server is left as it is.\n${waitNote}`,
    );
    (async () => {
      const results = run ? await run.done : [];
      const main = withMain ? await mainUpdate({ deferRestart: true }) : null;
      await replyLong(ctx, summaryText(results, main?.text)).catch((e) => console.error("update summary failed:", e.message));
      main?.restartNow?.(); // restart only once the summary is out
    })().catch((e) => console.error("update failed:", e.message));
  };

  /** One sub server; replies with its result (updated / up to date / failed + reason). */
  const updateOne = async (ctx, s) => {
    if (s.status === "pending") return ctx.reply(`<b>${esc(s.name)}</b> has never connected yet.`, HTML);
    let run;
    try {
      run = monitor.startUpdateRun([s]);
    } catch {
      return ctx.reply(`⏳ <b>${esc(s.name)}</b> is already updating — its result is on the way.`, HTML);
    }
    const it = run.items.get(s.id);
    if (it.state === "waiting") {
      await ctx.reply(`⬆️ Updating <b>${esc(s.name)}</b>… you'll get the result here (at most ${RUN_TIMEOUT_MS / 60_000} min).`, HTML);
    }
    run.done
      .then(([res]) => ctx.reply(RESULT[res.state](res), HTML))
      .catch((e) => console.error("update reply failed:", e.message));
  };

  const showVersion = async (ctx) => {
    ctx.replyWithChatAction("typing").catch(() => {});
    return replyLong(ctx, await versionText(), { reply_markup: versionKeyboard() });
  };
  bot.command("version", showVersion);

  bot.callbackQuery("ver:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking GitHub…" });
    const text = await versionText();
    if (text.length > TELEGRAM_LIMIT - 96) return replyLong(ctx, text, { reply_markup: versionKeyboard() });
    await ctx.editMessageText(text, { ...HTML, reply_markup: versionKeyboard() }).catch(() => {}); // not modified
  });

  // "Update all" / "Update subs": show what would change, run after ✅
  bot.callbackQuery(/^upd:(all|subs)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking GitHub…" });
    const which = ctx.match[1];
    const text = await planText(which === "all");
    const kb = new InlineKeyboard().text("✅ Update now", `upd:${which}:go`).text("Cancel", "cancel");
    if (text.length > TELEGRAM_LIMIT - 96) return replyLong(ctx, text, { reply_markup: kb });
    await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(() => replyLong(ctx, text, { reply_markup: kb }));
  });

  bot.callbackQuery(/^upd:(all|subs):go$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {}); // no double taps
    return updateMany(ctx, ctx.match[1] === "all");
  });

  // one sub server, straight away (from the buttons under /version)
  bot.callbackQuery(/^upd:s:(.+)$/, async (ctx) => {
    const s = monitor.get(ctx.match[1]);
    if (!s) return ctx.answerCallbackQuery({ text: "Server no longer exists" });
    await ctx.answerCallbackQuery({ text: `Updating ${s.name}…` });
    return updateOne(ctx, s);
  });

  bot.command("update", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      return ctx.reply(
        "Usage:\n/update all — every sub server, then the main server, one summary at the end\n" +
          "/update subs — every sub server, one summary (main server untouched)\n" +
          "/update main — only the main server\n/update &lt;name&gt; — one sub server, with its result\n\n" +
          "Or use the buttons under /version.",
        HTML,
      );
    }
    const a = arg.toLowerCase();
    if (a === "all") return updateMany(ctx, true);
    if (a === "subs") return updateMany(ctx, false);
    if (a === "main") {
      await ctx.reply("⬆️ Checking GitHub for a main server update…");
      // git fetch / npm ci can take a while: answer now, report the result in a second message
      mainUpdate().then((m) => ctx.reply(m.text, HTML)).catch((e) => console.error("update reply failed:", e.message));
      return;
    }
    const s = monitor.find(arg);
    if (!s) return unknown(ctx, arg);
    return updateOne(ctx, s);
  });

  const showDashboard = (ctx) => {
    if (!cfg.webappUrl) return ctx.reply("The dashboard is not configured. Set <code>WEBAPP_URL</code>.", HTML);
    if (!isPrivate(ctx)) return ctx.reply("Open the dashboard from a private chat with the bot.");
    return ctx.reply("📈 Live dashboard:", { reply_markup: new InlineKeyboard().webApp("Open dashboard", cfg.webappUrl) });
  };
  bot.command("dashboard", showDashboard);

  const muteFor = (ctx, minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return ctx.reply("Usage: /mute 60  (minutes)");
    const capped = Math.min(minutes, 60 * 24 * 7);
    const until = notifier.mute(capped);
    return ctx.reply(`🔕 Notifications muted for ${fmtDuration(capped * 60)} (until ${fmtDateTime(until)}).`, withMenu(ctx));
  };
  const unmute = (ctx) => {
    const was = notifier.isMuted();
    notifier.unmute();
    return ctx.reply(was ? "🔔 Notifications are on." : "🔔 Notifications were already on.", withMenu(ctx));
  };
  bot.command("mute", (ctx) => muteFor(ctx, ctx.match ? parseInt(ctx.match, 10) : 60));
  bot.command("unmute", unmute);

  // ---- the button bar under the message box (private chats only; see menuKeyboard)
  bot.hears(MENU.status, showStatus);
  bot.hears(MENU.alerts, showAlerts);
  bot.hears(MENU.servers, showServers);
  bot.hears(MENU.version, showVersion);
  bot.hears(MENU.dashboard, showDashboard); // only without WEBAPP_URL; otherwise the button opens the Mini App itself
  bot.hears(MENU.mute, (ctx) => muteFor(ctx, 60));
  bot.hears(MENU.unmute, unmute);
  bot.hears(MENU.updateAll, askUpdateAll);

  /**
   * Give every admin the button bar once (after an install or when MENU_VERSION changes), so nobody
   * has to send /start to see it. An admin who never started the bot can't be messaged: skipped.
   */
  bot.sendMenu = async () => {
    if (Number(notifier.store?.getKv("menuVersion", 0)) === MENU_VERSION) return;
    for (const id of cfg.adminIds) {
      await bot.api
        .sendMessage(id, "⌨️ Shortcut buttons are now under the message box. (/help lists every command.)", { reply_markup: menuKeyboard() })
        .catch((e) => console.log(`button bar not sent to ${id}: ${e.description || e.message}`));
    }
    notifier.store?.setKv("menuVersion", MENU_VERSION);
  };

  bot.catch((err) => console.error("bot handler error:", err.error?.message || err.message));
  return bot;
}

/** Configure the bot and long-poll forever, retrying while Telegram is unreachable. */
export async function runBot(bot, cfg, onReady) {
  for (;;) {
    try {
      await bot.init();
      await bot.api.setMyCommands(COMMANDS);
      if (cfg.webappUrl) {
        await bot.api.setChatMenuButton({
          menu_button: { type: "web_app", text: "Dashboard", web_app: { url: cfg.webappUrl } },
        });
      }
      console.log(`Bot @${bot.botInfo.username} is running`);
      onReady?.();
      await bot.start({ allowed_updates: ["message", "callback_query"] });
      return; // bot.stop() was called
    } catch (e) {
      console.error(`Telegram bot error: ${e.description || e.message} — retrying in 30s`);
      await sleep(30_000);
    }
  }
}
