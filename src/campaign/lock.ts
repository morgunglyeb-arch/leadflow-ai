import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_LOCK = "data/campaign/campaign.lock";

/** Is a process with this pid currently alive? `kill(pid, 0)` throws ESRCH if not,
 * EPERM if it exists but we can't signal it (still alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(p: string): number | null {
  try {
    const first = fs.readFileSync(p, "utf8").trim().split(/\s+/)[0] ?? "";
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire an EXCLUSIVE campaign run-lock. Returns a `release` fn on success, or
 * `null` if another LIVE campaign process already holds it — in which case the
 * caller MUST skip this run.
 *
 * Why this exists: the launchd send cron and a hand-launched run (or two crons that
 * overlap because one lingered in the slow generation tail) can run CONCURRENTLY.
 * Both load the same state.json, both pick the same queued leads, and both call
 * sendEmail → the SAME prospect is emailed twice (observed 2026-07-01: 15 addresses
 * sent 2×), while their interleaved saveState clobber each other (lost updates, so
 * the state under-records what actually went out). A single-writer lock removes both.
 *
 * A stale lock (holder pid is dead — e.g. killed mid-run) is taken over, so a hard
 * kill can never wedge the pipeline shut. If the lock file can't be written at all,
 * we do NOT block the run (fail-open) — availability over the (now rare) overlap.
 */
export function acquireRunLock(lockPath: string = DEFAULT_LOCK): (() => void) | null {
  const existingPid = fs.existsSync(lockPath) ? readLockPid(lockPath) : null;
  if (existingPid && existingPid !== process.pid && pidAlive(existingPid)) {
    return null; // held by a live process → skip this run
  }
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    return () => {}; // can't write the lock → fail-open, run anyway
  }
  return () => {
    try {
      if (readLockPid(lockPath) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      /* best-effort release */
    }
  };
}
