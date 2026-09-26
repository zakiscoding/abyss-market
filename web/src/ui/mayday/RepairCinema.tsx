import { useEffect, useState } from "react";
import type { MarketState } from "../../state/reducer";
import { repairShot } from "./repairPhase";

export function useRepairCinema(state: MarketState) {
  const shot = repairShot(state);
  const job = state.incident?.jobId ?? null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const terminalKey = `${job}:${shot}`;
  useEffect(() => {
    if (shot !== "restored" && shot !== "failed") return;
    const timer = window.setTimeout(() => setFinished(terminalKey), 6000);
    return () => window.clearTimeout(timer);
  }, [shot, terminalKey]);
  return {
    shot: job && dismissed !== job && finished !== terminalKey ? shot : null,
    skip: () => setDismissed(job),
  };
}
