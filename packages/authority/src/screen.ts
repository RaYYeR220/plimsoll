/**
 * TEST AND DEMO HARNESS -- NOT PART OF THE AUTHORITY.
 *
 * This file drives the Speculos emulator's REST API: it reads the screen and presses the
 * buttons. It exists so that CI and the recorded walkthrough can approve or reject a mandate
 * without a human thumb, and so tests can assert on the text the device actually rendered.
 *
 * Nothing in `src/device.ts` imports it and it is deliberately not re-exported from
 * `src/index.ts`. If this file is on your call path in production, you have replaced the human
 * with a loop, which is the exact thing the module exists to prevent.
 */

import { writeFile } from "node:fs/promises";

export type Button = "left" | "right" | "both";

export interface SpeculosScreenOptions {
  url?: string;
  /** Pause after each button press so the emulator has redrawn before the next read. */
  settleMs?: number;
  requestTimeoutMs?: number;
}

export interface WalkResult {
  /** True if `target` appeared within `maxSteps`. */
  found: boolean;
  /** Every distinct screen visited, in order. This is the on-device proof for the tests. */
  transcript: string[];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SpeculosScreen {
  readonly url: string;
  private readonly settleMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: SpeculosScreenOptions = {}) {
    this.url = (options.url ?? process.env.PLIMSOLL_LEDGER_URL ?? "http://127.0.0.1:5000").replace(/\/$/, "");
    this.settleMs = options.settleMs ?? 180;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`speculos ${path} -> ${response.status} ${response.statusText}`);
    }
    return response;
  }

  /** The text lines currently on the device screen, top to bottom. */
  async readScreen(): Promise<string[]> {
    const response = await this.request("/events?currentscreenonly=true");
    const body = (await response.json()) as { events?: Array<{ text?: string }> };
    return (body.events ?? []).map((event) => event.text ?? "").filter((text) => text.length > 0);
  }

  /** The same screen flattened, which is what assertions and transcripts want. */
  async readScreenText(): Promise<string> {
    return (await this.readScreen()).join(" ");
  }

  async press(button: Button): Promise<void> {
    await this.request(`/button/${button}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "press-and-release" }),
    });
    await delay(this.settleMs);
  }

  async screenshot(): Promise<Buffer> {
    const response = await this.request("/screenshot");
    return Buffer.from(await response.arrayBuffer());
  }

  async saveScreenshot(path: string): Promise<string> {
    await writeFile(path, await this.screenshot());
    return path;
  }

  /**
   * Page right until `target` shows up, then press both buttons to activate it.
   *
   * Pressing right on the last screen of a Ledger review flow wraps around, so a target that
   * never matches costs `maxSteps` presses and then reports `found: false` -- it does not hang
   * and it does not accidentally confirm something else.
   */
  async walkTo(
    target: string | RegExp,
    options: { maxSteps?: number; confirm?: boolean } = {},
  ): Promise<WalkResult> {
    const maxSteps = options.maxSteps ?? 40;
    const confirm = options.confirm ?? true;
    const matches = (text: string) =>
      typeof target === "string" ? text.toLowerCase().includes(target.toLowerCase()) : target.test(text);

    const transcript: string[] = [];
    for (let step = 0; step < maxSteps; step += 1) {
      const text = await this.readScreenText();
      if (transcript[transcript.length - 1] !== text) transcript.push(text);
      if (matches(text)) {
        if (confirm) await this.press("both");
        return { found: true, transcript };
      }
      await this.press("right");
    }
    return { found: false, transcript };
  }

  /** Walk the review flow and approve. Returns the screens the device showed on the way. */
  async approve(options: { maxSteps?: number } = {}): Promise<WalkResult> {
    return this.walkTo("Sign message", options);
  }

  /** Walk the review flow and decline. This is what produces 6985. */
  async reject(options: { maxSteps?: number } = {}): Promise<WalkResult> {
    return this.walkTo("Reject", options);
  }

  /** Poll until the Ethereum app is back at its idle screen, or give up. */
  async waitForIdle(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await this.readScreenText().catch(() => "");
      if (/app is ready/i.test(text)) return true;
      await delay(250);
    }
    return false;
  }
}
