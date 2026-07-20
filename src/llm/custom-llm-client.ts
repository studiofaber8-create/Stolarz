import type { LlmConfig } from "../config.js";

export interface CompletionInput {
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export class LlmRequestError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

export class CustomLlmClient {
  public constructor(private readonly config: LlmConfig) {}

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

    try {
      const response = await fetch(this.config.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(this.requestBody(input)),
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new LlmRequestError(
          `Custom LLM API returned HTTP ${response.status}`,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawText) as unknown;
      } catch {
        throw new LlmRequestError("Custom LLM API returned invalid JSON", response.status);
      }
      const text = this.responseText(payload);
      if (text === undefined || text.trim() === "") {
        throw new LlmRequestError("Custom LLM API response does not contain text", response.status);
      }
      const usage = responseUsage(payload);
      return {
        text,
        model: responseModel(payload) ?? this.config.model,
        latencyMs: Date.now() - startedAt,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (error instanceof LlmRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmRequestError(`Custom LLM API timed out after ${this.config.timeoutMs} ms`);
      }
      throw new LlmRequestError(
        `Cannot reach Custom LLM API: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
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
