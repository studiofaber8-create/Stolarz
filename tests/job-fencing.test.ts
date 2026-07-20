import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

describe("job fencing and per-account serialization", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestStore();
    const { store } = ctx;
    await store.add({ id: "acct-a", label: "A", camofoxUserId: "p-a", sessionKey: "facebook-main" });
    await store.add({ id: "acct-b", label: "B", camofoxUserId: "p-b", sessionKey: "facebook-main" });
  });

  afterEach(() => {
    cleanupTestStore(ctx);
  });

  describe("per-account claim serialization", () => {
    it("does not claim second job for the same account", () => {
      const { store } = ctx;
      const g1 = store.createGroup({
        accountId: "acct-a", name: "G1", url: "https://www.facebook.com/groups/2001",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      const g2 = store.createGroup({
        accountId: "acct-a", name: "G2", url: "https://www.facebook.com/groups/2002",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      store.enqueueScanNow(g1.id);
      store.enqueueScanNow(g2.id);

      const first = store.claimNextJob("w1", 60_000);
      expect(first).toBeDefined();

      const second = store.claimNextJob("w2", 60_000);
      expect(second).toBeUndefined();
    });

    it("allows claiming from a different account in parallel", () => {
      const { store } = ctx;
      const ga = store.createGroup({
        accountId: "acct-a", name: "GA", url: "https://www.facebook.com/groups/2003",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      const gb = store.createGroup({
        accountId: "acct-b", name: "GB", url: "https://www.facebook.com/groups/2004",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      store.enqueueScanNow(ga.id);
      store.enqueueScanNow(gb.id);

      const first = store.claimNextJob("w1", 60_000);
      expect(first).toBeDefined();

      const second = store.claimNextJob("w2", 60_000);
      expect(second).toBeDefined();

      const firstAccount = store.getGroup(first!.groupId).accountId;
      const secondAccount = store.getGroup(second!.groupId).accountId;
      expect(firstAccount).not.toBe(secondAccount);
    });
  });

  describe("group transfer fencing", () => {
    it("transfer kills active jobs and resets group", () => {
      const { store } = ctx;
      const group = store.createGroup({
        accountId: "acct-a", name: "Transfer", url: "https://www.facebook.com/groups/2005",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      store.enqueueScanNow(group.id);
      const claimed = store.claimNextJob("w1", 60_000)!;

      const moved = store.moveGroup(group.id, "acct-b");
      expect(moved.accountId).toBe("acct-b");
      expect(moved.lastStatus).toBe("never");

      const job = store.listJobs().find(j => j.id === claimed.id);
      expect(job?.status).toBe("dead");
    });

    it("worker loses lease after group transfer", () => {
      const { store } = ctx;
      const group = store.createGroup({
        accountId: "acct-a", name: "Fence", url: "https://www.facebook.com/groups/2006",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      store.enqueueScanNow(group.id);
      const claimed = store.claimNextJob("w1", 60_000)!;

      store.moveGroup(group.id, "acct-b");

      expect(() => store.assertJobLease(claimed.id, claimed.leaseToken!))
        .toThrow(/lease lost/);
    });
  });

  describe("lease expiry and recovery", () => {
    it("expired lease job returns to queue on next claim", () => {
      const { store } = ctx;
      const group = store.createGroup({
        accountId: "acct-a", name: "Expiry", url: "https://www.facebook.com/groups/2007",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      store.enqueueScanNow(group.id);
      // Claim with very short lease
      const claimed = store.claimNextJob("w1", 1_000)!;

      // Wait for lease to expire (simulate by manipulating DB)
      const db = (store as any).database;
      db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?")
        .run(new Date(Date.now() - 10_000).toISOString(), claimed.id);

      // Next claim should recover the expired job
      const reclaimed = store.claimNextJob("w2", 60_000);
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.id).toBe(claimed.id);
      expect(reclaimed!.leaseOwner).toBe("w2");
    });
  });

  describe("idempotent post upsert", () => {
    it("second upsert with same content is not flagged as new", () => {
      const { store } = ctx;
      const group = store.createGroup({
        accountId: "acct-a", name: "Idem", url: "https://www.facebook.com/groups/2008",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      const input = {
        externalId: "post-1",
        url: "https://www.facebook.com/groups/2008/posts/123",
        content: "This is a test post with enough content to pass validation",
      };

      const first = store.upsertPost(group.id, input);
      expect(first.isNew).toBe(true);
      expect(first.contentChanged).toBe(false);

      const second = store.upsertPost(group.id, input);
      expect(second.isNew).toBe(false);
      expect(second.contentChanged).toBe(false);
    });

    it("content change invalidates existing drafts", () => {
      const { store } = ctx;
      const group = store.createGroup({
        accountId: "acct-a", name: "Change", url: "https://www.facebook.com/groups/2009",
        scanIntervalSeconds: 600, maxPostsPerScan: 10,
      });
      const first = store.upsertPost(group.id, {
        externalId: "post-2",
        url: "https://www.facebook.com/groups/2009/posts/456",
        content: "Original content that is long enough for validation",
      });
      expect(first.isNew).toBe(true);

      const second = store.upsertPost(group.id, {
        externalId: "post-2",
        url: "https://www.facebook.com/groups/2009/posts/456",
        content: "Updated content that differs from the original one completely",
      });
      expect(second.isNew).toBe(false);
      expect(second.contentChanged).toBe(true);
    });
  });
});
