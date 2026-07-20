import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadOnlyBrowserGateway } from "../src/camofox/read-only-gateway.js";
import type {
  CamofoxHealth,
  CamofoxPageError,
  CamofoxTab,
  CreateTabInput,
  DisplayMode,
  DisplayResult,
  EvaluationResult,
  NavigationResult,
  ScrollInput,
  SnapshotResult,
  WaitInput,
} from "../src/camofox/types.js";
import type { AppConfig } from "../src/config.js";
import {
  FacebookAdapter,
  FacebookExtractionError,
} from "../src/facebook/facebook-adapter.js";
import { FacebookSessionManager } from "../src/session/facebook-session-manager.js";
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
    businessDescription: "test",
  },
};

describe("FacebookAdapter adaptive behavior", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestStore();
    await ctx.store.add({
      id: "account",
      label: "Account",
      camofoxUserId: "test-account",
      sessionKey: "facebook-main",
    });
  });

  afterEach(() => cleanupTestStore(ctx));

  it("polls snapshots until the session state becomes recognizable", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Facebook Groups", "Aktualności — Utwórz post — Menu konta"],
    });
    const adapter = createAdapter(ctx, browser);

    const result = await adapter.inspectSession("account");

    expect(result.state).toBe("authenticated");
    expect(browser.snapshotCalls).toBe(2);
    expect(browser.waitCalls.some((input) => input.timeout === 350)).toBe(true);
  });

  it("stops snapshot polling immediately for a terminal auth state", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Zaloguj się do Facebooka. Adres e-mail lub numer telefonu"],
      navigationUrl: "https://www.facebook.com/login/",
    });
    const adapter = createAdapter(ctx, browser);

    const result = await adapter.inspectSession("account");

    expect(result.state).toBe("login_required");
    expect(browser.snapshotCalls).toBe(1);
  });

  it("scrolls and reevaluates until post results stabilize", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Aktualności — Utwórz post"],
      evaluations: [
        [],
        [{
          externalId: "post-1",
          url: "https://www.facebook.com/groups/123/posts/1",
          content: "Potrzebuję kuchni na wymiar do nowego mieszkania.",
        }],
        [{
          externalId: "post-1",
          url: "https://www.facebook.com/groups/123/posts/1",
          content: "Potrzebuję kuchni na wymiar do nowego mieszkania.",
        }],
      ],
    });
    const adapter = createAdapter(ctx, browser);
    const group = ctx.store.createGroup({
      accountId: "account",
      name: "Group",
      url: "https://www.facebook.com/groups/123",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });

    const result = await adapter.scanGroup(group);

    expect(result.posts).toHaveLength(1);
    expect(result.diagnostics.scrollRounds).toBe(2);
    expect(result.diagnostics.snapshotChecks).toBe(1);
    expect(result.diagnostics.extractorVersion).toBe("facebook-dom-v1");
    expect(browser.evaluateCalls).toBe(3);
  });

  it("aggregates posts across virtualized feed windows before stabilizing", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Aktualności — Utwórz post"],
      evaluations: [
        [{
          externalId: "post-a",
          url: "https://www.facebook.com/groups/123/posts/a",
          content: "Pierwszy post widoczny przed przewinięciem.",
        }],
        [{
          externalId: "post-b",
          url: "https://www.facebook.com/groups/123/posts/b",
          content: "Drugi post zastąpił pierwszy w zwirtualizowanym DOM.",
        }],
        [{
          externalId: "post-b",
          url: "https://www.facebook.com/groups/123/posts/b",
          content: "Drugi post zastąpił pierwszy w zwirtualizowanym DOM.",
        }],
      ],
    });
    const adapter = createAdapter(ctx, browser);
    const group = ctx.store.createGroup({
      accountId: "account",
      name: "Virtualized group",
      url: "https://www.facebook.com/groups/123",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });

    const result = await adapter.scanGroup(group);

    expect(result.posts.map((post) => post.externalId)).toEqual(["post-a", "post-b"]);
    expect(result.diagnostics.scrollRounds).toBe(2);
    expect(browser.evaluateCalls).toBe(3);
  });

  it("classifies every browser operation failure in the extraction pipeline", async () => {
    const cases = [
      {
        options: { waitErrorAfterCall: 0 },
        category: "network_wait_failed",
      },
      {
        options: {
          snapshots: ["Facebook Groups"],
          waitErrorAfterCall: 1,
        },
        category: "snapshot_wait_failed",
      },
      {
        options: { snapshotError: new Error("snapshot unavailable") },
        category: "snapshot_failed",
      },
      {
        options: {
          evaluations: [[{
            externalId: "post-1",
            url: "https://www.facebook.com/groups/123/posts/1",
            content: "Post before scroll failure.",
          }]],
          scrollError: new Error("scroll unavailable"),
        },
        category: "scroll_failed",
      },
      {
        options: {
          evaluations: [[{
            externalId: "post-1",
            url: "https://www.facebook.com/groups/123/posts/1",
            content: "Post before scroll wait failure.",
          }]],
          waitErrorAfterCall: 1,
        },
        category: "scroll_wait_failed",
      },
      {
        options: {
          evaluations: [[{
            externalId: "post-1",
            url: "https://www.facebook.com/groups/123/posts/1",
            content: "Post before page diagnostics failure.",
          }], [{
            externalId: "post-1",
            url: "https://www.facebook.com/groups/123/posts/1",
            content: "Post before page diagnostics failure.",
          }]],
          pageErrorsError: new Error("diagnostics unavailable"),
        },
        category: "page_errors_failed",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const browser = new FakeReadOnlyBrowser(testCase.options);
      const adapter = createAdapter(ctx, browser);
      const group = ctx.store.createGroup({
        accountId: "account",
        name: `Failure ${index}`,
        url: `https://www.facebook.com/groups/failure-${index}`,
        scanIntervalSeconds: 600,
        maxPostsPerScan: 10,
      });

      const error = await adapter.scanGroup(group).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FacebookExtractionError);
      expect((error as FacebookExtractionError).category).toBe(testCase.category);
    }
  });

  it("classifies a non-array extractor response", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Aktualności — Utwórz post"],
      evaluations: [{ unexpected: true }],
    });
    const adapter = createAdapter(ctx, browser);
    const group = ctx.store.createGroup({
      accountId: "account",
      name: "Group",
      url: "https://www.facebook.com/groups/124",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });

    const error = await adapter.scanGroup(group).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FacebookExtractionError);
    expect((error as FacebookExtractionError).category).toBe("invalid_result");
  });

  it("classifies browser evaluation failures", async () => {
    const browser = new FakeReadOnlyBrowser({
      snapshots: ["Aktualności — Utwórz post"],
      evaluationError: new Error("browser context destroyed"),
    });
    const adapter = createAdapter(ctx, browser);
    const group = ctx.store.createGroup({
      accountId: "account",
      name: "Group",
      url: "https://www.facebook.com/groups/125",
      scanIntervalSeconds: 600,
      maxPostsPerScan: 10,
    });

    const error = await adapter.scanGroup(group).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FacebookExtractionError);
    expect((error as FacebookExtractionError).category).toBe("evaluation_failed");
    expect((error as Error).message).toContain("browser context destroyed");
  });
});

function createAdapter(ctx: TestContext, browser: ReadOnlyBrowserGateway): FacebookAdapter {
  const sessions = new FacebookSessionManager(config, ctx.store, browser);
  return new FacebookAdapter(sessions, browser);
}

class FakeReadOnlyBrowser implements ReadOnlyBrowserGateway {
  public snapshotCalls = 0;
  public evaluateCalls = 0;
  public scrollCalls = 0;
  public readonly waitCalls: WaitInput[] = [];

  private readonly snapshots: string[];
  private readonly evaluations: unknown[];
  private readonly navigationUrl: string;
  private readonly evaluationError: Error | undefined;
  private readonly snapshotError: Error | undefined;
  private readonly scrollError: Error | undefined;
  private readonly pageErrorsError: Error | undefined;
  private readonly waitErrorAfterCall: number | undefined;

  public constructor(options: {
    snapshots?: string[];
    evaluations?: unknown[];
    navigationUrl?: string;
    evaluationError?: Error;
    snapshotError?: Error;
    scrollError?: Error;
    pageErrorsError?: Error;
    waitErrorAfterCall?: number;
  } = {}) {
    this.snapshots = options.snapshots ?? ["Aktualności — Utwórz post"];
    this.evaluations = options.evaluations ?? [[]];
    this.navigationUrl = options.navigationUrl ?? "https://www.facebook.com/groups/123";
    this.evaluationError = options.evaluationError;
    this.snapshotError = options.snapshotError;
    this.scrollError = options.scrollError;
    this.pageErrorsError = options.pageErrorsError;
    this.waitErrorAfterCall = options.waitErrorAfterCall;
  }

  public async health(): Promise<CamofoxHealth> {
    return { ok: true, raw: {} };
  }

  public async createTab(input: CreateTabInput): Promise<CamofoxTab> {
    return { id: "tab-1", url: input.url, raw: {} };
  }

  public async listTabs(_userId: string): Promise<CamofoxTab[]> {
    return [];
  }

  public async navigate(_userId: string, _tabId: string, _url: string): Promise<NavigationResult> {
    return { ok: true, url: this.navigationUrl, raw: {} };
  }

  public async snapshot(_userId: string, _tabId: string): Promise<SnapshotResult> {
    if (this.snapshotError !== undefined) throw this.snapshotError;
    const index = Math.min(this.snapshotCalls, this.snapshots.length - 1);
    this.snapshotCalls += 1;
    return { text: this.snapshots[index] ?? "", raw: {} };
  }

  public async wait(_userId: string, _tabId: string, input: WaitInput = {}): Promise<void> {
    this.waitCalls.push(input);
    if (
      this.waitErrorAfterCall !== undefined &&
      this.waitCalls.length > this.waitErrorAfterCall
    ) {
      throw new Error("wait unavailable");
    }
  }

  public async scroll(_userId: string, _tabId: string, _input: ScrollInput): Promise<void> {
    if (this.scrollError !== undefined) throw this.scrollError;
    this.scrollCalls += 1;
  }

  public async evaluate<T>(
    _userId: string,
    _tabId: string,
    _expression: string,
    _timeout?: number,
  ): Promise<EvaluationResult<T>> {
    this.evaluateCalls += 1;
    if (this.evaluationError !== undefined) throw this.evaluationError;
    const index = Math.min(this.evaluateCalls - 1, this.evaluations.length - 1);
    return { value: this.evaluations[index] as T, raw: {} };
  }

  public async pageErrors(_userId: string, _tabId: string, _limit?: number): Promise<CamofoxPageError[]> {
    if (this.pageErrorsError !== undefined) throw this.pageErrorsError;
    return [];
  }

  public async closeTab(_userId: string, _tabId: string): Promise<void> {}
  public async closeSession(_userId: string): Promise<void> {}

  public async toggleDisplay(_userId: string, mode: DisplayMode): Promise<DisplayResult> {
    return { ok: true, mode, raw: {} };
  }
}
