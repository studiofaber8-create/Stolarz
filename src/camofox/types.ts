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
}
