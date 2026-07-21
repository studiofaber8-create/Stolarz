import { describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config.js";
import { CustomLlmClient, LlmRequestError } from "../src/llm/custom-llm-client.js";

const config: LlmConfig = {
  apiUrl: "https://llm.example.test/v1/messages",
  apiKey: "test-key",
  model: "test-model",
  format: "openai-compatible",
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 2_000,
  anthropicVersion: "2023-06-01",
};

describe("CustomLlmClient retry policy", () => {
  it("honors Retry-After and succeeds after a rate limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        model: "served-model",
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }));
    const sleeps: number[] = [];
    const client = new CustomLlmClient(
      config,
      fetchMock as unknown as typeof fetch,
      async (milliseconds) => { sleeps.push(milliseconds); },
      () => 0,
    );

    const result = await client.complete({ prompt: "test", maxTokens: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(result).toMatchObject({
      text: "OK",
      model: "served-model",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("does not retry a non-transient client error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const sleep = vi.fn(async () => {});
    const client = new CustomLlmClient(
      config,
      fetchMock as unknown as typeof fetch,
      sleep,
      () => 0,
    );

    const error = await client.complete({ prompt: "test" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({
      category: "client_error",
      retryable: false,
      status: 400,
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("caps exponential jittered backoff and reports the exhausted attempt", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("unavailable", { status: 503 }));
    const sleeps: number[] = [];
    const client = new CustomLlmClient(
      { ...config, retryBaseMs: 1_500, retryMaxMs: 2_000 },
      fetchMock as unknown as typeof fetch,
      async (milliseconds) => { sleeps.push(milliseconds); },
      () => 1,
    );

    const error = await client.complete({ prompt: "test" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({
      category: "server_error",
      retryable: true,
      status: 503,
      attempts: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_500, 2_000]);
  });

  it("retries an invalid JSON response as an invalid_response failure", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("not-json", { status: 200 }));
    const client = new CustomLlmClient(
      { ...config, maxAttempts: 2 },
      fetchMock as unknown as typeof fetch,
      async () => {},
      () => 0,
    );

    const error = await client.complete({ prompt: "test" }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      category: "invalid_response",
      retryable: true,
      attempts: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows durable callers to limit a lease to one HTTP attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const sleep = vi.fn(async () => {});
    const client = new CustomLlmClient(
      config,
      fetchMock as unknown as typeof fetch,
      sleep,
      () => 0,
    );

    const error = await client.complete({ prompt: "test", maxAttempts: 1 })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ category: "server_error", retryable: true, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not cap a provider Retry-After delay and forwards idempotency headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "10" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "OK" } }],
      }));
    const sleeps: number[] = [];
    const client = new CustomLlmClient(
      { ...config, retryMaxMs: 2_000 },
      fetchMock as unknown as typeof fetch,
      async (milliseconds) => { sleeps.push(milliseconds); },
      () => 0,
    );
    const key = "1234567890abcdef1234567890abcdef";

    const result = await client.complete({ prompt: "test", idempotencyKey: key });

    expect(result.requestAttempts).toBe(2);
    expect(sleeps).toEqual([10_000]);
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get("idempotency-key")).toBe(key);
      expect(headers.get("x-idempotency-key")).toBe(key);
    }
  });
});

function jsonResponse(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
