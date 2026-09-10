/**
 * TEST HARNESS. Emulator plumbing only -- see the banner in `src/screen.ts`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SpeculosScreen } from "../src/screen";

const run = promisify(execFile);

export const SPECULOS_CONTAINER = process.env.PLIMSOLL_SPECULOS_CONTAINER ?? "spec";

export async function requireSpeculos(screen: SpeculosScreen): Promise<void> {
  try {
    await screen.readScreen();
  } catch (error) {
    throw new Error(
      `Speculos is not answering at ${screen.url}. Bring it up with the command in README.md ` +
        `before running the device tests. (${(error as Error).message})`,
    );
  }
}

/**
 * Put the device back on its idle screen.
 *
 * A completed or rejected signature returns there on its own. A *cancelled* one does not: the
 * emulator keeps no notion of a client going away, so a timed-out review sits on screen forever
 * and the next signature request queues behind it. Restarting the container is the only reliable
 * way back, so we do that, but only when the cheap path has already failed.
 */
export async function ensureIdle(screen: SpeculosScreen): Promise<"idle" | "restarted"> {
  if (await screen.waitForIdle(3_000)) return "idle";

  try {
    await run("docker", ["restart", SPECULOS_CONTAINER], { timeout: 60_000 });
  } catch (error) {
    throw new Error(
      `device is stuck on "${await screen.readScreenText().catch(() => "?")}" and restarting ` +
        `container "${SPECULOS_CONTAINER}" failed: ${(error as Error).message}`,
    );
  }

  if (!(await screen.waitForIdle(45_000))) {
    throw new Error(`container "${SPECULOS_CONTAINER}" restarted but never reached the app idle screen`);
  }
  return "restarted";
}

/**
 * Collapse a walk transcript to comparable text.
 *
 * Two pieces of device chrome have to come off first. The screen wraps greedily and splits a
 * field wherever it runs out of room, so all whitespace goes; and the pager label `Message
 * (2/4)` is emitted as part of the screen's own text, right in the middle of the payload, so it
 * goes too. What is left is exactly the bytes that were rendered.
 */
export function squash(transcript: string[]): string {
  return transcript.join(" ").replace(/Message \(\d+\/\d+\)/g, " ").replace(/\s+/g, "");
}

/** JSON.stringify chokes on the bigints a mandate carries; assertion messages should not. */
export function show(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}` : v));
}

export const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
