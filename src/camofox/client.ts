import type { AppConfig } from "../config.js";
import type {
  CamofoxHealth,
  CamofoxTab,
  CreateTabInput,
  DisplayMode,
  DisplayResult,
} from "./types.js";

export class CamofoxRequestError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "CamofoxRequestError";
  }
}

export class CamofoxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  public constructor(config: AppConfig) {
    this.baseUrl = config.camofoxUrl;
    this.apiKey = config.camofoxApiKey;
    this.timeoutMs = config.requestTimeoutMs;
  }

  public async health(): Promise<CamofoxHealth> {
    const raw = await this.request("/health", { method: "GET" });
    const object = asObject(raw);
    return {
      ok: object?.ok === true,
      ...(typeof object?.engine === "string" ? { engine: object.engine } : {}),
      ...(typeof object?.browserConnected === "boolean"
        ? { browserConnected: object.browserConnected }
        : {}),
      raw,
    };
  }

  public async createTab(input: CreateTabInput): Promise<CamofoxTab> {
    const raw = await this.request("/tabs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return normalizeTab(raw);
  }

  public async listTabs(userId: string): Promise<CamofoxTab[]> {
    const raw = await this.request(`/tabs?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
    });
    return tabCandidates(raw).map(normalizeTab);
  }

  public async closeTab(userId: string, tabId: string): Promise<void> {
    await this.request(`/tabs/${encodeURIComponent(tabId)}`, {
      method: "DELETE",
      body: JSON.stringify({ userId }),
    });
  }

  public async closeSession(userId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  public async toggleDisplay(userId: string, mode: DisplayMode): Promise<DisplayResult> {
    const raw = await this.request(
      `/sessions/${encodeURIComponent(userId)}/toggle-display`,
      {
        method: "POST",
        body: JSON.stringify({ headless: mode }),
      },
    );
    const object = asObject(raw);
    return {
      ok: object?.ok === true,
      mode,
      ...(typeof object?.vncUrl === "string" ? { vncUrl: object.vncUrl } : {}),
      ...(typeof object?.message === "string" ? { message: object.message } : {}),
      raw,
    };
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.apiKey !== undefined) headers.set("authorization", `Bearer ${this.apiKey}`);

    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new CamofoxRequestError(
          `Camofox request failed: ${init.method ?? "GET"} ${pathname} (${response.status})`,
          response.status,
          text.slice(0, 2_000),
        );
      }
      if (text.trim() === "") return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new CamofoxRequestError(
          `Camofox returned invalid JSON for ${init.method ?? "GET"} ${pathname}`,
          response.status,
          text.slice(0, 2_000),
        );
      }
    } catch (error) {
      if (error instanceof CamofoxRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new CamofoxRequestError(`Camofox request timed out after ${this.timeoutMs} ms`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new CamofoxRequestError(`Cannot reach Camofox at ${this.baseUrl}: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringProperty(
  object: Record<string, unknown> | undefined,
  names: readonly string[],
): string | undefined {
  if (!object) return undefined;
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeTab(value: unknown): CamofoxTab {
  const outer = asObject(value);
  const nested = asObject(outer?.tab) ?? asObject(outer?.data) ?? outer;
  const id =
    stringProperty(nested, ["id", "tabId", "targetId"]) ??
    stringProperty(outer, ["id", "tabId", "targetId"]);
  if (!id) throw new CamofoxRequestError("Camofox tab response does not contain a tab id");
  const url = stringProperty(nested, ["url"]);
  const title = stringProperty(nested, ["title"]);
  return {
    id,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    raw: value,
  };
}

function tabCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const outer = asObject(value);
  if (!outer) return [];
  for (const key of ["tabs", "targets", "items"]) {
    const candidate = outer[key];
    if (Array.isArray(candidate)) return candidate;
  }
  const data = asObject(outer.data);
  if (Array.isArray(data?.tabs)) return data.tabs;
  return [];
}
