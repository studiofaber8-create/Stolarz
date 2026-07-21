import path from "node:path";

export type LlmApiFormat = "anthropic" | "openai-compatible";

export interface LlmConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly format: LlmApiFormat;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly anthropicVersion: string;
}

export interface AgentConfig {
  readonly workerEnabled: boolean;
  readonly schedulerIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly reviewThreshold: number;
  readonly llmDailyTokenBudget: number;
  readonly llmScanTokenBudget: number;
  readonly llmRunMaxAttempts: number;
  readonly businessDescription: string;
}

export interface AppConfig {
  readonly camofoxUrl: string;
  readonly camofoxApiKey?: string;
  readonly requestTimeoutMs: number;
  readonly dataDir: string;
  readonly profilePrefix: string;
  readonly facebookHomeUrl: string;
  readonly panelHost: string;
  readonly panelPort: number;
  readonly panelApiToken?: string;
  readonly llm?: LlmConfig;
  readonly agent: AgentConfig;
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function rangedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = positiveInteger(name, value, fallback, maximum);
  if (parsed < minimum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function parsedUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function normalizedFacebookUrl(value: string): string {
  const url = parsedUrl("FACEBOOK_HOME_URL", value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) {
    throw new Error("FACEBOOK_HOME_URL must use HTTPS and belong to facebook.com");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizedSecretUrl(name: string, value: string): string {
  const url = parsedUrl(name, value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateHost(url.hostname))) {
    throw new Error(`${name} must use HTTPS unless it targets a local/private service`);
  }
  return url.toString().replace(/\/$/, "");
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    !host.includes(".")
  );
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanValue(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function decimalValue(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function agentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  return {
    workerEnabled: booleanValue("AGENT_WORKER_ENABLED", env.AGENT_WORKER_ENABLED, true),
    schedulerIntervalMs: positiveInteger(
      "AGENT_SCHEDULER_INTERVAL_MS",
      env.AGENT_SCHEDULER_INTERVAL_MS,
      30_000,
    ),
    pollIntervalMs: positiveInteger("AGENT_WORKER_POLL_MS", env.AGENT_WORKER_POLL_MS, 1_000),
    leaseMs: rangedInteger(
      "AGENT_JOB_LEASE_MS",
      env.AGENT_JOB_LEASE_MS,
      180_000,
      3_000,
      3_600_000,
    ),
    reviewThreshold: decimalValue(
      "AGENT_REVIEW_THRESHOLD",
      env.AGENT_REVIEW_THRESHOLD,
      0.8,
      0,
      1,
    ),
    llmDailyTokenBudget: positiveInteger(
      "AGENT_LLM_DAILY_TOKEN_BUDGET",
      env.AGENT_LLM_DAILY_TOKEN_BUDGET,
      200_000,
      100_000_000,
    ),
    llmScanTokenBudget: positiveInteger(
      "AGENT_LLM_SCAN_TOKEN_BUDGET",
      env.AGENT_LLM_SCAN_TOKEN_BUDGET,
      25_000,
      10_000_000,
    ),
    llmRunMaxAttempts: rangedInteger(
      "AGENT_LLM_RUN_MAX_ATTEMPTS",
      env.AGENT_LLM_RUN_MAX_ATTEMPTS,
      3,
      1,
      10,
    ),
    businessDescription:
      optional(env.AGENT_BUSINESS_DESCRIPTION) ??
      "Wykonujemy meble i zabudowy na wymiar: kuchnie, szafy, garderoby i zabudowy stolarskie.",
  };
}

function llmConfig(env: NodeJS.ProcessEnv): LlmConfig | undefined {
  const apiUrl = optional(env.LLM_API_URL);
  const apiKey = optional(env.LLM_API_KEY);
  if ((apiUrl === undefined) !== (apiKey === undefined)) {
    throw new Error("LLM_API_URL and LLM_API_KEY must be configured together");
  }
  if (apiUrl === undefined || apiKey === undefined) return undefined;

  const format = optional(env.LLM_API_FORMAT) ?? "anthropic";
  if (format !== "anthropic" && format !== "openai-compatible") {
    throw new Error("LLM_API_FORMAT must be anthropic or openai-compatible");
  }
  const retryBaseMs = positiveInteger("LLM_RETRY_BASE_MS", env.LLM_RETRY_BASE_MS, 500, 60_000);
  const retryMaxMs = positiveInteger("LLM_RETRY_MAX_MS", env.LLM_RETRY_MAX_MS, 10_000, 300_000);
  if (retryMaxMs < retryBaseMs) {
    throw new Error("LLM_RETRY_MAX_MS must be greater than or equal to LLM_RETRY_BASE_MS");
  }
  return {
    apiUrl: normalizedSecretUrl("LLM_API_URL", apiUrl),
    apiKey,
    model: optional(env.LLM_MODEL) ?? "claude-opus-4-8",
    format,
    timeoutMs: positiveInteger("LLM_REQUEST_TIMEOUT_MS", env.LLM_REQUEST_TIMEOUT_MS, 120_000),
    maxAttempts: rangedInteger("LLM_RETRY_MAX_ATTEMPTS", env.LLM_RETRY_MAX_ATTEMPTS, 3, 1, 10),
    retryBaseMs,
    retryMaxMs,
    anthropicVersion: optional(env.LLM_ANTHROPIC_VERSION) ?? "2023-06-01",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const panelHost = optional(env.PANEL_HOST) ?? "127.0.0.1";
  const panelApiToken = optional(env.PANEL_API_TOKEN);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!localHosts.has(panelHost) && panelApiToken === undefined) {
    throw new Error("PANEL_API_TOKEN is required when PANEL_HOST is not local");
  }

  const apiKey = optional(env.CAMOFOX_API_KEY);
  const llm = llmConfig(env);
  const profilePrefix = optional(env.AGENT_PROFILE_PREFIX) ?? "stolarz-fb";
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(profilePrefix)) {
    throw new Error("AGENT_PROFILE_PREFIX may only contain letters, digits, underscores and hyphens");
  }

  const result: AppConfig = {
    camofoxUrl: normalizedSecretUrl(
      "CAMOFOX_URL",
      env.CAMOFOX_URL ?? "http://127.0.0.1:9377",
    ),
    requestTimeoutMs: positiveInteger(
      "CAMOFOX_REQUEST_TIMEOUT_MS",
      env.CAMOFOX_REQUEST_TIMEOUT_MS,
      30_000,
    ),
    dataDir: path.resolve(env.AGENT_DATA_DIR ?? "./data"),
    profilePrefix,
    facebookHomeUrl: normalizedFacebookUrl(
      env.FACEBOOK_HOME_URL ?? "https://www.facebook.com/",
    ),
    panelHost,
    panelPort: positiveInteger("PANEL_PORT", env.PANEL_PORT, 3_000, 65_535),
    agent: agentConfig(env),
  };

  return {
    ...result,
    ...(apiKey === undefined ? {} : { camofoxApiKey: apiKey }),
    ...(panelApiToken === undefined ? {} : { panelApiToken }),
    ...(llm === undefined ? {} : { llm }),
  };
}
