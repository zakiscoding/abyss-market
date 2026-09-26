import type { AbyssEvent, ClientMsg } from "../contract";
import type { EventSource } from "./types";

// Backoff 1s, 2s, 4s, then keep retrying every 4s so a restarted backend
// reconnects on its own during a demo.
const MAX_DELAY_MS = 4000;

export class WsSource implements EventSource {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: number | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onConnection: (connected: boolean) => void,
  ) {}

  start(onEvent: (event: AbyssEvent) => void): void {
    this.stop();
    this.stopped = false;
    this.connect(onEvent);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  send(message: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private connect(onEvent: (event: AbyssEvent) => void): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      this.attempts = 0;
      this.onConnection(true);
    };
    ws.onmessage = (message) => {
      if (this.stopped || this.ws !== ws) return;
      try {
        onEvent(JSON.parse(message.data as string) as AbyssEvent);
      } catch (error) {
        console.error("Bad event from server", error);
      }
    };
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      this.ws = null;
      this.onConnection(false);
      if (this.stopped) return;
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** this.attempts);
      this.attempts += 1;
      this.timer = window.setTimeout(() => this.connect(onEvent), delay);
    };
  }
}
