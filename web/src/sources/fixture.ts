import type { AbyssEvent, ClientMsg, ScenarioId } from "../contract";
import type { EventSource } from "./types";

type Gate = "start_incident" | "approve_repair";
type FixtureUrl = string | ((scenario: ScenarioId) => string);
let replayRun = 0;

/** Replays a recorded run. Unless `auto` is set, an incident recording pauses
 *  before incident_received until start_incident and after approval_required
 *  until approve_repair, so the presenter drives the demo. When `url` is a
 *  function, each scenario has its own recording: start_incident for another
 *  scenario loads and plays that one. reset_incident restarts the current one.
 *  Like the server, only one incident runs at a time. */
export class FixtureSource implements EventSource {
  private active = false;
  private controller: AbortController | null = null;
  private onEvent: ((event: AbyssEvent) => void) | null = null;
  private waiting: { gate: Gate; resolve: () => void } | null = null;
  private scenario: ScenarioId;
  private armed = false;
  private running = false;

  constructor(
    private readonly url: FixtureUrl,
    private readonly speed: number,
    private readonly auto = false,
    scenario: ScenarioId = "payments_pool",
  ) {
    this.scenario = scenario;
  }

  start(onEvent: (event: AbyssEvent) => void): void {
    this.stop();
    this.active = true;
    this.onEvent = onEvent;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    void this.replay(onEvent, signal).catch((error: unknown) => {
      if (this.active && !signal.aborted) {
        this.running = false;
        console.error("Fixture replay failed", error);
        onEvent({ v: 1, seq: 0, t: 0, job_id: null, type: "error", data: {
          fatal: true, task_id: null, message: "Could not load this replay. Check the recording URL and try Reset.",
        } });
      }
    });
  }

  stop(): void {
    this.active = false;
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.waiting = null;
  }

  send(message: ClientMsg): boolean {
    if (message.type === "reset_incident") {
      this.armed = false;
      if (this.onEvent) this.start(this.onEvent);
      return true;
    }
    if (message.type === "start_incident") {
      if (this.running || this.armed) return false;
      const next = message.scenario_id ?? this.scenario;
      const sameRecording = typeof this.url === "string" || next === this.scenario;
      if (this.waiting?.gate === "start_incident" && sameRecording) {
        this.running = true;
        this.release();
        return true;
      }
      if (!this.onEvent) return false;
      this.scenario = next;
      this.armed = true;
      this.start(this.onEvent);
      return true;
    }
    if (this.waiting && this.waiting.gate === message.type) {
      this.release();
      return true;
    }
    return false;
  }

  /** The gate the replay is currently paused at, if any. */
  get pausedAt(): Gate | null {
    return this.waiting?.gate ?? null;
  }

  private release(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.resolve();
  }

  private gate(gate: Gate, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("Replay stopped", "AbortError")); return; }
      const abort = () => reject(new DOMException("Replay stopped", "AbortError"));
      this.waiting = { gate, resolve: () => {
        signal.removeEventListener("abort", abort);
        resolve();
      } };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async replay(
    onEvent: (event: AbyssEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const runId = ++replayRun;
    const url = typeof this.url === "string" ? this.url : this.url(this.scenario);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Fixture request failed with ${response.status}`);
    }
    const events = (await response.json()) as AbyssEvent[];
    const speed = Number.isFinite(this.speed) && this.speed > 0 ? this.speed : 1;
    let previousTime = 0;
    for (const [index, event] of events.entries()) {
      if (event.type === "incident_received") {
        if (!this.auto && !this.armed) await this.gate("start_incident", signal);
        this.armed = false;
        this.running = true;
      } else {
        const delay = Math.min(3000, Math.max(0, event.t - previousTime)) / speed;
        await wait(delay, signal);
      }
      previousTime = event.t;
      if (!this.active) return;
      // A replay is a new run even when its recording reuses the original job ID.
      onEvent({ ...event, job_id: event.job_id ? `${event.job_id}-replay-${runId}` : null });
      if ((event.type === "approval_required" || event.type === "notification_status")
        && events[index + 1]?.type !== "notification_status" && !this.auto) {
        await this.gate("approve_repair", signal);
        // The recording's approval wait already happened for real.
        const next = events[index + 1];
        if (next) previousTime = next.t;
      }
    }
    this.running = false;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Replay stopped", "AbortError")); return; }
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Replay stopped", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
