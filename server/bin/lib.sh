# Shared settings and helpers for srv-* (sourced, not run).
# Workers live on their own tmux socket (-L srv) so nothing here can touch
# the user's tmux sessions, and only names with a record are ever acted on.
#
# Every setting can be overridden in ~/.config/srv/env (or the file named by
# SRV_ENV), which is read by both the desk's calls and the reap timer.
# It is run as bash, so it holds plain NAME=value lines.

SRV_BIN=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
SRV_ENV=${SRV_ENV:-$HOME/.config/srv/env}
# shellcheck source=/dev/null
[ -f "$SRV_ENV" ] && . "$SRV_ENV"

SRV_DESK=${SRV_DESK:-server-desk}                  # default requester: the desk session's name
SRV_DIR=${SRV_DIR:-/opt/desk}                      # default folder a worker starts in
SRV_STATE=${SRV_STATE:-$HOME/.local/state/srv}     # one record file per worker, plus srv.log
SRV_SOCK=${SRV_SOCK:-srv}                          # tmux -L socket name
SRV_MAX=${SRV_MAX:-3}                              # max concurrent workers
SRV_IDLE_MAX=${SRV_IDLE_MAX:-14400}                # reap after 4h idle (seconds)
SRV_HARD_MAX=${SRV_HARD_MAX:-86400}                # reap after 24h no matter what
SRV_CLAUDE=${SRV_CLAUDE:-$(command -v claude || echo "$HOME/.local/bin/claude")}
SRV_TMUX=${SRV_TMUX:-$(command -v tmux || echo /usr/bin/tmux)}
SRV_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SRV_SESSIONS=$SRV_CONFIG_DIR/sessions
# Claude Code keeps folder trust in ~/.claude.json, or inside CLAUDE_CONFIG_DIR when that is set.
SRV_TRUST_FILE=${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}
SRV_TRUST_FILE=${SRV_TRUST_FILE:-$HOME/.claude.json}
SRV_LOG=$SRV_STATE/srv.log

umask 002
mkdir -p "$SRV_STATE"

srv_tmux() { "$SRV_TMUX" -L "$SRV_SOCK" "$@"; }

srv_log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$SRV_LOG"; }

# srv_get <record-file> <key> — read one key=value line without sourcing the file
srv_get() { sed -n "s/^$2=//p" "$1" | tail -n1; }

# srv_alive <record-file> — 0 if the recorded claude pid is still the same process
srv_alive() {
  local pid start
  pid=$(srv_get "$1" pid); start=$(srv_get "$1" procStart)
  [ -n "$pid" ] && [ -r "/proc/$pid/stat" ] || return 1
  [ "$(awk '{print $22}' "/proc/$pid/stat")" = "$start" ]
}

# srv_live_count — records whose tmux session still exists
srv_live_count() {
  local f n=0
  for f in "$SRV_STATE"/srv-*; do
    [ -f "$f" ] || continue
    srv_tmux has-session -t "=$(basename "$f")" 2>/dev/null && n=$((n + 1))
  done
  echo "$n"
}
