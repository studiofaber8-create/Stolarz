export type DisplayMode = boolean | "virtual";

export interface CamofoxHealth {
  readonly ok: boolean;
  readonly engine?: string;
  readonly browserConnected?: boolean;
  readonly raw: unknown;
}

export interface CamofoxTab {
  readonly id: string;
  readonly url?: string;
  readonly title?: string;
  readonly raw: unknown;
}

export interface DisplayResult {
  readonly ok: boolean;
  readonly mode: DisplayMode;
  readonly vncUrl?: string;
  readonly message?: string;
  readonly raw: unknown;
}

export interface CreateTabInput {
  readonly userId: string;
  readonly sessionKey: string;
  readonly url: string;
  readonly preset?: string;
  readonly proxyProfile?: string;
}

export interface NavigationResult {
  readonly ok: boolean;
  readonly url?: string;
  readonly raw: unknown;
}

export interface SnapshotResult {
  readonly text: string;
  readonly nextOffset?: number;
  readonly raw: unknown;
}

export interface InteractionTarget {
  readonly ref?: string;
  readonly selector?: string;
}

export interface WaitInput {
  readonly timeout?: number;
  readonly waitForNetwork?: boolean;
}

export interface ScrollInput {
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
}

export interface EvaluationResult<T> {
  readonly value: T;
  readonly raw: unknown;
}

export interface CamofoxPageError {
  readonly message: string;
  readonly type?: string;
  readonly timestamp?: string;
}
