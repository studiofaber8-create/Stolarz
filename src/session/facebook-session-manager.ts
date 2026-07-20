import { CamofoxClient, CamofoxRequestError } from "../camofox/client.js";
import type { CamofoxHealth, CamofoxTab, DisplayResult } from "../camofox/types.js";
import type { AppConfig } from "../config.js";
import {
  assertAccountId,
  type AccountRepository,
  type FacebookAccount,
  type FacebookAccountAuthState,
} from "../domain/account.js";
import { KeyedMutex } from "./keyed-mutex.js";

export interface AccountSessionStatus {
  readonly account: FacebookAccount;
  readonly running: boolean;
  readonly tabs: CamofoxTab[];
  readonly error?: string;
}

export interface LoginSessionResult {
  readonly account: FacebookAccount;
  readonly display: DisplayResult;
  readonly tab: CamofoxTab;
}

export interface AccountTabContext {
  readonly account: FacebookAccount;
  readonly tab: CamofoxTab;
}

export class FacebookSessionManager {
  private readonly mutex = new KeyedMutex();

  public constructor(
    private readonly config: AppConfig,
    private readonly registry: AccountRepository,
    private readonly camofox: CamofoxClient,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(config.profilePrefix)) {
      throw new Error("AGENT_PROFILE_PREFIX may only contain letters, digits, underscores and hyphens");
    }
  }

  public health(): Promise<CamofoxHealth> {
    return this.camofox.health();
  }

  public listAccounts(): Promise<FacebookAccount[]> {
    return this.registry.list();
  }

  public getAccount(accountId: string): Promise<FacebookAccount> {
    return this.registry.get(accountId);
  }

  public registerAccount(id: string, label: string): Promise<FacebookAccount> {
    const normalizedId = assertAccountId(id);
    return this.registry.add({
      id: normalizedId,
      label,
      camofoxUserId: `${this.config.profilePrefix}-${normalizedId}`,
      sessionKey: "facebook-main",
    });
  }

  public async removeAccount(accountId: string): Promise<FacebookAccount> {
    const account = await this.registry.get(accountId);
    return this.mutex.runExclusive(account.id, async () => {
      const removal = await this.registry.beginRemoval(
        account.id,
        Math.min(3_600_000, Math.max(60_000, this.config.requestTimeoutMs * 4)),
      );
      try {
        await this.closeSessionIfPresent(removal.account.camofoxUserId);
        return await this.registry.remove(removal.account.id, removal.token);
      } catch (error) {
        await this.registry.cancelRemoval(removal.account.id, removal.token);
        throw error;
      }
    });
  }

  public recordAccountInspection(
    accountId: string,
    state: FacebookAccountAuthState,
    reason: string,
  ): Promise<FacebookAccount> {
    return this.registry.recordInspection(accountId, state, reason);
  }

  public async openSession(accountId: string, url = this.config.facebookHomeUrl): Promise<CamofoxTab> {
    return this.runWithAccountTab(accountId, url, async ({ tab }) => tab);
  }

  public async runWithAccountTab<T>(
    accountId: string,
    url: string,
    operation: (context: AccountTabContext) => Promise<T>,
  ): Promise<T> {
    const account = await this.enabledAccount(accountId);
    return this.runWithResolvedAccountTab(account, url, operation);
  }

  public async runWithRegisteredAccountTab<T>(
    accountId: string,
    url: string,
    operation: (context: AccountTabContext) => Promise<T>,
  ): Promise<T> {
    const account = await this.registry.get(accountId);
    return this.runWithResolvedAccountTab(account, url, operation);
  }

  private async runWithResolvedAccountTab<T>(
    account: FacebookAccount,
    url: string,
    operation: (context: AccountTabContext) => Promise<T>,
  ): Promise<T> {
    const safeUrl = facebookUrl(url);
    return this.mutex.runExclusive(account.id, async () => {
      await this.assertHealthy();
      const tab = await this.openOrReuseTab(account, safeUrl);
      return operation({ account, tab });
    });
  }

  public async startManualLogin(accountId: string): Promise<LoginSessionResult> {
    const account = await this.registry.get(accountId);
    return this.mutex.runExclusive(account.id, async () => {
      await this.assertHealthy();
      const existing = await this.camofox.listTabs(account.camofoxUserId);
      if (existing.length === 0) {
        // Camofox can only start noVNC for an existing browser context. This
        // bootstrap tab is invalidated by toggleDisplay and recreated below.
        await this.camofox.createTab({
          userId: account.camofoxUserId,
          sessionKey: account.sessionKey,
          url: this.config.facebookHomeUrl,
        });
      }
      const display = await this.camofox.toggleDisplay(account.camofoxUserId, "virtual");
      const tab = await this.camofox.createTab({
        userId: account.camofoxUserId,
        sessionKey: account.sessionKey,
        url: this.config.facebookHomeUrl,
      });
      return { account, display, tab };
    });
  }

  public async finishManualLogin(accountId: string): Promise<LoginSessionResult> {
    const account = await this.registry.get(accountId);
    return this.mutex.runExclusive(account.id, async () => {
      await this.assertHealthy();
      const display = await this.camofox.toggleDisplay(account.camofoxUserId, true);
      const tab = await this.camofox.createTab({
        userId: account.camofoxUserId,
        sessionKey: account.sessionKey,
        url: this.config.facebookHomeUrl,
      });
      return { account, display, tab };
    });
  }

  public async stopSession(accountId: string): Promise<void> {
    const account = await this.registry.get(accountId);
    await this.mutex.runExclusive(account.id, async () => {
      await this.closeSessionIfPresent(account.camofoxUserId);
    });
  }

  public async status(accountId: string): Promise<AccountSessionStatus> {
    const account = await this.registry.get(accountId);
    const tabs = await this.camofox.listTabs(account.camofoxUserId);
    return { account, running: tabs.length > 0, tabs };
  }

  public async statusAll(): Promise<AccountSessionStatus[]> {
    const accounts = await this.registry.list();
    return Promise.all(
      accounts.map(async (account) => {
        try {
          const tabs = await this.camofox.listTabs(account.camofoxUserId);
          return { account, running: tabs.length > 0, tabs };
        } catch (error) {
          return {
            account,
            running: false,
            tabs: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  private async openOrReuseTab(account: FacebookAccount, url: string): Promise<CamofoxTab> {
    const existing = await this.camofox.listTabs(account.camofoxUserId);
    const selected = existing.find((tab) => tab.url === url) ?? existing[0];
    if (selected) {
      await Promise.all(
        existing
          .filter((tab) => tab.id !== selected.id)
          .map((tab) => this.camofox.closeTab(account.camofoxUserId, tab.id)),
      );
      if (selected.url === url) return selected;
      const navigation = await this.camofox.navigate(account.camofoxUserId, selected.id, url);
      return { ...selected, url: navigation.url ?? url };
    }
    return this.camofox.createTab({
      userId: account.camofoxUserId,
      sessionKey: account.sessionKey,
      url,
    });
  }

  private async enabledAccount(accountId: string): Promise<FacebookAccount> {
    const account = await this.registry.get(accountId);
    if (!account.enabled) throw new Error(`Account is disabled: ${account.id}`);
    return account;
  }

  private async assertHealthy(): Promise<void> {
    const health = await this.camofox.health();
    if (!health.ok) throw new Error("Camofox health check returned ok=false");
  }

  private async closeSessionIfPresent(userId: string): Promise<void> {
    try {
      await this.camofox.closeSession(userId);
    } catch (error) {
      if (error instanceof CamofoxRequestError && error.status === 404) return;
      throw error;
    }
  }
}

function facebookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Session URL must be a valid Facebook URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) {
    throw new Error("Session URL must use HTTPS and belong to facebook.com");
  }
  return url.toString();
}
