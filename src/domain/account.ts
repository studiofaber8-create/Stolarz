export const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;

export interface FacebookAccount {
  readonly id: string;
  readonly label: string;
  readonly camofoxUserId: string;
  readonly sessionKey: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  remove(accountId: string): Promise<FacebookAccount>;
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
