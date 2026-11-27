import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { attach, detach, LOCK_ATTEMPTS, lockDecision, lockPath, otherRefs, refsDir, withSessionLock } from "./refs.js";

const HOME = "/home/dev";
const SESSION = "sol-repo-1234abcd";
const REFS = `${HOME}/.local/state/sol/sessions/${SESSION}`;
const LOCK = `${HOME}/.local/state/sol/sessions/${SESSION}.lock`;

/** `ps -p <pid>`: alive for the pids listed, gone for the rest. */
function alive(...pids: number[]) {
  return (argv: string[]) => {
    if (argv[0] !== "ps") {
      return undefined;
    }
    return pids.includes(Number(argv[2])) ? { stdout: `${argv[2]}\n` } : { code: 1 };
  };
}

describe("paths", () => {
  it("should keep the refs and the lock in sol's state directory", () => {
    // Act / Assert
    expect(refsDir({ HOME }, SESSION)).toBe(REFS);
    expect(lockPath({ HOME }, SESSION)).toBe(LOCK);
  });
});

describe("lockDecision", () => {
  it.each<[string, number | null, boolean | null, "wait" | "break"]>([
    ["an unreadable lock", null, null, "wait"],
    ["a live holder", 7, true, "wait"],
    ["a holder that cannot be asked about", 7, null, "wait"],
    ["a dead holder", 7, false, "break"]
  ])("should decide on %s", (_name, holder, isAlive, expected) => {
    // Act / Assert
    expect(lockDecision({ holder, alive: isAlive })).toBe(expected);
  });
});

describe("otherRefs", () => {
  it("should keep the other pids, sorted, and nothing that is not one", () => {
    // Act / Assert
    expect(otherRefs(["30", "4242", "x", "0", "-1", "10", "1.5"], 4242)).toEqual([10, 30]);
  });
});

describe("withSessionLock", () => {
  it("should hold the lock for the duration and release it after", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });
    let heldDuring: string | undefined;

    // Act
    const result = await withSessionLock(seams, SESSION, async () => {
      heldDuring = seams.fs.store.get(LOCK);
      return "done";
    });

    // Assert
    expect(result).toBe("done");
    expect(heldDuring).toBe("4242\n");
    expect(seams.fs.store.has(LOCK)).toBe(false);
  });

  it("should release the lock when the work throws", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act / Assert
    await expect(withSessionLock(seams, SESSION, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(seams.fs.store.has(LOCK)).toBe(false);
  });

  it("should break a lock whose holder is gone", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_VERBOSE: "1" }, files: { [LOCK]: "99\n" }, respond: alive() });

    // Act
    await withSessionLock(seams, SESSION, async () => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("pid 99");
  });

  it("should wait for a live holder and give up eventually", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [LOCK]: "99\n" }, respond: alive(99) });

    // Act / Assert
    await expect(withSessionLock(seams, SESSION, async () => undefined)).rejects.toThrow(`remove ${LOCK} if nothing is`);
    expect(seams.runner.calls).toHaveLength(LOCK_ATTEMPTS);
  });

  it("should wait for an unreadable lock without asking about any pid", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [LOCK]: "" } });

    // Act / Assert
    await expect(withSessionLock(seams, SESSION, async () => undefined)).rejects.toThrow("for too long");
    expect(seams.runner.calls).toHaveLength(0);
  });
});

describe("attach and detach", () => {
  it("should record this process and drop it again", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    await attach(seams, SESSION);
    const attached = seams.fs.store.has(`${REFS}/4242`);
    const { othersAttached } = await detach(seams, SESSION);

    // Assert
    expect(attached).toBe(true);
    expect(othersAttached).toBe(false);
    expect(seams.fs.store.has(`${REFS}/4242`)).toBe(false);
  });

  it("should say another terminal is attached while its process lives", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [`${REFS}/4242`]: "", [`${REFS}/77`]: "" }, respond: alive(77) });

    // Act / Assert
    expect(await detach(seams, SESSION)).toEqual({ othersAttached: true });
  });

  it("should count a terminal it cannot ask about as attached", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [`${REFS}/77`]: "" } });

    // Act / Assert
    expect(await detach(seams, SESSION)).toEqual({ othersAttached: true });
  });

  it("should clear the refs of processes that died without detaching", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [`${REFS}/4242`]: "", [`${REFS}/77`]: "" }, respond: alive() });

    // Act
    const { othersAttached } = await detach(seams, SESSION);

    // Assert
    expect(othersAttached).toBe(false);
    expect(seams.fs.store.has(`${REFS}/77`)).toBe(false);
  });
});
