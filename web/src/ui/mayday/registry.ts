import type { AgentId, Domain } from "../../contract";

export type Availability = "connected" | "simulated" | "unavailable";
export type ProviderId = "anthropic" | "openai" | "google" | "mistral" | "local";

export interface RegistryModel {
  id: string;
  provider: ProviderId;
  modelId: string;
  agentId: AgentId | null;
  displayName: string;
  domains: Domain[];
  capabilities: string[];
  inputPerM: number;
  outputPerM: number;
  latencyMs: number;
  contextLimit: number;
  availability: Availability;
  reputation: number;
  validationRate: number;
}

export interface Quote {
  id: string;
  usd: number;
  quality: number;
  reputation: number;
}

export interface RankedModel {
  model: RegistryModel;
  estimatedUsd: number;
  qualified: boolean;
  reason: string;
}

const DOMAINS: Domain[] = ["database", "networking", "security", "payments", "generalist"];
const CAPABILITIES = ["diagnosis", "failover", "routing", "access-control", "checkout"];

const CATALOG: Omit<RegistryModel, "availability">[] = [
  {
    id: "anthropic:haiku",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    agentId: "haiku",
    displayName: "Claude Haiku",
    domains: DOMAINS,
    capabilities: CAPABILITIES,
    inputPerM: 1,
    outputPerM: 5,
    latencyMs: 900,
    contextLimit: 200_000,
    reputation: 1,
    validationRate: 0.9,
  },
  {
    id: "anthropic:sonnet",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    agentId: "sonnet",
    displayName: "Claude Sonnet",
    domains: DOMAINS,
    capabilities: CAPABILITIES,
    inputPerM: 2,
    outputPerM: 10,
    latencyMs: 1400,
    contextLimit: 200_000,
    reputation: 1,
    validationRate: 0.93,
  },
  {
    id: "anthropic:opus",
    provider: "anthropic",
    modelId: "claude-opus-5",
    agentId: "opus",
    displayName: "Claude Opus",
    domains: DOMAINS,
    capabilities: CAPABILITIES,
    inputPerM: 5,
    outputPerM: 25,
    latencyMs: 2200,
    contextLimit: 200_000,
    reputation: 1,
    validationRate: 0.96,
  },
  {
    id: "openai:gpt-4.1-mini",
    provider: "openai",
    modelId: "gpt-4.1-mini",
    agentId: null,
    displayName: "GPT-4.1 mini",
    domains: DOMAINS,
    capabilities: CAPABILITIES,
    inputPerM: 0.4,
    outputPerM: 1.6,
    latencyMs: 800,
    contextLimit: 128_000,
    reputation: 0,
    validationRate: 0,
  },
  {
    id: "google:gemini-flash",
    provider: "google",
    modelId: "gemini-2.5-flash",
    agentId: null,
    displayName: "Gemini Flash",
    domains: DOMAINS,
    capabilities: CAPABILITIES,
    inputPerM: 0.15,
    outputPerM: 0.6,
    latencyMs: 700,
    contextLimit: 1_000_000,
    reputation: 0,
    validationRate: 0,
  },
  {
    id: "mistral:small",
    provider: "mistral",
    modelId: "mistral-small",
    agentId: null,
    displayName: "Mistral Small",
    domains: DOMAINS,
    capabilities: ["diagnosis"],
    inputPerM: 0.1,
    outputPerM: 0.3,
    latencyMs: 700,
    contextLimit: 128_000,
    reputation: 0,
    validationRate: 0,
  },
  {
    id: "local:oss",
    provider: "local",
    modelId: "local-oss",
    agentId: null,
    displayName: "Local open model",
    domains: ["generalist"],
    capabilities: ["diagnosis"],
    inputPerM: 0,
    outputPerM: 0,
    latencyMs: 400,
    contextLimit: 32_000,
    reputation: 0,
    validationRate: 0,
  },
];

const REQUIRED: Record<Domain, string> = {
  database: "failover",
  networking: "routing",
  security: "access-control",
  payments: "checkout",
  generalist: "diagnosis",
};

const THRESHOLD: Record<string, { quality: number; reputation: number; validation: number }> = {
  "SEV-1": { quality: 8, reputation: 0.8, validation: 0.85 },
  "SEV-2": { quality: 7, reputation: 0.7, validation: 0.7 },
  "SEV-3": { quality: 6, reputation: 0.5, validation: 0.5 },
  "SEV-4": { quality: 4, reputation: 0, validation: 0 },
};

export function estimateUsd(model: Pick<RegistryModel, "inputPerM" | "outputPerM">, inputTokens = 800, outputTokens = 400): number {
  return (inputTokens * model.inputPerM + outputTokens * model.outputPerM) / 1_000_000;
}

/** Anthropic is the only adapter in this build. Connected only while the server is in live mode. */
export function modelRegistry(mode: string): RegistryModel[] {
  const anthropic: Availability = mode === "live" ? "connected" : "simulated";
  return CATALOG.map((model) => ({
    ...model,
    availability: model.provider === "anthropic" ? anthropic : "unavailable",
  }));
}

export function cheapestQualified(input: {
  domain: Domain;
  severity: string;
  models: RegistryModel[];
  quotes?: Quote[];
}): { selected: RankedModel | null; ranking: RankedModel[] } {
  const bar = THRESHOLD[input.severity] ?? THRESHOLD["SEV-4"];
  const need = REQUIRED[input.domain];
  const quotes = new Map((input.quotes ?? []).map((quote) => [quote.id, quote]));
  const ranking = input.models
    .map((model): RankedModel => {
      const quote = quotes.get(model.id);
      const estimatedUsd = quote?.usd ?? estimateUsd(model);
      if (model.availability === "unavailable") {
        return { model, estimatedUsd, qualified: false, reason: "No working adapter" };
      }
      if (!model.domains.includes(input.domain) || !model.capabilities.includes(need)) {
        return { model, estimatedUsd, qualified: false, reason: `Missing ${need}` };
      }
      const quality = quote?.quality ?? model.validationRate * 10;
      const reputation = quote?.reputation ?? model.reputation;
      const validation = model.validationRate;
      if (quality < bar.quality || reputation < bar.reputation || validation < bar.validation) {
        return {
          model,
          estimatedUsd,
          qualified: false,
          reason: `Below the ${input.severity} bar (quality ${quality.toFixed(1)}, reputation ${reputation.toFixed(2)})`,
        };
      }
      return {
        model,
        estimatedUsd,
        qualified: true,
        reason: `Lowest catalog cost that clears the ${input.severity} reliability bar`,
      };
    })
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.estimatedUsd - b.estimatedUsd);

  const qualified = ranking.filter((row) => row.qualified);
  const selected = qualified[0] ?? null;
  if (selected) {
    selected.reason = `Selected as the lowest-cost model meeting the ${input.severity} reliability requirement`;
  }
  return { selected, ranking };
}

/** Deterministic automatic choice: eliminate every non-qualified model, then
 * choose the lowest-cost survivor. Ties are stable in catalog order. */
export function chooseAutomaticModel(input: Parameters<typeof cheapestQualified>[0]): {
  selected: RankedModel | null;
  eligible: RankedModel[];
  eliminated: RankedModel[];
} {
  const { selected, ranking } = cheapestQualified(input);
  return {
    selected,
    eligible: ranking.filter((row) => row.qualified),
    eliminated: ranking.filter((row) => !row.qualified),
  };
}
