#!/bin/bash
# Cloud Browser orphan reaper -- the EXTERNAL watchdog.
#
# This runs OUTSIDE the node server, on purpose. The server reaps its own
# children on shutdown and via its in-process ffmpeg watchdog, but none of that
# can run if the process is OOM-killed or dies without unwinding. Anything it
# spawned is then re-parented to init and keeps burning CPU and memory until
# something else stops it. On this box that happened: six stale ffmpeg
# processes, the oldest 6.8 days old, driving the OOM kills.
#
# Rule:
#   * server running  -> kill chromium/ffmpeg that are NOT descendants of node.
#     Xvfb is exempt in that case (see the INFRA_RE note): vps-restart.sh starts
#     it independently, so it is never a descendant of node.
#   * no server       -> nothing chromium/ffmpeg/Xvfb-like should be alive at
#     all; sweep every match.
#   * ALWAYS           -> never kill an exempt Chromium helper (EXEMPT_RE), and
#     never kill a process we cannot identify. Both apply to BOTH kill paths.
#
# Implementation notes (these are corrections, not style choices):
#   * NO pstree: it comes from psmisc, which is not guaranteed to be installed
#     on Debian. The parent chain is walked from `ps -eo pid=,ppid=` instead.
#   * NO `grep -oP`: PCRE is GNU-only. Only POSIX grep -x/-q is used here.
#   * NO mapfile, no `date -Is`: both fail on bash 3.2 / BSD userland, which
#     would have made this script impossible to test on the dev machine. The
#     script must be runnable and testable anywhere it might be invoked.
#   * `pgrep -f` matches full command lines and pgrep/pkill never match their
#     own process (verified empirically: `pgrep -f 'pgrep -f ffmpeg'` -> none),
#     so the pattern below cannot make this script kill itself. It also cannot
#     match this script's own argv, which never contains a target token.
#   * BUT pgrep also does not report a target to that target's OWN DESCENDANT
#     (verified: `pgrep -f <target>` run from a child of <target> returned
#     empty while `ps` showed it plainly). Because an empty pgrep result here
#     is interpreted as "no server running" -- the branch that mass-kills
#     everything -- the process table is read with `ps` and pgrep is only a
#     fallback that must corroborate before that branch is ever taken.
#
# CB_REAPER_TARGET_RE / CB_REAPER_NODE_RE override the patterns so the logic
# can be exercised against stand-in processes without touching real ones.

set -u

# `firefox` and `brave` are matched alongside chromium so an orphaned browser
# from a dead server is reaped too. Without them, a server crash during a
# Firefox or Brave session leaks the whole browser process tree (parent +
# content/GPU/utility processes), which is the exact orphan problem this reaper
# exists to prevent. Brave's binary is brave-browser, hence the separate token.
TARGET_RE="${CB_REAPER_TARGET_RE:-chromium|firefox|brave|ffmpeg|Xvfb}"
NODE_RE="${CB_REAPER_NODE_RE:-node.*dist-server/server/main.js}"

# Process names that are NEVER killed, in either kill path, even when they look
# orphaned.
#
# Chromium's crash handlers detach from the browser deliberately and reparent
# to init for isolation, so they match `chromium` -- their argv carries the
# Chromium user-data-dir path -- while belonging to a perfectly healthy LIVE
# session. They are never descendants of node, so the descendant check cannot
# save them. Observed in the journal at 02:55:24: KILL orphan pid=178810
# comm=chrome_crashpad, and the session died two minutes later.
#
# Listed as both names because the reported name depends on the platform: Linux
# truncates comm to 15 characters, which renders `chrome_crashpad_handler` as
# `chrome_crashpad`, while a full path (e.g. macOS) contains the long form.
#
# `brave_crashpad*` is the same class of process in Brave. Brave is
# Chromium-based, so it forks its own crash handler under Brave's own name, and
# it detaches and reparents to init exactly as Chromium's does. Without these
# entries, adding `brave` to TARGET_RE would let the reaper kill the crashpad of
# a HEALTHY live Brave session -- the same bug that killed a live session for
# Chromium at 02:55:24.
EXEMPT_RE="${CB_REAPER_EXEMPT_RE:-chrome_crashpad|chrome_crashpad_handler|brave_crashpad|brave_crashpad_handler}"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[reaper $(ts)] $*"; }

# --- Snapshot the process table ONCE; derive both sets from it --------------
# `ps` is deliberately authoritative here INSTEAD of pgrep. Empirically (BSD/
# macOS), `pgrep -f` does NOT report a target to its own descendant: tested as
# a child of the target, `pgrep -f <target>` returned empty while `ps` showed
# that target plainly. An empty pgrep result here would be read as "no server
# running" -- the DESTRUCTIVE branch -- and this script would then mass-kill the
# live server's own Chromium and ffmpeg every 2 minutes. One shared `ps`
# snapshot removes that failure mode entirely; pgrep is only a fallback below.
PS_TABLE=$(ps -eo pid=,ppid=,args= 2>/dev/null || true)
if [ -z "$PS_TABLE" ]; then
  log "could not read the process table; doing nothing (safe default)"
  exit 0
fi

# Select the pid column of every line whose full command matches the ERE.
pids_matching() {
  printf '%s\n' "$PS_TABLE" | grep -E "$1" 2>/dev/null | awk '{print $1}'
}

# Decision for one pid, from the last classify_pid call:
#   VERDICT -- kill | keep | skip
#   COMM    -- the resolved process name
#   REASON  -- why, for the log line
VERDICT="skip"
COMM=""
REASON=""

# Decide what may be done to ONE pid. Two hard stops, both of which previously
# failed to protect anything:
#
#   1. IDENTIFY OR REFUSE. `ps -o comm=` returning empty (or the literal '?')
#      means the process cannot be read: already exiting, a zombie, or in an
#      unmapped state. The journal showed `comm=?` on pid=178812 immediately
#      before the session died, and the old code logged that and killed it
#      anyway -- because `ps ... || echo '?'` produced the '?' and the kill
#      proceeded regardless. An unidentified process is now never killed.
#   2. EXEMPT Chromium helpers (EXEMPT_RE), which reparent to init by design.
classify_pid() {
  pid="$1"
  COMM=$(ps -o comm= -p "$pid" 2>/dev/null | head -n 1 \
          | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -z "$COMM" ] || [ "$COMM" = "?" ]; then
    VERDICT="skip"
    REASON="cannot identify (comm='$COMM') -- refusing to kill"
    return
  fi
  if printf '%s\n' "$COMM" | grep -qE "$EXEMPT_RE"; then
    VERDICT="keep"
    REASON="exempt Chromium helper comm=$COMM"
    return
  fi
  VERDICT="kill"
  REASON="comm=$COMM"
}

NODE_PIDS=$(pids_matching "$NODE_RE")
if [ -n "$NODE_PIDS" ]; then
  log "node main process (from ps): $(echo "$NODE_PIDS" | tr '\n' ' ')"
else
  # Prefer a false "server running" (we skip one sweep) over a false "no
  # server" (mass-killing the live server's children), so corroborate with
  # pgrep before ever entering the destructive branch.
  FALLBACK=$(pgrep -f "$NODE_RE" 2>/dev/null || true)
  if [ -n "$FALLBACK" ]; then
    NODE_PIDS="$FALLBACK"
    log "ps matched nothing; pgrep says the server is running: $(echo "$NODE_PIDS" | tr '\n' ' ')"
  fi
fi

if [ -z "$NODE_PIDS" ]; then
  # Nothing to be a descendant of: every matching process is a leftover.
  TARGET_PIDS=$(pids_matching "$TARGET_RE")
  if [ -z "$TARGET_PIDS" ]; then
    log "no node main process and no chromium/ffmpeg/Xvfb running (clean)"
    exit 0
  fi
  log "NO node main process running; sweeping $(echo "$TARGET_PIDS" | wc -w | tr -d ' ') candidate(s): $(echo "$TARGET_PIDS" | tr '\n' ' ')"

  # This branch used to be a single blind `pkill -9 -f`, which by construction
  # could honour neither the helper exemption nor the identify-or-refuse guard.
  # It is now a per-pid loop, so a crash handler -- and any process ps cannot
  # read -- survives a sweep that happens to run with the server down.
  n_killed=0; n_exempt=0; n_skipped=0
  for pid in $TARGET_PIDS; do
    classify_pid "$pid"
    if [ "$VERDICT" = "keep" ]; then
      log "KEEP pid=$pid $REASON (matched target pattern, but must not be killed)"
      n_exempt=$((n_exempt + 1))
    elif [ "$VERDICT" = "skip" ]; then
      log "SKIP pid=$pid $REASON"
      n_skipped=$((n_skipped + 1))
    else
      log "KILL leftover pid=$pid $REASON"
      kill -9 "$pid" 2>/dev/null || true
      n_killed=$((n_killed + 1))
    fi
  done
  log "sweep done: $n_killed killed, $n_exempt exempt, $n_skipped unidentified (not killed)"
  exit 0
fi

# --- Build the descendant set by walking the ppid chain --------------------
# A pid is live iff it is the server itself, or its parent is already live,
# resolved to a fixed point. This runs INSIDE awk: the obvious shell version
# (a while-read loop doing two greps per line per pass) forks thousands of times
# per sweep and took ~9s on the test machine -- real CPU pressure on a 2-vCore
# box already running Chromium plus three ffmpeg processes, i.e. exactly the
# resource this watchdog exists to protect. One awk process does it in
# milliseconds.
# awk also keeps $1/$2/$3 strictly separate, so the args column can never leak
# into ppid the way a two-variable `read` would -- which would make every
# process look like an orphan and cost the live server its children.
LIVE=$(mktemp) || { log "mktemp failed; aborting"; exit 1; }
trap 'rm -f "$LIVE"' EXIT

printf '%s\n' "$PS_TABLE" | awk -v roots="$NODE_PIDS" '
BEGIN {
  n = split(roots, r, /[ \t\n]+/)
  for (i = 1; i <= n; i++) if (r[i] != "") live[r[i]] = 1
}
{ p[NR] = $1; pp[NR] = $2 }
END {
  changed = 1
  while (changed) {
    changed = 0
    for (i = 1; i <= NR; i++)
      if (!(p[i] in live) && (pp[i] in live)) { live[p[i]] = 1; changed = 1 }
  }
  for (x in live) print x
}' > "$LIVE"
# Never reap ourselves or our launcher, regardless of what the patterns match.
printf '%s\n' "$$" >> "$LIVE"
log "descendant set size: $(wc -l < "$LIVE" | tr -d ' ')"

# --- Kill matching processes that are NOT in the set ----------------------
# Xvfb is EXCLUDED here on purpose. scripts/vps-restart.sh starts it
# independently of node, so it is a SIBLING of the server, never a descendant --
# without this exemption the sweep would classify the live display as orphaned
# and tear down the very screen Chromium is rendering into, then do it again
# every 2 minutes. Xvfb is only a genuine leftover when the server is down,
# which is handled by the branch above (the one that exits before this point).
# Chromium and ffmpeg are NOT exempt: both are spawned by node, so an unclaimed
# one really is orphaned from a previous session.
INFRA_RE="${CB_REAPER_INFRA_RE:-Xvfb}"
TARGET_PIDS=$(printf '%s\n' "$PS_TABLE" | grep -E "$TARGET_RE" | grep -vE "$INFRA_RE" | awk '{print $1}')
if [ -z "$TARGET_PIDS" ]; then
  log "no orphan-candidate (chromium/ffmpeg) process running"
  exit 0
fi

killed=0
kept=0
exempt=0
skipped=0
for pid in $TARGET_PIDS; do
  if grep -qx "$pid" "$LIVE" 2>/dev/null; then
    kept=$((kept + 1))
    continue
  fi
  # Not a descendant of node, so it looks like an orphan candidate -- but
  # classify_pid decides whether it may ACTUALLY be killed: it refuses exempt
  # Chromium helpers and anything ps cannot identify. The old code read
  # `comm=$(ps ... || echo '?')` and then killed unconditionally, which is how a
  # chrome_crashpad and a comm=? process both got reaped from a live session.
  classify_pid "$pid"
  if [ "$VERDICT" = "keep" ]; then
    log "KEEP pid=$pid $REASON (matched target pattern, but must not be killed)"
    exempt=$((exempt + 1))
    continue
  fi
  if [ "$VERDICT" = "skip" ]; then
    log "SKIP pid=$pid $REASON (matched target pattern, but not killed)"
    skipped=$((skipped + 1))
    continue
  fi
  age=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  log "KILL orphan pid=$pid $REASON age=${age:-?} (not a descendant of node [$NODE_PIDS])"
  kill -9 "$pid" 2>/dev/null || true
  killed=$((killed + 1))
done

log "sweep done: $killed killed, $kept kept (descendants), $exempt exempt helpers, $skipped unidentified (not killed)"
exit 0
