/**
 * ReadOnlyBrowserGateway — strict subset of CamofoxClient that ONLY exposes
 * navigation, snapshot, scrolling, evaluation and diagnostics.
 *
 * This interface is the sole browser access surface passed to FacebookAdapter
 * and any worker code. It deliberately excludes click, type, press, screenshot
 * and any other action that could mutate page state or publish content.
 *
 * Design rationale: even though the adapter currently does not call publishing
 * methods, having a typed boundary ensures that future refactoring cannot
 * accidentally introduce write operations.
 */

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
} from "./types.js";

export interface ReadOnlyBrowserGateway {
  health(): Promise<CamofoxHealth>;
  createTab(input: CreateTabInput): Promise<CamofoxTab>;
  listTabs(userId: string): Promise<CamofoxTab[]>;
  navigate(userId: string, tabId: string, url: string): Promise<NavigationResult>;
  snapshot(userId: string, tabId: string, offset?: number): Promise<SnapshotResult>;
  wait(userId: string, tabId: string, input?: WaitInput): Promise<void>;
  scroll(userId: string, tabId: string, input: ScrollInput): Promise<void>;
  evaluate<T>(userId: string, tabId: string, expression: string, timeout?: number): Promise<EvaluationResult<T>>;
  pageErrors(userId: string, tabId: string, limit?: number): Promise<CamofoxPageError[]>;
  closeTab(userId: string, tabId: string): Promise<void>;
  closeSession(userId: string): Promise<void>;
  toggleDisplay(userId: string, mode: DisplayMode): Promise<DisplayResult>;
}

/**
 * Asserts at compile-time that CamofoxClient satisfies ReadOnlyBrowserGateway.
 * This is a pure type-level check; it has zero runtime cost.
 */
import type { CamofoxClient } from "./client.js";
export type _AssertCamofoxImplementsGateway = CamofoxClient extends ReadOnlyBrowserGateway ? true : never;
