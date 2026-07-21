import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("LLM reliability configuration", () => {
  it("loads bounded retry and token budget settings", () => {
    const config = loadConfig({
      LLM_API_URL: "https://llm.example.test/v1/messages",
      LLM_API_KEY: "secret",
      LLM_RETRY_MAX_ATTEMPTS: "4",
      LLM_RETRY_BASE_MS: "250",
      LLM_RETRY_MAX_MS: "5000",
      AGENT_LLM_DAILY_TOKEN_BUDGET: "300000",
      AGENT_LLM_SCAN_TOKEN_BUDGET: "30000",
      AGENT_LLM_RUN_MAX_ATTEMPTS: "5",
    });

    expect(config.llm).toMatchObject({
      maxAttempts: 4,
      retryBaseMs: 250,
      retryMaxMs: 5_000,
    });
    expect(config.agent).toMatchObject({
      llmDailyTokenBudget: 300_000,
      llmScanTokenBudget: 30_000,
      llmRunMaxAttempts: 5,
    });
  });

  it("rejects a retry cap lower than the base delay", () => {
    expect(() => loadConfig({
      LLM_API_URL: "https://llm.example.test/v1/messages",
      LLM_API_KEY: "secret",
      LLM_RETRY_BASE_MS: "5000",
      LLM_RETRY_MAX_MS: "1000",
    })).toThrow("LLM_RETRY_MAX_MS must be greater than or equal to LLM_RETRY_BASE_MS");
  });
});
