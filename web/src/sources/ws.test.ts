import { afterEach, expect, it, vi } from "vitest";
import { WsSource } from "./ws";

class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  close() {}
  send() {}
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Socket.instances = []; });

it("ignores late events from a socket replaced by a restart", () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", Socket);
  const connection = vi.fn();
  const events = vi.fn();
  const source = new WsSource("ws://test", connection);
  source.start(events);
  const old = Socket.instances[0];
  source.start(events);
  const current = Socket.instances[1];
  current.onopen?.();
  old.onclose?.();
  old.onmessage?.({ data: "{}" });
  vi.advanceTimersByTime(5000);
  expect(Socket.instances).toHaveLength(2);
  expect(connection.mock.calls).toEqual([[true]]);
  expect(events).not.toHaveBeenCalled();
  current.onclose?.();
  vi.advanceTimersByTime(1000);
  expect(Socket.instances).toHaveLength(3);
  source.stop();
  Socket.instances[2].onclose?.();
  vi.advanceTimersByTime(10000);
  expect(Socket.instances).toHaveLength(3);
});
