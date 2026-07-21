import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, LlmConfig } from "../src/config.js";
import type {
  LeadDecision,
  MonitoredGroup,
  ResponseTemplate,
  StoredPost,
} from "../src/domain/monitoring.js";
import type { FacebookAdapter, FacebookGroupScanResult } from "../src/facebook/facebook-adapter.js";
import { LeadClassifier } from "../src/agent/lead-classifier.js";
import type { ResponseDraftGenerator } from "../src/agent/response-draft-generator.js";
import { AgentWorker } from "../src/agent/worker.js";
import type { Logger } from "../src/observability/logger.js";
import {
  classificationSourceVersion,
  draftSourceVersion,
} from "../src/llm/llm-source-version.js";
import { CustomLlmClient } from "../src/llm/custom-llm-client.js";
import { MonitoringStore } from "../src/infra/monitoring-store.js";
import { LeadPolicyGate } from "../src/agent/policy-gate.js";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

const config: AgentConfig = {
  workerEnabled: false,
  schedulerIntervalMs: 30_000,
  pollIntervalMs: 10,
  leaseMs: 60_000,
  reviewThreshold: 0.8,
  llmDailyTokenBudget: 100_000,
  llmScanTokenBudget: 10_000,
  llmRunMaxAttempts: 3,
  businessDescription: "test",
};

const logger: Logger = { info() {}, warn() {}, error() {} };

describe("AgentWorker durable LLM pipeline", () => {
  let ctx: TestContext;
  let group: MonitoredGroup;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "worker-llm-profile",
      sessionKey: "facebook-main",
    });
    group = ctx.store.createGroup({
      accountId: "account",
      name: "Worker group",
      url: "https://www.facebook.com/groups/worker-llm",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTestStore(ctx);
  });

  it("finishes the Facebook scan before executing the separately leased LLM run", async () => {
    const scanGroup = vi.fn(async (): Promise<FacebookGroupScanResult> => ({
      currentUrl: group.url,
      authState: "authenticated",
      posts: [{
        externalId: "post-1",
        url: `${group.url}/posts/1`,
        content: "Szukam wykonawcy kuchni na wymiar.",
      }],
      pageErrors: [],
      diagnostics: {
        extractorVersion: "facebook-dom-v1",
        authState: "authenticated",
        snapshotChecks: 1,
        scrollRounds: 0,
        postsExtracted: 1,
        pageErrorCount: 0,
      },
    }));
    const classify = vi.fn(async () => ({
      decision: {
        relevant: true,
        category: "custom_kitchen" as const,
        confidence: 0.95,
        reason: "Autor szuka wykonawcy.",
        status: "review" as const,
      },
      model: "test-model",
      latencyMs: 100,
      requestAttempts: 1,
      inputTokens: 80,
      outputTokens: 20,
    }));
    const classifier = {
      describe: (candidateGroup: MonitoredGroup, post: { id: string; contentHash: string }) => ({
        operation: "classification" as const,
        entityId: post.id,
        groupId: candidateGroup.id,
        model: "test-model",
        promptVersion: "classifier-v1",
        inputHash: createHash("sha256").update(post.contentHash).digest("hex"),
        sourceVersion: classificationSourceVersion(
          candidateGroup,
          ctx.store.getPost(post.id),
        ),
        reservedTokens: 500,
      }),
      classify,
    } as unknown as LeadClassifier;
    const template = ctx.store.createResponseTemplate({
      name: "Worker kitchen",
      category: "custom_kitchen",
      body: "Dzień dobry, przygotujemy propozycję.",
    });
    const generate = vi.fn();
    const draftGenerator = {
      describe: (
        candidateTemplate: ResponseTemplate,
        candidateGroup: MonitoredGroup,
        candidatePost: StoredPost,
        decision: LeadDecision,
      ) => ({
        operation: "draft" as const,
        entityId: decision.id,
        groupId: candidateGroup.id,
        templateId: candidateTemplate.id,
        model: "test-model",
        promptVersion: "draft-v1",
        inputHash: createHash("sha256").update(decision.id).digest("hex"),
        sourceVersion: draftSourceVersion(
          candidateTemplate,
          candidateGroup,
          candidatePost,
          decision,
        ),
        reservedTokens: 9_950,
      }),
      generate,
    } as unknown as ResponseDraftGenerator;
    const worker = new AgentWorker(
      config,
      ctx.store,
      { scanGroup } as unknown as FacebookAdapter,
      classifier,
      logger,
      draftGenerator,
    );
    ctx.store.enqueueScanNow(group.id);

    expect(await worker.runOnce(false)).toBe(true);

    expect(scanGroup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.store.listScanRuns(1)[0]?.status).toBe("succeeded");
    expect(ctx.store.listLlmRuns(1)[0]?.status).toBe("queued");
    expect(ctx.store.listDecisions()).toEqual([]);

    expect(await worker.runOnce(false)).toBe(true);

    expect(classify).toHaveBeenCalledTimes(1);
    const runsAfterClassification = ctx.store.listLlmRuns();
    expect(runsAfterClassification.find((run) => run.operation === "classification")).toMatchObject({
      status: "succeeded",
      inputTokens: 80,
      outputTokens: 20,
      requestAttempts: 1,
    });
    const draftRun = runsAfterClassification.find((run) => run.operation === "draft");
    expect(draftRun).toMatchObject({
      status: "queued",
      scanId: ctx.store.listScanRuns(1)[0]?.id,
      reservedTokens: 9_950,
    });
    expect(ctx.store.listDecisions()).toHaveLength(1);
    expect(worker.status()).toMatchObject({ jobsProcessed: 1, llmRunsProcessed: 1 });

    expect(await worker.runOnce(false)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(ctx.store.listLlmRuns().find((run) => run.operation === "draft")).toMatchObject({
      status: "skipped_budget",
      errorCategory: "budget_scan",
      scanId: ctx.store.listScanRuns(1)[0]?.id,
    });
  });

  it("durably retries one provider request per lease after a database restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    const post = ctx.store.upsertPost(group.id, {
      externalId: "retry-post",
      url: `${group.url}/posts/retry`,
      content: "Potrzebuję zabudowy na wymiar.",
    }).post;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", {
        status: 503,
        headers: { "retry-after": "10" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "test-model",
        choices: [{ message: { content: JSON.stringify({
          relevant: false,
          category: "not_relevant",
          confidence: 0.9,
          reason: "Not relevant",
        }) } }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const sleep = vi.fn(async () => {});
    const llmConfig: LlmConfig = {
      apiUrl: "https://llm.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "test-model",
      format: "openai-compatible",
      timeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 100,
      retryMaxMs: 2_000,
      anthropicVersion: "2023-06-01",
    };
    const classifier = new LeadClassifier(
      new CustomLlmClient(llmConfig, fetchMock as unknown as typeof fetch, sleep, () => 0),
      new LeadPolicyGate(0.8),
      "Meble na wymiar",
    );
    const reservation = classifier.describe(group, post).reservedTokens;
    const facebook = {} as FacebookAdapter;
    const firstWorker = new AgentWorker(config, ctx.store, facebook, classifier, logger);

    expect(await firstWorker.runOnce(false)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(ctx.store.listLlmRuns()[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      requestAttempts: 1,
      retryable: true,
    });
    expect(ctx.store.llmQueueSummary().tokensToday).toBe(reservation);

    ctx.store.close();
    ctx.store = new MonitoringStore(ctx.dataDir);
    const restartedWorker = new AgentWorker(config, ctx.store, facebook, classifier, logger);
    vi.advanceTimersByTime(9_999);
    expect(await restartedWorker.runOnce(false)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    expect(await restartedWorker.runOnce(false)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const secondHeaders = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(firstHeaders.get("idempotency-key")).toBe(secondHeaders.get("idempotency-key"));
    expect(firstHeaders.get("idempotency-key")).not.toBeNull();
    expect(ctx.store.listLlmRuns()[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
      requestAttempts: 1,
      inputTokens: 80,
      outputTokens: 20,
    });
    expect(ctx.store.llmQueueSummary().tokensToday).toBe(reservation + 100);
    expect(ctx.store.getDecisionByPost(post.id)?.status).toBe("ignored");
  });
});
