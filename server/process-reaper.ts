import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'child_process';

/**
 * Central child-process reaper.
 *
 * Every ffmpeg/Chromium child this server spawns is registered here so that
 * teardown is explicit, escalating and WAITED ON, instead of a fire-and-forget
 * kill whose reference was immediately discarded.
 *
 * The three ways children leaked (all now handled):
 *   1. SIGTERM is a request. Nothing escalated it, so a child blocked in a
 *      syscall kept running and was then orphaned when the parent exited.
 *   2. A singleton kill cannot reach descendants, so anything a child forked
 *      was left behind. spawnTracked spawns DETACHED, which puts each child in
 *      its own process group so a group kill is possible -- it also requires
 *      that, since kill(-pid) cannot target a child sharing our own group.
 *   3. Nothing ever verified the kill. killChild() now waits for 'close' and
 *      reports loudly if a child is still alive after SIGKILL.
 *
 * The periodic watchdog additionally sweeps up anything that predates the
 * current session, covering children that survived a hard parent kill.
 */

interface TrackedChild {
  label: string;
  pid: number;
  child: ChildProcess;
  startedAt: number;
}

const tracked = new Map<number, TrackedChild>();

const SERVER_STARTED_AT = Date.now();
// Start times of live sessions. The watchdog uses the EARLIEST as its cutoff:
// anything older than that cannot belong to a live session.
const sessionStarts = new Set<number>();

const TERM_GRACE_MS = Number(process.env.CHILD_TERM_GRACE_MS) || 2000;
const WATCHDOG_INTERVAL_MS = Number(process.env.FFMPEG_WATCHDOG_MS) || 60_000;
// `ps` reports elapsed seconds as a whole number, so a child spawned just after
// its session started can appear up to ~1s older than it is. Anything within
// this slack of the cutoff still counts as belonging to the live session.
const WATCHDOG_SLACK_MS = 2000;

/** Record a session start so the watchdog can tell orphans from live work. */
export function registerSessionStart(at: number = Date.now()): number {
  sessionStarts.add(at);
  return at;
}

export function unregisterSessionStart(at: number): void {
  sessionStarts.delete(at);
}

/** The age boundary below which a process cannot belong to a live session. */
export function watchdogCutoff(): number {
  return sessionStarts.size === 0 ? SERVER_STARTED_AT : Math.min(...sessionStarts);
}

function track(child: ChildProcess, label: string): void {
  if (!child.pid) return;
  tracked.set(child.pid, { label, pid: child.pid, child, startedAt: Date.now() });
  const drop = () => { tracked.delete(child.pid!); };
  child.once('exit', drop);
  child.once('error', drop);
}

/**
 * Spawn a long-lived child the reaper owns.
 *
 * `detached: true` is forced and is load-bearing: it makes the child its own
 * process-group leader, which is both what allows the group kill below and
 * what stops the child from sharing (and surviving) our own group.
 */
export function spawnTracked(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  label: string,
): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: true });
  track(child, label);
  return child;
}

/** Track a child we did not spawn (Puppeteer's Chromium) so we can force-kill it. */
export function registerExternalChild(child: ChildProcess, label: string): void {
  track(child, label);
}

export function isTracked(pid: number): boolean {
  return tracked.has(pid);
}

export function trackedCount(): number {
  return tracked.size;
}

/**
 * Signal a child's whole process group, falling back to the bare pid.
 *
 * A negative pid targets the process group whose id equals that pid. Such a
 * group exists only if the child is its own leader -- which spawnTracked
 * guarantees (detached) and which is also true of Puppeteer's Chromium. If it
 * is not a leader there is no group with that id, the call throws ESRCH, and
 * the plain pid kill covers it. So this can never hit an unrelated group.
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); return; } catch { /* no such group */ }
  try { child.kill(signal); } catch { /* already gone */ }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Kill a child for good: SIGTERM its group, then SIGKILL after a grace period,
 * WAITING for it to actually die and reporting loudly if it does not.
 * Idempotent, and safe to call on an already-dead child.
 */
export async function killChild(
  child: ChildProcess | null | undefined,
  label: string,
  graceMs = TERM_GRACE_MS,
): Promise<void> {
  if (!child || !child.pid) return;
  const pid = child.pid;

  if (hasExited(child)) {
    tracked.delete(pid);
    return;
  }

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    // Hard cap, so a wedged child can never stall teardown indefinitely.
    setTimeout(resolve, graceMs + 3000);
  });

  signalChild(child, 'SIGTERM');
  const escalate = setTimeout(() => {
    console.error(`[Reaper] ${label} (pid ${pid}) ignored SIGTERM after ${graceMs}ms — escalating to SIGKILL`);
    signalChild(child, 'SIGKILL');
  }, graceMs);

  await closed;
  clearTimeout(escalate);

  if (!hasExited(child)) {
    // This is the exact condition that produced the leaked-process pileup.
    console.error(`[Reaper] LEAK: ${label} (pid ${pid}) is STILL ALIVE after SIGKILL`);
  }
  tracked.delete(pid);
}

/** Kill every tracked child and wait for each to die. */
export async function killAllTracked(reason: string): Promise<void> {
  const list = Array.from(tracked.values());
  if (list.length === 0) return;
  console.log(`[Reaper] Killing ${list.length} tracked child process(es): ${reason}`);
  await Promise.all(list.map((t) => killChild(t.child, t.label)));
  tracked.clear();
}

/** Synchronous best-effort kill for the 'exit' hook, where promises cannot run. */
export function killAllTrackedSync(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const { child, pid } of tracked.values()) {
    try { process.kill(-pid, signal); } catch { /* no group */ }
    try { child.kill(signal); } catch { /* already gone */ }
  }
  tracked.clear();
}

export interface FfmpegProcess {
  pid: number;
  ageSec: number;
  comm: string;
  args: string;
}

function runPs(cols: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', cols, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err || !stdout ? null : stdout);
    });
  });
}

/** Parse the portable `etime` column: [[dd-]hh:]mm:ss */
function parseEtime(v: string): number {
  const [daysPart, clockPart] = v.includes('-') ? v.split('-') : ['0', v];
  let sec = 0;
  for (const part of clockPart.split(':')) sec = sec * 60 + (Number(part) || 0);
  return sec + (Number(daysPart) || 0) * 86400;
}

function isFfmpeg(comm: string, args: string): boolean {
  // comm catches the normal case. Matching args as well catches an ffmpeg
  // invoked through a wrapper or with a truncated/renamed comm.
  return /ffmpeg/i.test(comm) || /(^|[/\s])ffmpeg(\s|$)/i.test(args);
}

/**
 * Every running process that looks like ffmpeg, as pid/age/comm/args.
 *
 * Preferred form is `ps -eo pid,etimes,comm,args` (procps -- the Linux VPS).
 * `etimes` does not exist in BSD ps, where it fails outright, so fall back to
 * parsing the portable `etime` column rather than silently reporting nothing
 * and thereby disabling the watchdog.
 */
export async function listFfmpegProcesses(): Promise<FfmpegProcess[]> {
  const rows = (text: string, ageOf: (v: string) => number) =>
    text
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a.length >= 3)
      .map((a) => ({
        pid: Number(a[0]),
        ageSec: ageOf(a[1]),
        comm: a[2],
        args: a.slice(3).join(' '),
      }))
      .filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ageSec))
      .filter((r) => r.pid !== process.pid && isFfmpeg(r.comm, r.args));

  const withEt = await runPs(['-eo', 'pid,etimes,comm,args']);
  if (withEt) {
    const parsed = rows(withEt, Number);
    // A usable etimes column parses every age as a number.
    if (parsed.length > 0) return parsed;
  }

  const portable = await runPs(['-eo', 'pid,etime,comm,args']);
  return portable ? rows(portable, parseEtime) : [];
}

/**
 * One watchdog pass: log every ffmpeg process (the `ps ... | grep ffmpeg` the
 * operator asked for) and SIGKILL any that PREDATES the current session, i.e.
 * that cannot belong to live work.
 *
 * Only the pid is killed here, not a group: these are processes we never
 * spawned, so their group is unknown and could contain unrelated processes.
 */
export async function runFfmpegSweep(): Promise<number> {
  const rows = await listFfmpegProcesses();

  if (rows.length === 0) {
    console.log('[Reaper:watchdog] ps -eo pid,etimes,comm | grep ffmpeg: (none)');
    return 0;
  }

  for (const r of rows) {
    console.log(
      `[Reaper:watchdog] ffmpeg pid=${r.pid} age=${r.ageSec}s comm=${r.comm} args=${r.args.slice(0, 80)}`,
    );
  }

  const cutoff = watchdogCutoff();
  let killed = 0;
  for (const r of rows) {
    if (isTracked(r.pid)) continue; // ours, and newer than the cutoff
    const startedAt = Date.now() - r.ageSec * 1000;
    if (startedAt >= cutoff - WATCHDOG_SLACK_MS) continue; // belongs to the live session

    console.error(
      `[Reaper:watchdog] ORPHAN ffmpeg pid=${r.pid} age=${r.ageSec}s predates the current session by ` +
      `${Math.round((cutoff - startedAt) / 1000)}s — SIGKILL`,
    );
    try { process.kill(r.pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  return killed;
}

/** Start the periodic sweep. Returns the timer so callers can stop it. */
export function startFfmpegWatchdog(intervalMs = WATCHDOG_INTERVAL_MS): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runFfmpegSweep().catch((e) => console.error('[Reaper:watchdog] sweep failed:', e));
  }, intervalMs);
  // The watchdog must never be the reason the process stays alive.
  timer.unref?.();
  console.log(`[Reaper] ffmpeg watchdog started (every ${intervalMs}ms)`);
  return timer;
}


