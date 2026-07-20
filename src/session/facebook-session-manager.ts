import { CamofoxClient } from "../camofox/client.js";
import type { CamofoxHealth, CamofoxTab, DisplayResult } from "../camofox/types.js";
import type { AppConfig } from "../config.js";
import { assertAccountId, type FacebookAccount } from "../domain/account.js";
import { AccountRegistry } from "../infra/account-registry.js";
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

export class FacebookSessionManager {
  private readonly mutex = new KeyedMutex();

  public constructor(
    private readonly config: AppConfig,
    private readonly registry: AccountRegistry,
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
      await this.closeSessionIfPresent(account.camofoxUserId);
      return this.registry.remove(account.id);
    });
  }

  public async openSession(accountId: string, url = this.config.facebookHomeUrl): Promise<CamofoxTab> {
    const account = await this.enabledAccount(accountId);
    const safeUrl = facebookUrl(url);
    return this.mutex.runExclusive(account.id, async () => {
      await this.assertHealthy();
      const existing = await this.camofox.listTabs(account.camofoxUserId);
      const matchingTab = existing.find((tab) => tab.url === safeUrl);
      if (matchingTab) return matchingTab;
      return this.camofox.createTab({
        userId: account.camofoxUserId,
        sessionKey: account.sessionKey,
        url: safeUrl,
      });
    });
  }

  public async startManualLogin(accountId: string): Promise<LoginSessionResult> {
    const account = await this.enabledAccount(accountId);
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
    const account = await this.enabledAccount(accountId);
    return this.mutex.runExclusive(account.id, async () => {
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
    const tabs = await this.camofox.listTabs(userId);
    if (tabs.length > 0) await this.camofox.closeSession(userId);
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
