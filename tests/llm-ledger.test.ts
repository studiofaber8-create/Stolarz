import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmWorkDescriptor, MonitoredGroup, StoredPost } from "../src/domain/monitoring.js";
import { MonitoringStore } from "../src/infra/monitoring-store.js";
import {
  classificationSourceVersion,
  draftSourceVersion,
} from "../src/llm/llm-source-version.js";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

describe("durable LLM run ledger", () => {
  let ctx: TestContext;
  let group: MonitoredGroup;
  let post: StoredPost;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "ledger-profile",
      sessionKey: "facebook-main",
    });
    group = ctx.store.createGroup({
      accountId: "account",
      name: "Ledger group",
      url: "https://www.facebook.com/groups/ledger",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });
    post = ctx.store.upsertPost(group.id, {
      externalId: "post-1",
      url: "https://www.facebook.com/groups/ledger/posts/1",
      content: "Szukam wykonawcy kuchni na wymiar.",
    }).post;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTestStore(ctx);
  });

  it("deduplicates deterministic work and preserves it across a restart", () => {
    const descriptor = classificationDescriptor(group, post, "restart");
    const first = ctx.store.enqueueLlmRun(descriptor, 3);
    const duplicate = ctx.store.enqueueLlmRun(descriptor, 3);

    expect(duplicate.id).toBe(first.id);
    expect(ctx.store.listLlmRuns()).toHaveLength(1);

    ctx.store.close();
    ctx.store = new MonitoringStore(ctx.dataDir);

    const claimed = ctx.store.claimNextLlmRun("worker-after-restart", 60_000, 100_000, 10_000);
    expect(claimed).toMatchObject({ id: first.id, status: "running", attempts: 1 });
    expect(claimed?.leaseToken).toBeDefined();
  });

  it("atomically completes a classification with usage and decision data", () => {
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "complete"), 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;

    const decision = ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.95,
      reason: "Autor szuka wykonawcy kuchni.",
      status: "review",
      model: "test-model",
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 250,
    });

    expect(ctx.store.getDecisionByPost(post.id)?.id).toBe(decision.id);
    expect(ctx.store.listLlmRuns()[0]).toMatchObject({
      status: "succeeded",
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 250,
    });
    expect(ctx.store.llmQueueSummary()).toMatchObject({ succeeded: 1, tokensToday: 150 });
    expect(() => ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: false,
      category: "not_relevant",
      confidence: 1,
      reason: "duplicate",
      status: "ignored",
      model: "test-model",
      latencyMs: 1,
    })).toThrow(`LLM run lease lost: ${run.id}`);
  });

  it("enforces per-scan reservations before starting another run", () => {
    const scanId = startScan(ctx, group);
    ctx.store.enqueueLlmRun({
      ...classificationDescriptor(group, post, "budget-a"),
      scanId,
      reservedTokens: 600,
    }, 3);
    ctx.store.enqueueLlmRun({
      ...classificationDescriptor(group, post, "budget-b"),
      scanId,
      reservedTokens: 600,
    }, 3);

    const first = ctx.store.claimNextLlmRun("worker-a", 60_000, 100_000, 1_000);
    expect(first?.status).toBe("running");
    const second = ctx.store.claimNextLlmRun("worker-b", 60_000, 100_000, 1_000);

    expect(second).toBeUndefined();
    expect(ctx.store.listLlmRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({ status: "skipped_budget", errorCategory: "budget_scan" }),
    ]));
    expect(ctx.store.llmQueueSummary().skippedBudget).toBe(1);
  });

  it("requeues retryable failures and allows controlled replay after a terminal failure", () => {
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "retry"), 2);
    const first = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;
    const retry = ctx.store.failLlmRun(
      run.id,
      first.leaseToken!,
      "server_error",
      "temporary outage",
      true,
      new Date(0).toISOString(),
    );
    expect(retry.status).toBe("queued");

    const second = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;
    expect(second.attempts).toBe(2);
    const failed = ctx.store.failLlmRun(
      run.id,
      second.leaseToken!,
      "server_error",
      "still unavailable",
      true,
      new Date(0).toISOString(),
    );
    expect(failed.status).toBe("failed");

    const replayed = ctx.store.replayLlmRun(run.id);
    expect(replayed).toMatchObject({ status: "queued", attempts: 0 });
    expect(ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)?.attempts).toBe(1);
  });

  it("atomically stores a generated draft with its successful run", () => {
    const decision = ctx.store.saveDecision({
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.95,
      reason: "Relevant",
      status: "review",
      model: "test-model",
      latencyMs: 10,
    });
    const template = ctx.store.createResponseTemplate({
      name: "Kitchen",
      category: "custom_kitchen",
      body: "Dzień dobry, chętnie przygotujemy propozycję.",
    });
    const run = ctx.store.enqueueLlmRun({
      operation: "draft",
      entityId: decision.id,
      groupId: group.id,
      templateId: template.id,
      model: "test-model",
      promptVersion: "draft-v1",
      inputHash: hash("draft"),
      sourceVersion: draftSourceVersion(template, group, post, decision),
      reservedTokens: 500,
    }, 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;

    const draft = ctx.store.completeDraftLlmRun(run.id, claimed.leaseToken!, {
      decisionId: decision.id,
      templateId: template.id,
      templateUpdatedAt: template.updatedAt,
      renderedTemplate: template.body,
      text: "Dzień dobry, chętnie przygotujemy propozycję kuchni.",
      model: "test-model",
      inputTokens: 80,
      outputTokens: 20,
      latencyMs: 100,
    });

    expect(ctx.store.getResponseDraftByDecision(decision.id)?.id).toBe(draft.id);
    expect(ctx.store.listLlmRuns()[0]?.status).toBe("succeeded");
  });

  it("rejects a classification result when the post changes during the request", () => {
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "stale-post"), 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;

    ctx.store.upsertPost(group.id, {
      externalId: post.externalId,
      url: post.url,
      content: "Treść posta zmieniła się podczas wywołania modelu.",
    });

    expect(() => ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.9,
      reason: "Stary wynik",
      status: "review",
      model: "test-model",
      latencyMs: 100,
    })).toThrow(`LLM source changed during request: ${run.id}`);
    expect(ctx.store.getDecisionByPost(post.id)).toBeUndefined();
    expect(ctx.store.listLlmRuns()[0]?.status).toBe("running");
  });

  it("rejects a draft result when its template changes during the request", () => {
    const decision = ctx.store.saveDecision({
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.95,
      reason: "Relevant",
      status: "review",
      model: "test-model",
      latencyMs: 10,
    });
    const template = ctx.store.createResponseTemplate({
      name: "Stale template",
      category: "custom_kitchen",
      body: "Pierwotna treść.",
    });
    const run = ctx.store.enqueueLlmRun({
      operation: "draft",
      entityId: decision.id,
      groupId: group.id,
      templateId: template.id,
      model: "test-model",
      promptVersion: "draft-v1",
      inputHash: hash("stale-draft"),
      sourceVersion: draftSourceVersion(template, group, post, decision),
      reservedTokens: 500,
    }, 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;
    ctx.store.updateResponseTemplate(template.id, { body: "Zmieniona treść." });

    expect(() => ctx.store.completeDraftLlmRun(run.id, claimed.leaseToken!, {
      decisionId: decision.id,
      templateId: template.id,
      templateUpdatedAt: template.updatedAt,
      renderedTemplate: template.body,
      text: "Wynik oparty o stary szablon.",
      model: "test-model",
      latencyMs: 100,
    })).toThrow(`LLM source changed during request: ${run.id}`);
    expect(ctx.store.getResponseDraftByDecision(decision.id)).toBeUndefined();
  });

  it("charges the full reservation when provider usage is missing", () => {
    const descriptor = { ...classificationDescriptor(group, post, "missing-usage"), reservedTokens: 777 };
    const run = ctx.store.enqueueLlmRun(descriptor, 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;

    ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: false,
      category: "not_relevant",
      confidence: 0.9,
      reason: "Not relevant",
      status: "ignored",
      model: "test-model",
      latencyMs: 50,
      requestAttempts: 2,
    });

    expect(ctx.store.llmQueueSummary().tokensToday).toBe(777);
    expect(ctx.store.listLlmRuns()[0]).toMatchObject({
      status: "succeeded",
      requestAttempts: 2,
    });
  });

  it("reclaims expired leases and terminally completes the final expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "expiry"), 2);
    expect(ctx.store.claimNextLlmRun("worker-a", 1_000, 100_000, 10_000)?.attempts).toBe(1);

    vi.advanceTimersByTime(1_001);
    const reclaimed = ctx.store.claimNextLlmRun("worker-b", 1_000, 100_000, 10_000);
    expect(reclaimed).toMatchObject({ id: run.id, status: "running", attempts: 2 });

    vi.advanceTimersByTime(1_001);
    expect(ctx.store.claimNextLlmRun("worker-c", 1_000, 100_000, 10_000)).toBeUndefined();
    expect(ctx.store.listLlmRuns()[0]).toMatchObject({
      id: run.id,
      status: "failed",
      retryable: false,
      error: "LLM run lease expired",
    });
    expect(ctx.store.listLlmRuns()[0]?.completedAt).toBeDefined();
    expect(ctx.store.llmQueueSummary().tokensToday).toBe(1_000);
  });

  it("stops claims, heartbeats, and commits after the group is disabled", () => {
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "disable-running"), 1);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;
    ctx.store.setGroupEnabled(group.id, false);

    expect(() => ctx.store.extendLlmRunLease(run.id, claimed.leaseToken!, 60_000))
      .toThrow(`LLM run lease lost: ${run.id}`);
    expect(() => ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: false,
      category: "not_relevant",
      confidence: 1,
      reason: "Disabled",
      status: "ignored",
      model: "test-model",
      latencyMs: 1,
    })).toThrow(`LLM run lease lost: ${run.id}`);

    ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "disable-queued"), 1);
    expect(ctx.store.claimNextLlmRun("other-worker", 60_000, 100_000, 10_000)).toBeUndefined();
  });

  it("allows draft reconciliation after a newer decision replaces a completed draft", () => {
    const firstDecision = ctx.store.saveDecision({
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.9,
      reason: "First decision",
      status: "review",
      model: "test-model",
      latencyMs: 10,
    });
    const template = ctx.store.createResponseTemplate({
      name: "Recovery template",
      category: "custom_kitchen",
      body: "Dzień dobry.",
    });
    const run = ctx.store.enqueueLlmRun({
      operation: "draft",
      entityId: firstDecision.id,
      groupId: group.id,
      templateId: template.id,
      model: "test-model",
      promptVersion: "draft-v1",
      inputHash: hash("completed-old-draft"),
      sourceVersion: draftSourceVersion(template, group, post, firstDecision),
      reservedTokens: 500,
    }, 3);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;
    ctx.store.completeDraftLlmRun(run.id, claimed.leaseToken!, {
      decisionId: firstDecision.id,
      templateId: template.id,
      templateUpdatedAt: template.updatedAt,
      renderedTemplate: template.body,
      text: "Pierwsza wersja robocza.",
      model: "test-model",
      latencyMs: 10,
    });

    const updatedDecision = ctx.store.saveDecision({
      postId: post.id,
      relevant: true,
      category: "custom_kitchen",
      confidence: 0.95,
      reason: "Updated decision",
      status: "review",
      model: "test-model",
      latencyMs: 10,
    });

    expect(ctx.store.getResponseDraftByDecision(updatedDecision.id)).toBeUndefined();
    expect(ctx.store.listDecisionsNeedingDraft()).toEqual([
      expect.objectContaining({ id: updatedDecision.id, reason: "Updated decision" }),
    ]);
  });

  it("preserves charged spend when a group is deleted and blocks deletion in flight", () => {
    const run = ctx.store.enqueueLlmRun(classificationDescriptor(group, post, "delete-group"), 1);
    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 100_000, 10_000)!;

    expect(() => ctx.store.deleteGroup(group.id)).toThrow(`Group has active LLM runs: ${group.id}`);
    ctx.store.completeClassificationLlmRun(run.id, claimed.leaseToken!, {
      postId: post.id,
      relevant: false,
      category: "not_relevant",
      confidence: 1,
      reason: "Not relevant",
      status: "ignored",
      model: "test-model",
      latencyMs: 1,
    });
    expect(ctx.store.llmQueueSummary().tokensToday).toBe(500);

    ctx.store.deleteGroup(group.id);

    expect(ctx.store.listLlmRuns()).toEqual([]);
    expect(ctx.store.llmQueueSummary().tokensToday).toBe(500);
  });

  it("continues past more than 100 budget-skipped records to claim eligible work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    for (let index = 0; index < 101; index += 1) {
      ctx.store.enqueueLlmRun({
        ...classificationDescriptor(group, post, `starvation-${index}`),
        reservedTokens: index < 100 ? 2_000 : 100,
      }, 1);
      vi.advanceTimersByTime(1);
    }

    const claimed = ctx.store.claimNextLlmRun("worker", 60_000, 1_000, 10_000);

    expect(claimed?.reservedTokens).toBe(100);
    expect(ctx.store.llmQueueSummary()).toMatchObject({ skippedBudget: 100, running: 1 });
  });
});

function classificationDescriptor(
  group: MonitoredGroup,
  post: StoredPost,
  salt: string,
): LlmWorkDescriptor {
  return {
    operation: "classification",
    entityId: post.id,
    groupId: group.id,
    model: "test-model",
    promptVersion: "classifier-v1",
    inputHash: hash(`${post.contentHash}:${salt}`),
    sourceVersion: classificationSourceVersion(group, post),
    reservedTokens: 500,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function startScan(ctx: TestContext, group: MonitoredGroup): string {
  ctx.store.enqueueScanNow(group.id);
  const job = ctx.store.claimNextJob("scan-worker", 60_000)!;
  return ctx.store.startScanRunForJob(group.id, job.id, job.leaseToken!).id;
}
