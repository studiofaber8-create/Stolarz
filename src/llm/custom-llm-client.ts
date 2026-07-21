import type { LlmConfig } from "../config.js";
import type { LlmErrorCategory } from "../domain/monitoring.js";

export interface CompletionInput {
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly requestAttempts: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export class LlmRequestError extends Error {
  public constructor(
    message: string,
    public readonly category: LlmErrorCategory,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly attempts = 1,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

type FetchFunction = typeof fetch;
type SleepFunction = (milliseconds: number) => Promise<void>;

export class CustomLlmClient {
  public constructor(
    private readonly config: LlmConfig,
    private readonly fetchFunction: FetchFunction = fetch,
    private readonly sleep: SleepFunction = delay,
    private readonly random: () => number = Math.random,
  ) {}

  public get metadata(): Pick<LlmConfig, "apiUrl" | "model" | "format"> {
    return {
      apiUrl: this.config.apiUrl,
      model: this.config.model,
      format: this.config.format,
    };
  }

  public async testConnection(): Promise<CompletionResult> {
    return this.complete({
      system: "You are a connectivity check. Follow the requested output exactly.",
      prompt: "Reply with exactly: OK",
      maxTokens: 16,
      temperature: 0,
    });
  }

  public async complete(input: CompletionInput): Promise<CompletionResult> {
    if (input.prompt.trim() === "") throw new Error("LLM prompt cannot be empty");
    const maxAttempts = input.maxAttempts ?? this.config.maxAttempts;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > this.config.maxAttempts) {
      throw new Error(`LLM maxAttempts must be between 1 and ${this.config.maxAttempts}`);
    }
    let lastError: LlmRequestError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.completeAttempt(input, attempt);
      } catch (error) {
        if (!(error instanceof LlmRequestError)) throw error;
        lastError = error;
        if (!error.retryable || attempt >= maxAttempts) throw error;
        await this.sleep(this.retryDelay(error, attempt));
      }
    }
    throw lastError ?? new LlmRequestError(
      "Custom LLM API request failed",
      "operation_failed",
      false,
    );
  }

  private async completeAttempt(
    input: CompletionInput,
    attempt: number,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
    });
    if (this.config.format === "anthropic") {
      headers.set("x-api-key", this.config.apiKey);
      headers.set("anthropic-version", this.config.anthropicVersion);
    } else {
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    }
    if (input.idempotencyKey !== undefined) {
      if (!/^[a-zA-Z0-9_-]{16,200}$/.test(input.idempotencyKey)) {
        throw new Error("LLM idempotency key must contain 16-200 safe characters");
      }
      headers.set("idempotency-key", input.idempotencyKey);
      headers.set("x-idempotency-key", input.idempotencyKey);
    }

    try {
      const response = await this.fetchFunction(this.config.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(this.requestBody(input)),
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        const classification = classifyHttpFailure(response.status);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new LlmRequestError(
          `Custom LLM API returned HTTP ${response.status}`,
          classification.category,
          classification.retryable,
          response.status,
          retryAfterMs,
          attempt,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawText) as unknown;
      } catch {
        throw new LlmRequestError(
          "Custom LLM API returned invalid JSON",
          "invalid_response",
          true,
          response.status,
          undefined,
          attempt,
        );
      }
      const text = this.responseText(payload);
      if (text === undefined || text.trim() === "") {
        throw new LlmRequestError(
          "Custom LLM API response does not contain text",
          "invalid_response",
          true,
          response.status,
          undefined,
          attempt,
        );
      }
      const usage = responseUsage(payload);
      return {
        text,
        model: responseModel(payload) ?? this.config.model,
        latencyMs: Date.now() - startedAt,
        requestAttempts: attempt,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (error instanceof LlmRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmRequestError(
          `Custom LLM API timed out after ${this.config.timeoutMs} ms`,
          "timeout",
          true,
          undefined,
          undefined,
          attempt,
        );
      }
      throw new LlmRequestError(
        `Cannot reach Custom LLM API: ${error instanceof Error ? error.message : String(error)}`,
        "network",
        true,
        undefined,
        undefined,
        attempt,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private retryDelay(error: LlmRequestError, attempt: number): number {
    if (error.retryAfterMs !== undefined) {
      return Math.max(0, error.retryAfterMs);
    }
    const exponential = Math.min(
      this.config.retryMaxMs,
      this.config.retryBaseMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.max(1, Math.round(exponential * (0.5 + this.random() * 0.5)));
  }

  private requestBody(input: CompletionInput): object {
    const maxTokens = input.maxTokens ?? 2_048;
    const temperature = input.temperature ?? 0.2;
    if (this.config.format === "anthropic") {
      return {
        model: this.config.model,
        max_tokens: maxTokens,
        temperature,
        ...(input.system === undefined ? {} : { system: input.system }),
        messages: [{ role: "user", content: input.prompt }],
      };
    }
    return {
      model: this.config.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        ...(input.system === undefined ? [] : [{ role: "system", content: input.system }]),
        { role: "user", content: input.prompt },
      ],
    };
  }

  private responseText(payload: unknown): string | undefined {
    const object = asObject(payload);
    if (this.config.format === "anthropic") {
      const content = object?.content;
      if (!Array.isArray(content)) return undefined;
      return content
        .map((block) => asObject(block))
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block?.text as string)
        .join("\n");
    }
    const choices = object?.choices;
    if (!Array.isArray(choices)) return undefined;
    const message = asObject(asObject(choices[0])?.message);
    return typeof message?.content === "string" ? message.content : undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseModel(payload: unknown): string | undefined {
  const value = asObject(payload)?.model;
  return typeof value === "string" ? value : undefined;
}

function responseUsage(payload: unknown): CompletionResult["usage"] | undefined {
  const usage = asObject(asObject(payload)?.usage);
  if (!usage) return undefined;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
  };
}


function classifyHttpFailure(status: number): {
  category: LlmErrorCategory;
  retryable: boolean;
} {
  if (status === 429) return { category: "rate_limited", retryable: true };
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return { category: "server_error", retryable: true };
  }
  return { category: "client_error", retryable: false };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
