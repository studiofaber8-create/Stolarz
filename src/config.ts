import path from "node:path";

export type LlmApiFormat = "anthropic" | "openai-compatible";

export interface LlmConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly format: LlmApiFormat;
  readonly timeoutMs: number;
  readonly anthropicVersion: string;
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

function parsedUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function normalizedUrl(name: string, value: string): string {
  const url = parsedUrl(name, value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString().replace(/\/$/, "");
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
  return {
    apiUrl: normalizedSecretUrl("LLM_API_URL", apiUrl),
    apiKey,
    model: optional(env.LLM_MODEL) ?? "claude-opus-4-8",
    format,
    timeoutMs: positiveInteger("LLM_REQUEST_TIMEOUT_MS", env.LLM_REQUEST_TIMEOUT_MS, 120_000),
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
    camofoxUrl: normalizedUrl("CAMOFOX_URL", env.CAMOFOX_URL ?? "http://127.0.0.1:9377"),
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
  };

  return {
    ...result,
    ...(apiKey === undefined ? {} : { camofoxApiKey: apiKey }),
    ...(panelApiToken === undefined ? {} : { panelApiToken }),
    ...(llm === undefined ? {} : { llm }),
  };
}
