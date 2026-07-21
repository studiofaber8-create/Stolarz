import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createPanelApp } from "../src/panel.js";
import type { Services } from "../src/services.js";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

const config: AppConfig = {
  camofoxUrl: "http://127.0.0.1:9377",
  requestTimeoutMs: 30_000,
  dataDir: "/tmp/test",
  profilePrefix: "test",
  facebookHomeUrl: "https://www.facebook.com",
  panelHost: "127.0.0.1",
  panelPort: 3_000,
  panelApiToken: "test-token",
  agent: {
    workerEnabled: false,
    schedulerIntervalMs: 30_000,
    pollIntervalMs: 1_000,
    leaseMs: 60_000,
    reviewThreshold: 0.8,
    llmDailyTokenBudget: 2_000,
    llmScanTokenBudget: 1_000,
    llmRunMaxAttempts: 3,
    businessDescription: "test",
  },
};

describe("LLM operations API", () => {
  let ctx: TestContext;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "panel-llm-profile",
      sessionKey: "facebook-main",
    });
    const group = ctx.store.createGroup({
      accountId: "account",
      name: "Panel LLM group",
      url: "https://www.facebook.com/groups/panel-llm",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });
    const post = ctx.store.upsertPost(group.id, {
      externalId: "post-1",
      url: "https://www.facebook.com/groups/panel-llm/posts/1",
      content: "Potrzebuję szafy na wymiar.",
    }).post;
    ctx.store.enqueueLlmRun({
      operation: "classification",
      entityId: post.id,
      groupId: group.id,
      model: "test-model",
      promptVersion: "classifier-v1",
      inputHash: createHash("sha256").update("panel").digest("hex"),
      sourceVersion: createHash("sha256").update("panel-source").digest("hex"),
      reservedTokens: 1_500,
    }, 3);
    expect(ctx.store.claimNextLlmRun("budget-worker", 60_000, 1_000, 1_000)).toBeUndefined();

    const app = createPanelApp({
      config,
      store: ctx.store,
      sessions: {},
      facebook: {},
      worker: {
        status: () => ({
          running: false,
          workerId: "test",
          jobsProcessed: 0,
          llmRunsProcessed: 0,
        }),
      },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Services);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    cleanupTestStore(ctx);
  });

  it("reports budgets and permits replay only through the guarded mutation endpoint", async () => {
    const healthResponse = await fetch(`${baseUrl}/api/llm-health`, {
      headers: { authorization: "Bearer test-token" },
    });
    const health = await healthResponse.json() as {
      configured: boolean;
      replayEnabled: boolean;
      budgets: Record<string, number>;
      summary: Record<string, number>;
      recentRuns: Array<Record<string, unknown> & { id: string; status: string; errorCategory?: string }>;
    };

    expect(healthResponse.status).toBe(200);
    expect(health.configured).toBe(false);
    expect(health.replayEnabled).toBe(true);
    expect(health.budgets).toMatchObject({
      dailyTokens: 2_000,
      perScanTokens: 1_000,
      runMaxAttempts: 3,
    });
    expect(health.summary).toMatchObject({ skippedBudget: 1, queued: 0 });
    expect(health.recentRuns[0]).toMatchObject({
      status: "skipped_budget",
      errorCategory: "budget_daily",
    });
    expect(health.recentRuns[0]).not.toHaveProperty("leaseToken");
    expect(health.recentRuns[0]).not.toHaveProperty("idempotencyKey");
    expect(health.recentRuns[0]).not.toHaveProperty("inputHash");
    expect(health.recentRuns[0]).not.toHaveProperty("sourceVersion");

    const rejected = await fetch(`${baseUrl}/api/llm-runs/${health.recentRuns[0]!.id}/replay`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(rejected.status).toBe(403);

    const replayed = await fetch(`${baseUrl}/api/llm-runs/${health.recentRuns[0]!.id}/replay`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "x-agent-request": "panel",
      },
      body: "{}",
    });
    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toMatchObject({ status: "queued", attempts: 0 });
  });
});
