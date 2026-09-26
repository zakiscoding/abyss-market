import type { AbyssEvent, ClientMsg } from "../contract";
import type { EventSource } from "./types";

type Gate = "start_incident" | "approve_repair";

/** Replays a recorded run. Unless `auto` is set, an incident recording pauses
 *  before the outage until start_incident and after approval_required until
 *  approve_repair, so the presenter drives the demo; reset_incident restarts it. */
export class FixtureSource implements EventSource {
  private active = false;
  private controller: AbortController | null = null;
  private onEvent: ((event: AbyssEvent) => void) | null = null;
  private waiting: { gate: Gate; resolve: () => void } | null = null;

  constructor(
    private readonly url: string,
    private readonly speed: number,
    private readonly auto = false,
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
    this.controller?.abort();
    this.controller = null;
    this.waiting = null;
  }

  send(message: ClientMsg): boolean {
    if (message.type === "reset_incident") {
      if (this.onEvent) this.start(this.onEvent);
      return true;
    }
    if (this.waiting && this.waiting.gate === message.type) {
      this.waiting.resolve();
      this.waiting = null;
      return true;
    }
    return false;
  }

  /** The gate the replay is currently paused at, if any. */
  get pausedAt(): Gate | null {
    return this.waiting?.gate ?? null;
  }

  private gate(gate: Gate, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { gate, resolve };
      signal.addEventListener("abort", () => reject(new DOMException("Replay stopped", "AbortError")), {
        once: true,
      });
    });
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
    for (const event of events) {
      const isOutage = event.type === "incident_status" && event.data.status === "outage";
      if (isOutage && !this.auto) {
        await this.gate("start_incident", signal);
      } else {
        const delay = Math.min(3000, Math.max(0, event.t - previousTime)) / speed;
        await wait(delay, signal);
      }
      previousTime = event.t;
      if (!this.active) return;
      onEvent(event);
      if (event.type === "approval_required" && !this.auto) {
        await this.gate("approve_repair", signal);
        // The recording's approval wait already happened for real.
        const next = events[events.indexOf(event) + 1];
        if (next) previousTime = next.t;
      }
    }
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
