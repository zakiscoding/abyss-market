import type { AbyssEvent, ClientMsg } from "../contract";
import type { EventSource } from "./types";

type Gate = "start_incident" | "approve_repair";

/** Replays a recorded event stream. With `interactive`, an incident replay
 *  behaves like the live backend: it waits for "Break Production" before the
 *  outage, waits for "Approve Repair" after approval_required, and restarts on
 *  reset_incident. Nothing needs the network beyond fetching the file. */
export class FixtureSource implements EventSource {
  private active = false;
  private controller: AbortController | null = null;
  private onEvent: ((event: AbyssEvent) => void) | null = null;
  private waiting: { gate: Gate; resolve: () => void } | null = null;

  constructor(
    private readonly url: string,
    private readonly speed: number,
    private readonly interactive = false,
  ) {}

  start(onEvent: (event: AbyssEvent) => void): void {
    this.stop();
    this.active = true;
    this.onEvent = onEvent;
    this.controller = new AbortController();
    void this.replay(onEvent, this.controller.signal).catch((error: unknown) => {
      if (this.active) {
        console.error("Fixture replay failed", error);
      }
    });
  }

  stop(): void {
    this.active = false;
    this.waiting = null;
    this.controller?.abort();
    this.controller = null;
  }

  send(message: ClientMsg): boolean {
    if (!this.interactive || !this.onEvent) return false;
    if (message.type === "reset_incident") {
      this.start(this.onEvent);
      return true;
    }
    if (this.waiting && this.waiting.gate === message.type) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve();
      return true;
    }
    return false;
  }

  private async replay(
    onEvent: (event: AbyssEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.url, { signal });
    if (!response.ok) {
      throw new Error(`Fixture request failed with ${response.status}`);
    }
    const events = (await response.json()) as AbyssEvent[];
    const speed = Number.isFinite(this.speed) && this.speed > 0 ? this.speed : 1;
    let previousTime = 0;
    let skipDelay = false;
    for (const event of events) {
      const isOutage = event.type === "incident_status" && event.data.status === "outage";
      if (this.interactive && isOutage) {
        await this.gate("start_incident", signal);
        skipDelay = true;
      }
      const delay = skipDelay ? 0 : Math.min(3000, Math.max(0, event.t - previousTime)) / speed;
      skipDelay = false;
      previousTime = event.t;
      await wait(delay, signal);
      if (!this.active) return;
      onEvent(event);
      if (this.interactive && event.type === "approval_required") {
        await this.gate("approve_repair", signal);
        skipDelay = true;
      }
    }
  }

  private gate(gate: Gate, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { gate, resolve };
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Replay stopped", "AbortError")),
        { once: true },
      );
    });
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Replay stopped", "AbortError"));
      },
      { once: true },
    );
  });
}
