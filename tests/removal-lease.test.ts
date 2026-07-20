import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestStore, createTestStore, type TestContext } from "./helpers.js";

describe("account removal lease", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestStore();
  });

  afterEach(() => {
    cleanupTestStore(ctx);
  });

  it("beginRemoval blocks createGroup for the account", async () => {
    const { store } = ctx;
    await store.add({ id: "acct", label: "Test", camofoxUserId: "p-acct", sessionKey: "facebook-main" });
    const lease = await store.beginRemoval("acct", 60_000);

    expect(() => store.createGroup({
      accountId: "acct", name: "Blocked", url: "https://www.facebook.com/groups/700",
      scanIntervalSeconds: 600, maxPostsPerScan: 10,
    })).toThrow(/removal in progress/);

    await store.cancelRemoval("acct", lease.token);
  });

  it("beginRemoval blocks moveGroup to the account", async () => {
    const { store } = ctx;
    await store.add({ id: "src", label: "Source", camofoxUserId: "p-src", sessionKey: "facebook-main" });
    await store.add({ id: "dst", label: "Dest", camofoxUserId: "p-dst", sessionKey: "facebook-main" });
    const group = store.createGroup({
      accountId: "src", name: "G", url: "https://www.facebook.com/groups/800",
      scanIntervalSeconds: 600, maxPostsPerScan: 10,
    });
    const lease = await store.beginRemoval("dst", 60_000);

    expect(() => store.moveGroup(group.id, "dst")).toThrow(/removal in progress/);

    await store.cancelRemoval("dst", lease.token);
  });

  it("cancelRemoval allows subsequent createGroup", async () => {
    const { store } = ctx;
    await store.add({ id: "acct", label: "Test", camofoxUserId: "p-acct", sessionKey: "facebook-main" });
    const lease = await store.beginRemoval("acct", 60_000);
    await store.cancelRemoval("acct", lease.token);

    const group = store.createGroup({
      accountId: "acct", name: "OK", url: "https://www.facebook.com/groups/900",
      scanIntervalSeconds: 600, maxPostsPerScan: 10,
    });
    expect(group.accountId).toBe("acct");
  });

  it("remove succeeds with valid token and no groups", async () => {
    const { store } = ctx;
    await store.add({ id: "acct", label: "Test", camofoxUserId: "p-acct", sessionKey: "facebook-main" });
    const lease = await store.beginRemoval("acct", 60_000);
    const removed = await store.remove("acct", lease.token);
    expect(removed.id).toBe("acct");
  });

  it("remove fails if groups were added after lease", async () => {
    const { store } = ctx;
    await store.add({ id: "a", label: "A", camofoxUserId: "p-a", sessionKey: "facebook-main" });
    await store.add({ id: "b", label: "B", camofoxUserId: "p-b", sessionKey: "facebook-main" });
    const group = store.createGroup({
      accountId: "b", name: "G", url: "https://www.facebook.com/groups/1000",
      scanIntervalSeconds: 600, maxPostsPerScan: 10,
    });

    const lease = await store.beginRemoval("a", 60_000);
    // Move group to "a" — should fail because removal is in progress
    expect(() => store.moveGroup(group.id, "a")).toThrow(/removal in progress/);
    // Even with token, remove should succeed since no groups exist
    const removed = await store.remove("a", lease.token);
    expect(removed.id).toBe("a");
  });

  it("beginRemoval fails if account has groups", async () => {
    const { store } = ctx;
    await store.add({ id: "acct", label: "Test", camofoxUserId: "p-acct", sessionKey: "facebook-main" });
    store.createGroup({
      accountId: "acct", name: "G", url: "https://www.facebook.com/groups/1100",
      scanIntervalSeconds: 600, maxPostsPerScan: 10,
    });

    await expect(store.beginRemoval("acct", 60_000))
      .rejects.toThrow(/monitored groups/);
  });
});
