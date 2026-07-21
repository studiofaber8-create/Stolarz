import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { MonitoredGroup } from "../src/domain/monitoring.js";
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
  agent: {
    workerEnabled: false,
    schedulerIntervalMs: 30_000,
    pollIntervalMs: 1_000,
    leaseMs: 60_000,
    reviewThreshold: 0.8,
    llmDailyTokenBudget: 200_000,
    llmScanTokenBudget: 25_000,
    llmRunMaxAttempts: 3,
    businessDescription: "test",
  },
};

describe("GET /api/extraction-health", () => {
  let ctx: TestContext;
  let server: Server | undefined;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "profile-account",
      sessionKey: "facebook-main",
    });
    ctx.store.createGroup({
      accountId: "account",
      name: "Group",
      url: "https://www.facebook.com/groups/6000",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });
  });

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    cleanupTestStore(ctx);
  });

  it("returns extractor version, all health counters and diagnostic scans", async () => {
    const driftGroup = createGroup(ctx, "Drift", "6001");
    completeExtraction(ctx, driftGroup, 1);
    completeExtraction(ctx, driftGroup, 0);
    completeExtraction(ctx, driftGroup, 0);
    completeExtraction(ctx, driftGroup, 0);
    const emptyGroup = createGroup(ctx, "Empty", "6002");
    completeExtraction(ctx, emptyGroup, 0);
    const healthyGroup = createGroup(ctx, "Healthy", "6003");
    completeExtraction(ctx, healthyGroup, 1);
    const errorGroup = createGroup(ctx, "Error", "6004");
    failExtraction(ctx, errorGroup, "snapshot_failed");

    const app = createPanelApp({
      config,
      store: ctx.store,
      sessions: {},
      facebook: {},
      worker: { status: () => ({ running: false, workerId: "test", jobsProcessed: 0 }) },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Services);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/extraction-health`);
    const body = await response.json() as {
      extractorVersion: string;
      summary: Record<string, number>;
      problematicGroups: unknown[];
      recentScans: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.extractorVersion).toBe("facebook-dom-v1");
    expect(body.summary).toMatchObject({
      groups: 5,
      healthy: 1,
      empty: 1,
      suspectedDrift: 1,
      error: 1,
      unknown: 1,
    });
    expect(body.problematicGroups).toHaveLength(2);
    expect(body.problematicGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Drift", extractionHealth: "suspected_drift" }),
      expect.objectContaining({ name: "Error", extractionHealth: "error" }),
    ]));
    expect(body.recentScans.length).toBeGreaterThanOrEqual(7);
    expect(body.recentScans).toEqual(expect.arrayContaining([
      expect.objectContaining({ extractionErrorCategory: "snapshot_failed" }),
      expect.objectContaining({ extractorVersion: "facebook-dom-v1", postsSeen: 1 }),
    ]));
  });
});

function createGroup(ctx: TestContext, name: string, suffix: string): MonitoredGroup {
  return ctx.store.createGroup({
    accountId: "account",
    name,
    url: `https://www.facebook.com/groups/${suffix}`,
    scanIntervalSeconds: 600,
    maxPostsPerScan: 10,
  });
}

function completeExtraction(ctx: TestContext, group: MonitoredGroup, postsSeen: number): void {
  ctx.store.enqueueScanNow(group.id);
  const job = ctx.store.claimNextJob("panel-test", 60_000)!;
  const leaseToken = job.leaseToken!;
  const scan = ctx.store.startScanRunForJob(group.id, job.id, leaseToken);
  ctx.store.recordScanExtraction(scan.id, job.id, leaseToken, {
    extractorVersion: "facebook-dom-v1",
    authState: "authenticated",
    currentUrl: group.url,
    snapshotChecks: 1,
    scrollRounds: 0,
    postsExtracted: postsSeen,
    pageErrorCount: 0,
  });
  if (postsSeen > 0) {
    ctx.store.upsertPostForJob(job.id, leaseToken, group.id, {
      externalId: `post-${job.id}`,
      url: `${group.url}/posts/${job.id}`,
      content: "Known-good panel endpoint fixture.",
    });
  }
  ctx.store.finishSuccessfulScan(scan.id, job.id, leaseToken, {
    postsSeen,
    postsNew: postsSeen > 0 ? 1 : 0,
    decisionsCreated: 0,
  });
}

function failExtraction(ctx: TestContext, group: MonitoredGroup, category: string): void {
  ctx.store.enqueueScanNow(group.id);
  const job = ctx.store.claimNextJob("panel-test", 60_000)!;
  const leaseToken = job.leaseToken!;
  const scan = ctx.store.startScanRunForJob(group.id, job.id, leaseToken);
  ctx.store.recordScanExtractionFailure(scan.id, job.id, leaseToken, "facebook-dom-v1", category);
  ctx.store.finishFailedScanAndJob(
    scan.id,
    job.id,
    leaseToken,
    { postsSeen: 0, postsNew: 0, decisionsCreated: 0 },
    "Extraction failed",
    new Date().toISOString(),
    undefined,
  );
}
