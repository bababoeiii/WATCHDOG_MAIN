# 🐕 Watchdog — Main Server

Monitor many servers from Telegram, with a live dashboard and auto-update from GitHub. Written in Node.js.

This is the **main server** project. The agent that runs on each monitored machine is a separate project,
**watchdog-sub** (its own GitHub repo). The two projects only talk to each other over HTTPS:
sub servers report metrics with a per-server token, and the main server tells them when to update.

```
                 GitHub repo (this project)
                          ▲ git pull
                          │
                 ┌────────┴────────────────────────┐
                 │  MAIN SERVER (this project)     │
                 │  • Telegram bot + live dashboard │
                 │  • creates / replaces / revokes  │
                 │    a token for every sub server  │
                 │  • down / up / reboot alerts     │
                 │  • /update: tells sub servers    │
                 │    to update from their own repo │
                 └───────▲───────────▲─────────────┘
               token A   │  token B  │   HTTPS, every 5 s
                 ┌───────┴───┐ ┌─────┴─────┐
                 │ SUB SERVER│ │ SUB SERVER│   (watchdog-sub project)
                 │  web-1    │ │  db-main  │   .env holds its token,
                 └───────────┘ └───────────┘   each pulls updates from
                                                its own GitHub repo
```

| Event | Telegram message |
|---|---|
| sub server connects for the first time | 🆕 connected |
| no report for 30 s | 🔴 **DOWN** |
| reports again | 🟢 back online (with downtime, "rebooted" if it did) |
| machine shuts down / reboots | ⏻ shutting down / rebooting |
| sub-server service stopped | ⏹ agent stopped |
| CPU / RAM / disk / temperature over the limit | ⚠️ alert … then ✅ resolved |
| a server installed a new version | ⬆️ updated `abc1234` → `def5678` |
| an update failed (and was rolled back) | ❗ update failed + reason |
| every 6 h | 🩺 health report (silent) |

> Run the main server on a machine that is **not** one of the sub servers (a small VPS is enough).

---

## 0. Put this project on GitHub

This project lives in its own GitHub repository: `github.com/bababoeiii/WATCHDOG_MAIN`.
A **public** repo is simplest. A **private** repo works too: create a fine-grained token with
read-only *Contents* access and pass it as `UPDATE_GITHUB_TOKEN` in `.env`.

From then on, **every push to `main` is a release** for the main server. It picks it up within
30 minutes, or right away with `/update main`. (Sub servers update from the watchdog-sub repo,
not from this one.)

Also set `SUB_REPO` in `.env` to the watchdog-sub repo URL (see Settings below), so the bot can
give a one-line installer for each sub server.

## 1. Install (aaPanel + nginx)

The main server runs behind **aaPanel's nginx**. aaPanel handles the domain and the SSL certificate (and its
renewals), and nginx forwards HTTPS to the Node app on a **local port you choose**.

```
Telegram / sub servers ──HTTPS 443──▶ aaPanel nginx (domain + Let's Encrypt) ──▶ 127.0.0.1:PORT (Watchdog)
```

**Step 1: in aaPanel (once)**

1. **App Store → Nginx** is installed. For **Node.js 18+**, use *App Store → Node.js version manager* (pick v20),
   or any system Node. The installer finds both.
2. **Website → Add site**: your domain, e.g. `watchdog.example.com` (PHP: *static*, no database).
   Point the domain's DNS A record at this server.
3. That site → **SSL → Let's Encrypt** → apply, then turn on **Force HTTPS**.
   Leave *Reverse proxy* and *URL rewrite* empty for this site, because Watchdog adds its own proxy config.

**Step 2: install (one command, over SSH)**

```bash
curl -fsSL https://raw.githubusercontent.com/bababoeiii/WATCHDOG_MAIN/main/install.sh | sudo bash -s -- \
  --repo https://github.com/bababoeiii/WATCHDOG_MAIN.git
```

(or from a clone: `sudo bash install.sh`)

It asks for the bot token (from **@BotFather** → `/newbot`), your Telegram ID, the domain and the **port**.
It suggests a free port and warns if yours is taken. Then it:

1. clones the repo to `/opt/watchdog-main` and installs dependencies
2. writes `.env`
3. creates the `watchdog` system user and the `watchdog-main` systemd service
4. adds the proxy block to your aaPanel site config (`/www/server/panel/vhost/nginx/<domain>.conf`, right after
   `#SSL-END`), runs `nginx -t`, and reloads nginx. **If nginx rejects it, the old config is put back.**
5. checks `https://<domain>/healthz` through nginx

You can answer the questions up front: `--domain watchdog.example.com --port 8090 --bot-token … --admin-ids 111`.
Don't know your Telegram ID? Enter `0`, send `/start` to the bot, and it replies with your ID. Then run
`sudo bash /opt/watchdog-main/install.sh --reconfigure`.

**Change the port or domain later**

```bash
sudo bash /opt/watchdog-main/install.sh --reconfigure      # asks again
sudo bash /opt/watchdog-main/install.sh --port 9090        # just the port
```

The nginx block is replaced, not duplicated, and the service restarts on the new port. Re-running the
installer is always safe: it keeps `.env` and updates code, service and nginx.

**nginx block only**

```bash
cd /opt/watchdog-main
sudo npm run nginx -- --apply      # (re)write the block into the aaPanel site, test, reload
sudo npm run nginx -- --remove     # take it out again (gives back the original aaPanel file)
npm run nginx                      # just print it (nginx/watchdog.conf) to paste by hand
```

The installer stops with a clear message if:
- the site doesn't exist in aaPanel yet → create it (step 1), then run the installer again
- the site has a **Reverse proxy** in aaPanel → delete it (Watchdog's block replaces it)
- the site's **URL rewrite** has a `location /` rule → set it to `0.default`

Notes:
- The app listens on `127.0.0.1:PORT`, so it's only reachable through nginx. **Don't** open the port in
  aaPanel → Security. Sub servers only need port 443 of your domain.
- Plain nginx without aaPanel: `sudo bash install.sh --vhost /etc/nginx/sites-enabled/watchdog.conf`
  (a `server { }` with SSL for your domain).
- `--no-nginx` skips the nginx step. Docker (`docker compose up -d`) also publishes on `127.0.0.1:PORT`
  for nginx, but auto-update is off there.

## 2. Add a sub server → get its token

In a **private chat** with your bot: `/add web-1`. Or in the dashboard: **＋ Add server**.

You get the `.env` lines **and** (with `SUB_REPO` set to a public repo) a ready-made one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/bababoeiii/WATCHDOG_SUB/main/install.sh | sudo bash -s -- \
  --repo https://github.com/bababoeiii/WATCHDOG_SUB.git --branch main \
  --main https://watchdog.example.com --token wd_Xb3k…
```

The token is shown **only once**, and the main server only keeps a hash of it. Lost it? `/token web-1` makes a
new one, and the old token stops working immediately.

## Updates

| How | What happens |
|---|---|
| automatic | every `UPDATE_CHECK_MINUTES` (30) the main server runs `git fetch`; if `main` moved, it updates itself |
| `/update main` | the main server updates now |
| `/update all` (or **⬆️ Update all** under `/version`) | both sides: every sub server updates on its next report (seconds); once they're done (at most 5 min) the main server updates. You get **one summary** (updated / up to date / failed / offline / no result) instead of a message per server, and the main server restarts only after the summary is sent. The button asks for confirmation and shows what would change first |
| `/update subs` (or **⬆️ Update subs** under `/version`) | every sub server, one summary; the main server is left as it is. The button asks for confirmation first |
| `/update web-1` (or the **⬆️ web-1** button under `/version`, shown for each sub server that is behind) | just that sub server (it pulls from the watchdog-sub repo); the bot replies with the result: updated `a → b`, already up to date, or failed + reason |
| dashboard | **⬆ Update from GitHub** on a server's page; **Update** next to the main server version at the bottom |
| `/version` | which commit the main server runs, and which commit each sub server runs, each compared against **its own repo's** latest: the main server reads `SUB_REPO` (`git ls-remote`, every `UPDATE_CHECK_MINUTES` and when you open `/version`), so it knows a sub server is behind without waiting for that server's own check. **🔄 Refresh** checks GitHub again |

An update goes like this: fetch → `git reset --hard origin/main` → `npm ci` if dependencies changed → `node
--check` on every source file → restart. If any step fails, the server goes back to the commit it was on,
keeps running, and you get **❗ update failed** with the reason.

Safety rules:
- **Local edits are never overwritten.** If tracked files were changed by hand, auto-update pauses and
  tells you.
- Set `AUTO_UPDATE=false` to update only when you say so (`/update`).

## Control command (on the main server)

The installer adds `watchdog-main` (a link to `control.sh`):

| Command | |
|---|---|
| `watchdog-main start` | start the service and wait until it answers |
| `watchdog-main restart` | restart it |
| `watchdog-main reload` | re-read `.env` **without a restart**. Alert thresholds, `ALERT_CHAT_IDS`, `ADMIN_IDS`, `TIMEZONE`, `SUB_REPO`, intervals … apply at once; `BOT_TOKEN`, `PORT`, `HOST`, `WEBAPP_URL`, `DATA_FILE` and the auto-update settings are listed as "needs a restart". A broken `.env` is refused and nothing changes |
| `watchdog-main test` | self-check: `.env`, bot token, admins, notification groups (is the bot in them?), local port, public HTTPS, dashboard, data file, both GitHub repos. Exit code 1 if something failed |
| `watchdog-main health` | service state (uptime, memory, restarts), errors of the last 24 h, connectivity (local, public, Telegram), sub servers online/offline, version vs. GitHub |

## Bot commands

In a private chat the bot keeps a button bar under the message box (it appears by itself after an
install or update; `/start` brings it back): **📊 Status · ⚠️ Alerts · 🖥 Servers · 🏷 Version ·
📈 Dashboard · 🔕 Mute 1h / 🔔 Unmute · ⬆️ Update all** (asks before it runs). Groups don't get it.

| Command | |
|---|---|
| `/add <name>` | create a sub server and get its token (+ installer) |
| `/token <name>` | replace a server's token (old one revoked) |
| `/remove <name>` | remove a server and revoke its token |
| `/servers` | list servers, status and token age |
| `/status` | CPU / RAM / disk / temp of every server |
| `/alerts` | servers down + active alerts |
| `/version` | versions vs. each project's GitHub repo |
| `/update all \| subs \| main \| <name>` | update now (`all` = both sides, `subs` = all sub servers; one summary) |
| `/dashboard` | open the live dashboard |
| `/mute 60` · `/unmute` | silence notifications |

Only users in `ADMIN_IDS` can use the bot and dashboard. Tokens are only sent in private chats.

## Settings

`.env`:

| Variable | Default | |
|---|---|---|
| `SUB_REPO` / `SUB_BRANCH` | — / `main` | GitHub repo of the watchdog-sub project: for the bot's one-line installer, and to know which sub servers are behind. Empty = no one-liner (the `.env` snippet still works) and "behind" falls back to each sub server's own last check |
| `SUB_GITHUB_TOKEN` | — | only if `SUB_REPO` is private and `UPDATE_GITHUB_TOKEN` can't read it |
| `OFFLINE_AFTER_SECONDS` | 30 | silence before a sub server counts as down |
| `HEALTH_REPORT_INTERVAL_MINUTES` | 360 | 0 turns the report off |
| `CPU_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | |
| `RAM_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | |
| `DISK_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 0 | fullest disk |
| `TEMP_ALERT_CELSIUS` / `_FOR_SECONDS` | 80 / 60 | hottest sensor |
| `ALERT_HYSTERESIS` | 5 | how far below the limit before "resolved" |
| `AUTO_UPDATE` · `UPDATE_CHECK_MINUTES` · `UPDATE_BRANCH` · `UPDATE_GITHUB_TOKEN` | true · 30 · checked-out branch · — | |
| `TIMEZONE` | server's own | time zone for times in Telegram messages, e.g. `America/Toronto` |
| `PORT` | 8080 | local port of the Node app; aaPanel/nginx proxies to it (`npm run setup` picks a free one) |
| `HOST` | 127.0.0.1 | `127.0.0.1` = only via aaPanel/nginx; `0.0.0.0` = reachable directly |
| `DEV_NO_AUTH` | false | open `http://localhost:8080/app/` without Telegram. **Never in production.** |

## Tests

```bash
npm test     # login check, report sanitising, tokens, alerts, down detection,
             # notification batching/splitting, nginx block, HTTP + WebSocket API
```

## Security

- Each sub server has its own token. Only its SHA-256 hash is stored, and you can revoke one without touching the others.
- The dashboard checks Telegram's signed `initData` and your user ID on every request and WebSocket.
  The live connection sends the login as its first message, so it never appears in URLs or nginx logs.
- Everything a sub server reports is checked and normalised on the main server (numbers stay numbers, text is
  length-limited and escaped), so even a compromised sub server can't inject anything into the dashboard.
- Auto-update runs whatever is pushed to the branch, so protect the branch on GitHub (who can push).

## Layout

```
src/        index, server, monitor, bot, notifier, telegramAuth, store, format, config, updater
scripts/    setup.js (npm run setup) · nginx.js (npm run nginx [--apply|--remove] → aaPanel site config)
public/     index.html (Telegram Mini App)
control.sh  watchdog-main start|restart|reload|test|health · scripts/check.js (the self-check)
install.sh  aaPanel install · Dockerfile · docker-compose.yml · watchdog-main.service · .env.example
```
