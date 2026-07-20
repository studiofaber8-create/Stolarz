export const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;

export type FacebookAccountAuthState =
  | "unknown"
  | "authenticated"
  | "login_required"
  | "checkpoint"
  | "blocked";

export interface FacebookAccount {
  readonly id: string;
  readonly label: string;
  readonly camofoxUserId: string;
  readonly sessionKey: string;
  readonly enabled: boolean;
  readonly authState: FacebookAccountAuthState;
  readonly recoveryRequired: boolean;
  readonly lastInspectedAt?: string;
  readonly lastAuthError?: string;
  readonly disabledReason?: string;
  readonly recoveredAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountRemovalLease {
  readonly account: FacebookAccount;
  readonly token: string;
}

export interface AccountRepository {
  list(): Promise<FacebookAccount[]>;
  get(accountId: string): Promise<FacebookAccount>;
  add(input: {
    id: string;
    label: string;
    camofoxUserId: string;
    sessionKey: string;
  }): Promise<FacebookAccount>;
  recordInspection(
    accountId: string,
    state: FacebookAccountAuthState,
    reason: string,
  ): Promise<FacebookAccount>;
  beginRemoval(accountId: string, leaseMs: number): Promise<AccountRemovalLease>;
  cancelRemoval(accountId: string, token: string): Promise<void>;
  remove(accountId: string, token: string): Promise<FacebookAccount>;
}

export function assertAccountId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Account id must contain 1-48 lowercase letters, digits, underscores or hyphens",
    );
  }
  return normalized;
}

export function assertLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new Error("Account label must contain 1-100 characters");
  }
  return normalized;
}
