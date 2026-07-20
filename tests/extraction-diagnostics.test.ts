import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MonitoredGroup } from "../src/domain/monitoring.js";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

describe("persistent extraction diagnostics and drift detection", () => {
  let ctx: TestContext;
  let group: MonitoredGroup;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "profile-account",
      sessionKey: "facebook-main",
    });
    group = ctx.store.createGroup({
      accountId: "account",
      name: "Group",
      url: "https://www.facebook.com/groups/5000",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });
  });

  afterEach(() => cleanupTestStore(ctx));

  it("persists extractor diagnostics on the scan and group", () => {
    const outcome = completeExtraction(ctx, group, 2, {
      snapshotChecks: 3,
      scrollRounds: 1,
      pageErrorCount: 2,
    });

    expect(outcome.health).toBe("healthy");
    const updatedGroup = ctx.store.getGroup(group.id);
    expect(updatedGroup.extractionHealth).toBe("healthy");
    expect(updatedGroup.emptyScanStreak).toBe(0);
    expect(updatedGroup.extractorVersion).toBe("facebook-dom-v1");
    expect(updatedGroup.lastExtractionAt).toBeDefined();

    const scan = ctx.store.listScanRuns(1)[0]!;
    expect(scan.extractorVersion).toBe("facebook-dom-v1");
    expect(scan.extractionAuthState).toBe("authenticated");
    expect(scan.extractionCurrentUrl).toContain("facebook.com/groups/5000");
    expect(scan.snapshotChecks).toBe(3);
    expect(scan.scrollRounds).toBe(1);
    expect(scan.pageErrorCount).toBe(2);
  });

  it("marks suspected drift after three authenticated empty scans following a known-good extraction", () => {
    completeExtraction(ctx, group, 1);
    const first = completeExtraction(ctx, group, 0);
    expect(first.health).toBe("empty");
    expect(first.emptyScanStreak).toBe(1);

    const second = completeExtraction(ctx, group, 0);
    expect(second.health).toBe("empty");
    expect(second.emptyScanStreak).toBe(2);

    const third = completeExtraction(ctx, group, 0);
    expect(third.health).toBe("suspected_drift");
    expect(third.emptyScanStreak).toBe(3);
    expect(third.driftDetected).toBe(true);

    const driftEvents = ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.drift_suspected");
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]?.detail).toContain("3 consecutive successful authenticated scans");
    expect(ctx.store.summary().extractionDriftGroups).toBe(1);
  });

  it("does not duplicate drift audit while empty streak continues", () => {
    completeExtraction(ctx, group, 1);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    const fourth = completeExtraction(ctx, group, 0);

    expect(fourth.health).toBe("suspected_drift");
    expect(fourth.emptyScanStreak).toBe(4);
    expect(fourth.driftDetected).toBe(false);
    expect(ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.drift_suspected")).toHaveLength(1);
  });

  it("recovers drift after a non-empty authenticated extraction", () => {
    completeExtraction(ctx, group, 1);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);

    const recovered = completeExtraction(ctx, group, 1);

    expect(recovered.health).toBe("healthy");
    expect(recovered.emptyScanStreak).toBe(0);
    expect(recovered.recovered).toBe(true);
    expect(ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.recovered")).toHaveLength(1);
  });

  it("keeps a never-proven group empty instead of claiming DOM drift", () => {
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    const fourth = completeExtraction(ctx, group, 0);

    expect(fourth.health).toBe("empty");
    expect(fourth.emptyScanStreak).toBe(4);
    expect(fourth.driftDetected).toBe(false);
    expect(ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.drift_suspected")).toHaveLength(0);
  });

  it("does not emit recovery when the first successful extraction follows only empty scans", () => {
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);

    const firstSuccess = completeExtraction(ctx, group, 1);

    expect(firstSuccess.health).toBe("healthy");
    expect(firstSuccess.recovered).toBe(false);
    expect(ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.recovered")).toHaveLength(0);
  });

  it("requires a known-good extraction from the same extractor version before drift", () => {
    completeExtraction(ctx, group, 1, { extractorVersion: "facebook-dom-v1" });
    completeExtraction(ctx, group, 0, { extractorVersion: "facebook-dom-v2" });
    completeExtraction(ctx, group, 0, { extractorVersion: "facebook-dom-v2" });
    const thirdWithoutBaseline = completeExtraction(
      ctx,
      group,
      0,
      { extractorVersion: "facebook-dom-v2" },
    );

    expect(thirdWithoutBaseline.health).toBe("empty");
    expect(thirdWithoutBaseline.driftDetected).toBe(false);

    completeExtraction(ctx, group, 1, { extractorVersion: "facebook-dom-v2" });
    completeExtraction(ctx, group, 0, { extractorVersion: "facebook-dom-v2" });
    completeExtraction(ctx, group, 0, { extractorVersion: "facebook-dom-v2" });
    const drift = completeExtraction(ctx, group, 0, { extractorVersion: "facebook-dom-v2" });
    expect(drift.health).toBe("suspected_drift");
    expect(drift.driftDetected).toBe(true);
  });

  it("does not count a failed scan attempt toward the empty success streak", () => {
    completeExtraction(ctx, group, 1);
    completeExtraction(ctx, group, 0);
    ctx.store.enqueueScanNow(group.id);
    const claimed = ctx.store.claimNextJob("worker", 60_000)!;
    const leaseToken = claimed.leaseToken!;
    const scan = ctx.store.startScanRunForJob(group.id, claimed.id, leaseToken);
    ctx.store.recordScanExtraction(scan.id, claimed.id, leaseToken, {
      extractorVersion: "facebook-dom-v1",
      authState: "authenticated",
      currentUrl: group.url,
      snapshotChecks: 1,
      scrollRounds: 0,
      postsExtracted: 0,
      pageErrorCount: 0,
    });
    ctx.store.finishFailedScanAndJob(
      scan.id,
      claimed.id,
      leaseToken,
      { postsSeen: 0, postsNew: 0, decisionsCreated: 0 },
      "Downstream classifier failed",
      new Date(Date.now() + 60_000).toISOString(),
      undefined,
    );

    expect(ctx.store.getGroup(group.id).emptyScanStreak).toBe(1);
    expect(completeExtraction(ctx, group, 0).emptyScanStreak).toBe(2);
  });

  it("records recovery when an extractor error occurs between drift and success", () => {
    completeExtraction(ctx, group, 1);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    completeExtraction(ctx, group, 0);
    ctx.store.enqueueScanNow(group.id);
    const claimed = ctx.store.claimNextJob("worker", 60_000)!;
    const leaseToken = claimed.leaseToken!;
    const scan = ctx.store.startScanRunForJob(group.id, claimed.id, leaseToken);
    ctx.store.recordScanExtractionFailure(
      scan.id,
      claimed.id,
      leaseToken,
      "facebook-dom-v1",
      "snapshot_failed",
    );
    ctx.store.finishFailedScanAndJob(
      scan.id,
      claimed.id,
      leaseToken,
      { postsSeen: 0, postsNew: 0, decisionsCreated: 0 },
      "Snapshot failed",
      new Date(Date.now() + 60_000).toISOString(),
      undefined,
    );

    expect(ctx.store.getGroup(group.id).extractionHealth).toBe("error");
    const recovered = completeExtraction(ctx, group, 1);
    expect(recovered.recovered).toBe(true);
    expect(ctx.store.listAuditEvents(100)
      .filter((event) => event.type === "extractor.recovered")).toHaveLength(1);
  });

  it("persists classified extractor failures", () => {
    const job = ctx.store.enqueueScanNow(group.id);
    const claimed = ctx.store.claimNextJob("worker", 60_000)!;
    expect(claimed.id).toBe(job.id);
    const scan = ctx.store.startScanRunForJob(group.id, claimed.id, claimed.leaseToken!);

    ctx.store.recordScanExtractionFailure(
      scan.id,
      claimed.id,
      claimed.leaseToken!,
      "facebook-dom-v1",
      "invalid_result",
    );
    ctx.store.finishFailedScanAndJob(
      scan.id,
      claimed.id,
      claimed.leaseToken!,
      { postsSeen: 0, postsNew: 0, decisionsCreated: 0 },
      "Extractor returned invalid data",
      new Date().toISOString(),
      undefined,
    );

    const updatedGroup = ctx.store.getGroup(group.id);
    expect(updatedGroup.extractionHealth).toBe("error");
    expect(ctx.store.summary().extractionErrorGroups).toBe(1);
    const storedScan = ctx.store.listScanRuns(1)[0]!;
    expect(storedScan.extractorVersion).toBe("facebook-dom-v1");
    expect(storedScan.extractionErrorCategory).toBe("invalid_result");
    expect(ctx.store.listAuditEvents(100)
      .some((event) => event.type === "extractor.failed")).toBe(true);
  });

  it("resets extraction health when a group changes account", async () => {
    completeExtraction(ctx, group, 0);
    await ctx.store.add({
      id: "target",
      label: "Target",
      camofoxUserId: "profile-target",
      sessionKey: "facebook-main",
    });

    const moved = ctx.store.moveGroup(group.id, "target");

    expect(moved.extractionHealth).toBe("unknown");
    expect(moved.emptyScanStreak).toBe(0);
    expect(moved.extractorVersion).toBeUndefined();
    expect(moved.lastExtractionAt).toBeUndefined();
  });
});

function completeExtraction(
  ctx: TestContext,
  group: MonitoredGroup,
  postsExtracted: number,
  overrides: Partial<{
    extractorVersion: string;
    snapshotChecks: number;
    scrollRounds: number;
    pageErrorCount: number;
  }> = {},
): NonNullable<ReturnType<TestContext["store"]["finishSuccessfulScan"]>["extraction"]> {
  const job = ctx.store.enqueueScanNow(group.id);
  const claimed = ctx.store.claimNextJob("worker", 60_000)!;
  expect(claimed.id).toBe(job.id);
  const leaseToken = claimed.leaseToken!;
  const scan = ctx.store.startScanRunForJob(group.id, claimed.id, leaseToken);
  ctx.store.recordScanExtraction(
    scan.id,
    claimed.id,
    leaseToken,
    {
      extractorVersion: overrides.extractorVersion ?? "facebook-dom-v1",
      authState: "authenticated",
      currentUrl: group.url,
      snapshotChecks: overrides.snapshotChecks ?? 1,
      scrollRounds: overrides.scrollRounds ?? 0,
      postsExtracted,
      pageErrorCount: overrides.pageErrorCount ?? 0,
    },
  );
  if (postsExtracted > 0) {
    ctx.store.upsertPostForJob(claimed.id, leaseToken, group.id, {
      externalId: `post-${job.id}`,
      url: `${group.url}/posts/${job.id}`,
      content: "Known-good extraction result used by the drift diagnostic test.",
    });
  }
  const completion = ctx.store.finishSuccessfulScan(
    scan.id,
    claimed.id,
    leaseToken,
    { postsSeen: postsExtracted, postsNew: postsExtracted > 0 ? 1 : 0, decisionsCreated: 0 },
  );
  expect(completion.extraction).toBeDefined();
  return completion.extraction!;
}
