#!/usr/bin/env bash
# watchdog-main — control the Watchdog main server (install.sh links it to /usr/local/bin/watchdog-main)
#
#   watchdog-main start     start the service and wait until it answers
#   watchdog-main restart   restart it (Telegram bot + dashboard are back within seconds)
#   watchdog-main reload    re-read .env without a restart; lists settings that still need one
#   watchdog-main test      self-check: .env, bot token, notification groups, port, HTTPS, data, GitHub
#   watchdog-main health    service state, recent errors, connectivity + sub servers, version
set -uo pipefail
SERVICE="${WATCHDOG_SERVICE:-watchdog-main}"
UNIT="/etc/systemd/system/$SERVICE.service"
SELF="$(readlink -f "${BASH_SOURCE[0]}")"

usage() { sed -n '2,9p' "$SELF" | sed -E 's/^# ?//'; }
die() { echo "✖ $*" >&2; exit 1; }

cmd="${1:-}"
case "$cmd" in
  start|restart|reload|test|health) ;;
  ""|-h|--help|help) usage; exit 0;;
  *) usage; echo; die "Unknown command: $cmd";;
esac
[[ $EUID -eq 0 ]] || exec sudo -- "$SELF" "$@"
[[ -f "$UNIT" ]] || die "$SERVICE is not installed ($UNIT is missing). Run install.sh first."

# ---------------------------------------------------------------- where and how it runs (from the unit file)
prop() { sed -n "s/^$1=//p" "$UNIT" | head -1; }
APP="$(prop WorkingDirectory)"
RUN_USER="$(prop User)"; RUN_USER="${RUN_USER:-root}"
NODE="$(prop ExecStart | awk '{print $1}')"; [[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -d "$APP/src" ]] || die "$APP doesn't look like the main-server folder."
cd "$APP" || die "can't enter $APP"

# The service may read another .env too (WATCHDOG_ENV_FILE, e.g. /www/wwwroot/WATCHDOG/.env): it is
# merged with the .env next to the code, and wins. env_get reads settings the same way.
ENV_EXTRA="$(systemctl show -p Environment --value "$SERVICE" 2>/dev/null | tr ' ' '\n' | sed -n 's/^WATCHDOG_ENV_FILE=//p' | tail -1)"
ENV_FILES=(); [[ -n "$ENV_EXTRA" ]] && ENV_FILES+=("$ENV_EXTRA"); [[ "$ENV_EXTRA" -ef "$APP/.env" ]] || ENV_FILES+=("$APP/.env")
env_get() {
  local f v
  for f in "${ENV_FILES[@]}"; do
    [[ -r "$f" ]] && grep -q "^$1=" "$f" || continue
    v="$(sed -n "s/^$1=//p" "$f" | tail -1 | tr -d '\r')"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"; return
  done
}
PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
HOST="$(env_get HOST)"; HOST="${HOST:-127.0.0.1}"; [[ "$HOST" == 0.0.0.0 || "$HOST" == "::" ]] && HOST=127.0.0.1
PUBLIC_URL="$(env_get PUBLIC_URL)"
[[ -n "$PUBLIC_URL" ]] || PUBLIC_URL="$(env_get WEBAPP_URL | sed -E 's#^(https?://[^/]+).*#\1#')"
PUBLIC_URL="${PUBLIC_URL%/}"
LOCAL="http://$HOST:$PORT"

as_user() { if [[ "$RUN_USER" == root ]]; then "$@"; else runuser -u "$RUN_USER" -- "$@"; fi; }
healthz() { curl --noproxy '*' -fsS -m "${2:-3}" "$1/healthz" 2>/dev/null; }
wait_up() { for _ in $(seq 1 30); do healthz "$LOCAL" 1 >/dev/null && return 0; sleep 0.5; done; return 1; }
main_pid() { systemctl show -p MainPID --value "$SERVICE"; }
came_up() {
  if wait_up; then echo "✔ $SERVICE is running on $LOCAL"
  else journalctl -u "$SERVICE" -n 20 --no-pager; die "$SERVICE didn't answer on $LOCAL (log above)."; fi
}

# ---------------------------------------------------------------- start / restart
if [[ "$cmd" == start ]]; then
  if systemctl is-active --quiet "$SERVICE"; then echo "Already running."; came_up; exit 0; fi
  systemctl start "$SERVICE" || die "systemctl start failed (journalctl -u $SERVICE)"
  came_up; exit 0
fi
if [[ "$cmd" == restart ]]; then
  systemctl restart "$SERVICE" || die "systemctl restart failed (journalctl -u $SERVICE)"
  came_up; exit 0
fi

# ---------------------------------------------------------------- reload: re-read .env, no restart
if [[ "$cmd" == reload ]]; then
  systemctl is-active --quiet "$SERVICE" || die "$SERVICE isn't running (watchdog-main start)."
  if ! grep -q SIGHUP src/index.js; then
    echo "This version can't reload yet: restarting instead."
    exec "$SELF" restart
  fi
  pid="$(main_pid)"; since="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl kill -s HUP --kill-whom=main "$SERVICE"
  out=""
  for _ in $(seq 1 20); do
    out="$(journalctl -u "$SERVICE" --since "$since" -o cat --no-pager 2>/dev/null | grep -F '[reload]' | tail -1)"
    [[ -n "$out" ]] && break
    sleep 0.25
  done
  if [[ -z "$out" ]]; then
    [[ "$(main_pid)" != "$pid" ]] && { echo "It was still running an older version, so it restarted instead."; came_up; exit 0; }
    die "No answer from $SERVICE (journalctl -u $SERVICE)."
  fi
  out="${out#\[reload\] }"
  if [[ "$out" == failed* ]]; then die "Reload ${out} — the running server keeps its old settings."; fi
  field() { sed -nE "s/.*· $1: ([^·]*).*/\1/p" <<<"$out" | sed 's/ *$//'; }
  files="$(field files)"; missing="$(field missing)"; changed="$(field 'changed now')"; later="$(field 'needs a restart')"
  echo "✔ .env reloaded"
  [[ -n "$files" ]] && echo "  read:              $files"
  [[ -n "$missing" ]] && echo "  ⚠ not found:       $missing"
  echo "  applied now:       ${changed:-nothing}"
  if [[ -n "$later" && "$later" != nothing ]]; then
    echo "  needs a restart:   $later"
    echo "  → run: watchdog-main restart"
  fi
  exit 0
fi

# ---------------------------------------------------------------- test: self-check
if [[ "$cmd" == test ]]; then
  [[ -f scripts/check.js ]] || die "scripts/check.js is missing: update the main server first (/update main)."
  as_user env ${ENV_EXTRA:+WATCHDOG_ENV_FILE="$ENV_EXTRA"} "$NODE" scripts/check.js
  exit $?
fi

# ---------------------------------------------------------------- health
bad=0
echo "== Service"
declare -A P
while IFS='=' read -r k v; do P[$k]="$v"; done < <(systemctl show "$SERVICE" -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts -p MemoryCurrent)
if [[ "${P[ActiveState]}" == active ]]; then
  up=$(( $(date +%s) - $(date -d "${P[ActiveEnterTimestamp]}" +%s 2>/dev/null || date +%s) ))
  printf -v upt '%dd %dh %dm' $((up/86400)) $((up%86400/3600)) $((up%3600/60))
  mem="${P[MemoryCurrent]}"; [[ "$mem" =~ ^[0-9]+$ ]] && mem="$((mem/1024/1024)) MB" || mem="?"
  echo "✔ running for ${upt#0d } · memory $mem · automatic restarts: ${P[NRestarts]:-0}"
  echo "  code:     $APP"
  for f in "${ENV_FILES[@]}"; do
    [[ -f "$f" ]] && echo "  settings: $f$([[ ${#ENV_FILES[@]} -gt 1 && "$f" == "${ENV_FILES[0]}" ]] && echo " (wins)")" \
      || echo "  ⚠ settings file not found: $f"
  done
else
  echo "✖ ${P[ActiveState]} (${P[SubState]}) — start it with: watchdog-main start"; bad=1
fi

echo; echo "== Errors (last 24 h)"
errs="$(journalctl -u "$SERVICE" --since "24 hours ago" -o short-iso --no-pager 2>/dev/null \
  | grep -Ei 'error|fail|❗|unhandled|EADDRINUSE|ECONNREFUSED|rejected|cannot|can.t ' | grep -v 'Auto-update off')"
if [[ -z "$errs" ]]; then echo "✔ none"
else
  echo "⚠ $(wc -l <<<"$errs") line(s); the latest:"
  tail -5 <<<"$errs" | sed -E 's/^([0-9T:-]+)[^ ]* [^ ]+ [^:]+: /\1  /' | cut -c1-170 | sed 's/^/   /'
  echo "   (all of it: journalctl -u $SERVICE --since '24 hours ago')"
fi

echo; echo "== Connectivity"
if healthz "$LOCAL" >/dev/null; then echo "✔ local    $LOCAL"
else echo "✖ local    $LOCAL doesn't answer"; bad=1; fi
if [[ -z "$PUBLIC_URL" ]]; then echo "⚠ public   PUBLIC_URL not set"
elif healthz "$PUBLIC_URL" 8 >/dev/null; then echo "✔ public   $PUBLIC_URL (sub servers can report)"
else echo "✖ public   $PUBLIC_URL/healthz doesn't answer (nginx / SSL / DNS?)"; bad=1; fi
if curl -sS -o /dev/null -m 6 https://api.telegram.org 2>/dev/null; then echo "✔ Telegram api.telegram.org reachable"
else echo "✖ Telegram api.telegram.org not reachable (no notifications)"; bad=1; fi

echo; echo "== Sub servers"
DATA="$(env_get DATA_FILE)"; DATA="${DATA:-data/watchdog.json}"; [[ "$DATA" == /* ]] || DATA="$APP/$DATA"
if [[ -f "$DATA" && -n "$NODE" ]]; then
  "$NODE" -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const list = Object.values(d.servers || {}).sort((a, b) => a.name.localeCompare(b.name));
    const n = (st) => list.filter((s) => s.status === st).length;
    if (!list.length) { console.log("  none yet (/add <name> in Telegram)"); process.exit(0); }
    console.log(`${n("offline") ? "⚠" : "✔"} 🟢 ${n("online")} online · 🔴 ${n("offline")} offline · ⚪ ${n("pending")} never connected`);
    const when = (t) => (t ? new Date(t * 1000).toLocaleString("sv-SE").slice(0, 16) : "?");
    const reason = { timeout: "no reports", shutdown: "shut down", agent_stopped: "agent stopped" };
    for (const s of list.filter((s) => s.status === "offline"))
      console.log(`   🔴 ${s.name} — since ${when(s.statusSince)} (${reason[s.offlineReason] || "offline"})`);
  ' "$DATA" 2>/dev/null || echo "⚠ can't read $DATA"
else
  echo "  no data file yet ($DATA)"
fi

echo; echo "== Version"
if as_user git -C "$APP" rev-parse --git-dir >/dev/null 2>&1; then
  commit="$(as_user git -C "$APP" rev-parse --short HEAD)"
  branch="$(as_user git -C "$APP" rev-parse --abbrev-ref HEAD)"
  remote="$(as_user git -C "$APP" remote get-url origin 2>/dev/null)"
  tok="$(env_get UPDATE_GITHUB_TOKEN)"
  auth=(); [[ -n "$tok" ]] && auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')")
  latest="$(as_user env GIT_TERMINAL_PROMPT=0 timeout 20 git "${auth[@]}" ls-remote "$remote" "refs/heads/$branch" 2>/dev/null | cut -c1-7)"
  if [[ -z "$latest" ]]; then echo "⚠ $commit on $branch — couldn't reach $(sed -E 's#//[^@/]+@#//#' <<<"$remote")"
  elif [[ "$latest" == "$commit" ]]; then echo "✔ $commit on $branch — up to date"
  else echo "⬆️ $commit on $branch — GitHub has $latest (/update main in Telegram, or wait for auto-update)"; fi
  [[ -n "$(as_user git -C "$APP" status --porcelain --untracked-files=no 2>/dev/null)" ]] \
    && echo "⚠ local changes in $APP: auto-update is paused until they're committed or discarded"
else
  echo "⚠ not a git install: no auto-update"
fi

exit $bad
