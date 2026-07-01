import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock } from "./lock.js";

const tmp = () => path.join(os.tmpdir(), `campaign-lock-${process.pid}-${Math.random()}.lock`);

describe("acquireRunLock — single-writer campaign guard", () => {
  const made: string[] = [];
  const p = () => {
    const f = tmp();
    made.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of made) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    made.length = 0;
  });

  it("acquires when free and writes our pid", () => {
    const lp = p();
    const release = acquireRunLock(lp);
    expect(release).toBeTypeOf("function");
    expect(fs.readFileSync(lp, "utf8")).toContain(String(process.pid));
    release?.();
    expect(fs.existsSync(lp)).toBe(false);
  });

  it("blocks a second acquire while a LIVE pid holds it", () => {
    const lp = p();
    // simulate a live holder = THIS process (pidAlive→true), different-pid branch is
    // covered by writing our own pid then checking a re-acquire is refused... but our
    // own pid is allowed to re-take (idempotent). Use a definitely-live foreign pid: 1.
    fs.writeFileSync(lp, `1 ${new Date().toISOString()}\n`);
    expect(acquireRunLock(lp)).toBeNull();
  });

  it("takes over a STALE lock (holder pid dead)", () => {
    const lp = p();
    fs.writeFileSync(lp, `999999999 ${new Date().toISOString()}\n`); // no such pid
    const release = acquireRunLock(lp);
    expect(release).toBeTypeOf("function");
    expect(fs.readFileSync(lp, "utf8")).toContain(String(process.pid));
    release?.();
  });
});
