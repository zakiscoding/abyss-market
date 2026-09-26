import { useEffect, useRef, useState } from "react";

import type { ClientMsg } from "./contract";
import { Director } from "./scene/director";
import { MarketScene } from "./scene/Scene";
import { FixtureSource } from "./sources/fixture";
import type { EventSource } from "./sources/types";
import { WsSource } from "./sources/ws";
import type { MarketState } from "./state/reducer";
import { store } from "./state/store";
import { DebugPanel } from "./ui/DebugPanel";
import { Deliverable } from "./ui/Deliverable";
import { JobBar } from "./ui/JobBar";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "ws" ? "ws" : "fixture";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws";
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;

function createSource(): EventSource {
  if (SOURCE === "ws") {
    return new WsSource(WS_URL, (connected) => store.setConnected(connected));
  }
  const file = params.get("file") || "fake_run";
  return new FixtureSource(`/fixtures/${encodeURIComponent(file)}.json`, SPEED);
}

function modeBadge(state: MarketState): { label: string; tone: string } {
  if (SOURCE === "fixture") return { label: "REPLAY", tone: "replay" };
  if (!state.connected) return { label: "OFFLINE", tone: "offline" };
  if (!state.config) return { label: "CONNECTING", tone: "offline" };
  if (state.config.fake_llm) return { label: "FAKE LLM", tone: "fake" };
  if (!state.config.real_models) return { label: "HAIKU TEST MODE", tone: "test" };
  return { label: "LIVE", tone: "live" };
}

export default function MarketApp() {
  const [state, setState] = useState(store.getState());
  const [pending, setPending] = useState(false);
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const [showLedger, setShowLedger] = useState(params.get("ledger") === "1");
  const sourceRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const directorRef = useRef<Director | null>(null);
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    // StrictMode mounts twice in dev: a cancelled mount destroys its own scene.
    let cancelled = false;
    let scene: MarketScene | null = null;
    let unsubscribe = () => {};
    void MarketScene.create(stageRef.current!).then((created) => {
      if (cancelled) {
        created.destroy();
        return;
      }
      scene = created;
      directorRef.current = new Director(created, SPEED);
      if (import.meta.env.DEV) (window as unknown as { __abyss: unknown }).__abyss = { scene: created };
      scene.render(store.getState());
      unsubscribe = store.subscribe(() => scene?.render(store.getState()));
      setSceneReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      directorRef.current?.destroy();
      directorRef.current = null;
      scene?.destroy();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = createSource();
    sourceRef.current = source;
    source.start((event) => {
      // A job has actually started (or been rejected): the Run click is resolved.
      if (event.type === "job_split" || event.type === "error" || event.type === "final") {
        setPending(false);
      }
      store.dispatch(event);
      directorRef.current?.onEvent(event);
    });
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!state.connected) setPending(false);
  }, [state.connected]);

  const send = (message: ClientMsg) => {
    const sent = sourceRef.current?.send?.(message);
    if (sent === false) console.warn("Not connected; message dropped", message);
    return sent !== false;
  };

  const badge = modeBadge(state);
  const busy = pending || state.jobActive;
  const jobId = state.currentJob?.jobId ?? null;
  const showDeliverable = state.final !== null && jobId !== dismissedJob;

  return (
    <main className={`app-shell ${showLedger ? "" : "ledger-hidden"}`}>
      <section className="stage-shell" aria-label="Abyss pixel market">
        <header className="stage-header">
          <strong>ABYSS</strong>
          <div className="header-actions">
            <button type="button" className="ledger-toggle" onClick={() => setShowLedger((v) => !v)}>
              {showLedger ? "Hide ledger" : "Show ledger"}
            </button>
            <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
          </div>
        </header>
        {SOURCE === "ws" && (
          <JobBar
            connected={state.connected}
            busy={busy}
            defaultPriceWeight={state.config?.price_weight ?? 1}
            onRun={(job, priceWeight) => {
              if (send({ type: "start_job", job, price_weight: priceWeight })) setPending(true);
            }}
            onReset={() => send({ type: "reset" })}
          />
        )}
        <div id="stage" ref={stageRef}>
          {!sceneReady && (
            <div className="stage-placeholder">
              <span>ABYSS MARKET</span>
              <small>PIXEL HARBOR INITIALIZING</small>
            </div>
          )}
          {showDeliverable && state.final && (
            <Deliverable
              final={state.final}
              agents={state.agents}
              onClose={() => setDismissedJob(jobId)}
            />
          )}
        </div>
      </section>
      {showLedger && <DebugPanel state={state} />}
    </main>
  );
}
