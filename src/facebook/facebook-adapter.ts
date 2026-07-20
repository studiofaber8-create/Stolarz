import type { ReadOnlyBrowserGateway } from "../camofox/read-only-gateway.js";
import type {
  DiscoveredPostInput,
  MonitoredGroup,
  ScanExtractionDiagnostics,
} from "../domain/monitoring.js";
import { FacebookSessionManager } from "../session/facebook-session-manager.js";
import {
  FACEBOOK_EXTRACTOR_VERSION,
  inspectFacebookState,
  normalizeExtractedPosts,
  postExtractionExpression,
  type FacebookAuthState,
  type FacebookSessionInspection,
} from "./facebook-extractor.js";

export {
  FACEBOOK_EXTRACTOR_VERSION,
  inspectFacebookState,
  normalizeExtractedPosts,
  postExtractionExpression,
} from "./facebook-extractor.js";
export type { FacebookAuthState, FacebookSessionInspection } from "./facebook-extractor.js";

export type FacebookExtractionErrorCategory =
  | "network_wait_failed"
  | "snapshot_wait_failed"
  | "snapshot_failed"
  | "evaluation_failed"
  | "invalid_result"
  | "scroll_failed"
  | "scroll_wait_failed"
  | "page_errors_failed";

export type FacebookExtractionDiagnostics = Omit<ScanExtractionDiagnostics, "currentUrl">;

export interface FacebookGroupScanResult {
  readonly currentUrl: string;
  readonly authState: FacebookAuthState;
  readonly posts: DiscoveredPostInput[];
  readonly pageErrors: readonly string[];
  readonly diagnostics: FacebookExtractionDiagnostics;
}

export class FacebookSessionStateError extends Error {
  public constructor(
    public readonly state: Exclude<FacebookAuthState, "authenticated">,
    message: string,
  ) {
    super(message);
    this.name = "FacebookSessionStateError";
  }
}

export class FacebookExtractionError extends Error {
  public constructor(
    public readonly category: FacebookExtractionErrorCategory,
    message: string,
    public readonly extractorVersion = FACEBOOK_EXTRACTOR_VERSION,
  ) {
    super(message);
    this.name = "FacebookExtractionError";
  }
}

interface ReadyInspection {
  readonly inspection: FacebookSessionInspection;
  readonly snapshotChecks: number;
}

export class FacebookAdapter {
  public constructor(
    private readonly sessions: FacebookSessionManager,
    private readonly camofox: ReadOnlyBrowserGateway,
  ) {}

  public async inspectSession(accountId: string): Promise<FacebookSessionInspection> {
    const inspection = await this.sessions.runWithRegisteredAccountTab(
      accountId,
      "https://www.facebook.com/",
      async ({ account, tab }) => {
        const navigation = await this.camofox.navigate(
          account.camofoxUserId,
          tab.id,
          "https://www.facebook.com/",
        );
        const ready = await this.waitForRecognizablePage(
          account.camofoxUserId,
          tab.id,
          navigation.url ?? "https://www.facebook.com/",
        );
        return ready.inspection;
      },
    );
    await this.sessions.recordAccountInspection(
      accountId,
      inspection.state === "access_denied" ? "unknown" : inspection.state,
      inspection.reason,
    );
    return inspection;
  }

  public async scanGroup(group: MonitoredGroup): Promise<FacebookGroupScanResult> {
    return this.sessions.runWithAccountTab(
      group.accountId,
      group.url,
      async ({ account, tab }) => {
        const navigation = await this.camofox.navigate(
          account.camofoxUserId,
          tab.id,
          group.url,
        );
        const currentUrl = navigation.url ?? group.url;
        const ready = await this.waitForRecognizablePage(
          account.camofoxUserId,
          tab.id,
          currentUrl,
        );
        const inspection = ready.inspection;
        if (inspection.state !== "authenticated" && inspection.state !== "unknown") {
          if (inspection.state !== "access_denied") {
            await this.sessions.recordAccountInspection(
              account.id,
              inspection.state,
              inspection.reason,
            );
          }
          throw new FacebookSessionStateError(inspection.state, inspection.reason);
        }

        const extraction = await this.extractPostsAdaptively(
          account.camofoxUserId,
          tab.id,
          group.maxPostsPerScan,
        );
        const posts = extraction.posts;
        if (inspection.state === "unknown" && posts.length === 0) {
          await this.sessions.recordAccountInspection(account.id, "unknown", inspection.reason);
          throw new FacebookSessionStateError(
            "unknown",
            "Nie udało się potwierdzić zalogowania ani odczytać postów z grupy",
          );
        }

        const authState = posts.length > 0 ? "authenticated" : inspection.state;
        await this.sessions.recordAccountInspection(account.id, authState, inspection.reason);
        let pageErrors: readonly string[];
        try {
          pageErrors = (await this.camofox.pageErrors(account.camofoxUserId, tab.id, 20))
            .map(({ message }) => message.slice(0, 500));
        } catch (error) {
          throw extractionError("page_errors_failed", "Facebook page error diagnostics failed", error);
        }
        return {
          currentUrl,
          authState,
          posts,
          pageErrors,
          diagnostics: {
            extractorVersion: FACEBOOK_EXTRACTOR_VERSION,
            authState,
            snapshotChecks: ready.snapshotChecks,
            scrollRounds: extraction.scrollRounds,
            postsExtracted: posts.length,
            pageErrorCount: pageErrors.length,
          },
        };
      },
    );
  }

  private async waitForRecognizablePage(
    userId: string,
    tabId: string,
    currentUrl: string,
  ): Promise<ReadyInspection> {
    try {
      await this.camofox.wait(userId, tabId, { timeout: 750, waitForNetwork: true });
    } catch (error) {
      throw extractionError("network_wait_failed", "Facebook network readiness wait failed", error);
    }
    const retryDelays = [0, 350, 700, 1_200] as const;
    let lastInspection = inspectFacebookState(currentUrl, "");
    for (let index = 0; index < retryDelays.length; index += 1) {
      const delay = retryDelays[index] ?? 0;
      if (delay > 0) {
        try {
          await this.camofox.wait(userId, tabId, { timeout: delay });
        } catch (error) {
          throw extractionError("snapshot_wait_failed", "Facebook snapshot retry wait failed", error);
        }
      }
      let snapshot;
      try {
        snapshot = await this.camofox.snapshot(userId, tabId);
      } catch (error) {
        throw extractionError("snapshot_failed", "Facebook page snapshot failed", error);
      }
      lastInspection = inspectFacebookState(currentUrl, snapshot.text);
      if (lastInspection.state !== "unknown") {
        return { inspection: lastInspection, snapshotChecks: index + 1 };
      }
    }
    return { inspection: lastInspection, snapshotChecks: retryDelays.length };
  }

  private async extractPostsAdaptively(
    userId: string,
    tabId: string,
    limit: number,
  ): Promise<{ posts: DiscoveredPostInput[]; scrollRounds: number }> {
    const discoveredPosts = new Map<string, DiscoveredPostInput>();
    let scrollRounds = 0;

    for (let evaluationRound = 0; evaluationRound < 4; evaluationRound += 1) {
      let value: unknown;
      try {
        const evaluation = await this.camofox.evaluate<unknown>(
          userId,
          tabId,
          postExtractionExpression(limit),
          20_000,
        );
        value = evaluation.value;
      } catch (error) {
        throw extractionError("evaluation_failed", "Facebook DOM evaluation failed", error);
      }
      if (!Array.isArray(value)) {
        throw new FacebookExtractionError(
          "invalid_result",
          `Facebook extractor returned a non-array result (${FACEBOOK_EXTRACTOR_VERSION})`,
        );
      }

      const roundPosts = normalizeExtractedPosts(value, limit);
      let newPostCount = 0;
      for (const post of roundPosts) {
        if (!discoveredPosts.has(post.externalId)) newPostCount += 1;
        discoveredPosts.set(post.externalId, post);
      }
      if (discoveredPosts.size >= limit) break;
      if (discoveredPosts.size > 0 && newPostCount === 0) break;
      if (evaluationRound === 3) break;

      try {
        await this.camofox.scroll(userId, tabId, { direction: "down", amount: 900 });
      } catch (error) {
        throw extractionError("scroll_failed", "Facebook feed scroll failed", error);
      }
      scrollRounds += 1;
      try {
        await this.camofox.wait(userId, tabId, { timeout: 350 + evaluationRound * 250 });
      } catch (error) {
        throw extractionError("scroll_wait_failed", "Facebook post-scroll wait failed", error);
      }
    }

    return { posts: [...discoveredPosts.values()].slice(0, limit), scrollRounds };
  }
}

function extractionError(
  category: FacebookExtractionErrorCategory,
  context: string,
  error: unknown,
): FacebookExtractionError {
  const message = error instanceof Error ? error.message : String(error);
  return new FacebookExtractionError(
    category,
    `${context} (${FACEBOOK_EXTRACTOR_VERSION}): ${message}`,
  );
}
