import type { AppConfig } from "../config.js";
import type {
  CamofoxHealth,
  CamofoxPageError,
  CamofoxTab,
  CreateTabInput,
  DisplayMode,
  DisplayResult,
  EvaluationResult,
  InteractionTarget,
  NavigationResult,
  ScrollInput,
  SnapshotResult,
  WaitInput,
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
    const raw = await this.requestJson("/health", { method: "GET" });
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
    const raw = await this.requestJson("/tabs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return normalizeTab(raw);
  }

  public async listTabs(userId: string): Promise<CamofoxTab[]> {
    const raw = await this.requestJson(`/tabs?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
    });
    return tabCandidates(raw).map(normalizeTab);
  }

  public async navigate(userId: string, tabId: string, url: string): Promise<NavigationResult> {
    const raw = await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: "POST",
      body: JSON.stringify({ userId, url }),
    });
    const object = asObject(raw);
    return {
      ok: object?.ok !== false,
      ...(typeof object?.url === "string" ? { url: object.url } : {}),
      raw,
    };
  }

  public async snapshot(userId: string, tabId: string, offset = 0): Promise<SnapshotResult> {
    const query = new URLSearchParams({ userId, offset: String(offset) });
    const raw = await this.requestJson(
      `/tabs/${encodeURIComponent(tabId)}/snapshot?${query.toString()}`,
      { method: "GET" },
    );
    const object = asObject(raw);
    const text = stringProperty(object, ["snapshot", "text", "content"]);
    if (text === undefined) {
      throw new CamofoxRequestError("Camofox snapshot response does not contain snapshot text");
    }
    const nextOffset = numberProperty(object, ["nextOffset", "next_offset"]);
    return {
      text,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      raw,
    };
  }

  public async wait(userId: string, tabId: string, input: WaitInput = {}): Promise<void> {
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/wait`, {
      method: "POST",
      body: JSON.stringify({ userId, ...input }),
    });
  }

  public async click(
    userId: string,
    tabId: string,
    target: InteractionTarget,
  ): Promise<void> {
    assertTarget(target);
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/click`, {
      method: "POST",
      body: JSON.stringify({ userId, ...target }),
    });
  }

  public async type(
    userId: string,
    tabId: string,
    target: InteractionTarget,
    text: string,
  ): Promise<void> {
    assertTarget(target);
    if (text.length === 0) throw new Error("Typed text cannot be empty");
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/type`, {
      method: "POST",
      body: JSON.stringify({ userId, ...target, text }),
    });
  }

  public async press(userId: string, tabId: string, key: string): Promise<void> {
    if (key.trim() === "") throw new Error("Pressed key cannot be empty");
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/press`, {
      method: "POST",
      body: JSON.stringify({ userId, key }),
    });
  }

  public async scroll(userId: string, tabId: string, input: ScrollInput): Promise<void> {
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/scroll`, {
      method: "POST",
      body: JSON.stringify({ userId, ...input }),
    });
  }

  public async evaluate<T>(
    userId: string,
    tabId: string,
    expression: string,
    timeout?: number,
  ): Promise<EvaluationResult<T>> {
    if (expression.trim() === "") throw new Error("Evaluation expression cannot be empty");
    const raw = await this.requestJson(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ userId, expression, ...(timeout === undefined ? {} : { timeout }) }),
    });
    return { value: evaluationValue(raw) as T, raw };
  }

  public async screenshot(userId: string, tabId: string, fullPage = false): Promise<Buffer> {
    const query = new URLSearchParams({ userId, fullPage: String(fullPage) });
    return this.requestBinary(
      `/tabs/${encodeURIComponent(tabId)}/screenshot?${query.toString()}`,
      { method: "GET" },
    );
  }

  public async pageErrors(userId: string, tabId: string, limit = 50): Promise<CamofoxPageError[]> {
    const query = new URLSearchParams({ userId, limit: String(limit) });
    const raw = await this.requestJson(
      `/tabs/${encodeURIComponent(tabId)}/errors?${query.toString()}`,
      { method: "GET" },
    );
    const object = asObject(raw);
    const candidates = Array.isArray(raw)
      ? raw
      : Array.isArray(object?.errors)
        ? object.errors
        : [];
    return candidates.flatMap((candidate) => {
      const error = asObject(candidate);
      const message = stringProperty(error, ["message", "text", "error"]);
      if (message === undefined) return [];
      const type = stringProperty(error, ["type", "name"]);
      const timestamp = stringProperty(error, ["timestamp", "time"]);
      return [{
        message,
        ...(type === undefined ? {} : { type }),
        ...(timestamp === undefined ? {} : { timestamp }),
      }];
    });
  }

  public async closeTab(userId: string, tabId: string): Promise<void> {
    await this.requestJson(`/tabs/${encodeURIComponent(tabId)}`, {
      method: "DELETE",
      body: JSON.stringify({ userId }),
    });
  }

  public async closeSession(userId: string): Promise<void> {
    await this.requestJson(`/sessions/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  public async toggleDisplay(userId: string, mode: DisplayMode): Promise<DisplayResult> {
    const raw = await this.requestJson(
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

  private async requestJson(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.perform(pathname, init);
    const text = await response.text();
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
  }

  private async requestBinary(pathname: string, init: RequestInit): Promise<Buffer> {
    const response = await this.perform(pathname, init);
    return Buffer.from(await response.arrayBuffer());
  }

  private async perform(pathname: string, init: RequestInit): Promise<Response> {
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
      if (!response.ok) {
        const text = await response.text();
        throw new CamofoxRequestError(
          `Camofox request failed: ${init.method ?? "GET"} ${pathname} (${response.status})`,
          response.status,
          text.slice(0, 2_000),
        );
      }
      return response;
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

function assertTarget(target: InteractionTarget): void {
  if (target.ref === undefined && target.selector === undefined) {
    throw new Error("Interaction requires a ref or selector");
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

function numberProperty(
  object: Record<string, unknown> | undefined,
  names: readonly string[],
): number | undefined {
  if (!object) return undefined;
  for (const name of names) {
    const value = object[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
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

function evaluationValue(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return value;
  if ("result" in object) {
    const result = object.result;
    const resultObject = asObject(result);
    if (resultObject && "value" in resultObject) return resultObject.value;
    return result;
  }
  if ("value" in object) return object.value;
  if ("data" in object) return object.data;
  return value;
}
