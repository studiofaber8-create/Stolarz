import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAccountId,
  assertLabel,
  type FacebookAccount,
} from "../domain/account.js";

interface RegistryDocument {
  readonly version: 1;
  readonly accounts: FacebookAccount[];
}

const EMPTY_REGISTRY: RegistryDocument = { version: 1, accounts: [] };
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export class AccountRegistry {
  private readonly filePath: string;
  private readonly lockPath: string;

  public constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "accounts.json");
    this.lockPath = path.join(dataDir, "accounts.lock");
  }

  public async list(): Promise<FacebookAccount[]> {
    const document = await this.read();
    return [...document.accounts].sort((a, b) => a.label.localeCompare(b.label, "pl"));
  }

  public async get(accountId: string): Promise<FacebookAccount> {
    const normalizedId = assertAccountId(accountId);
    const account = (await this.read()).accounts.find(({ id }) => id === normalizedId);
    if (!account) throw new Error(`Unknown account: ${normalizedId}`);
    return account;
  }

  public async add(input: {
    id: string;
    label: string;
    camofoxUserId: string;
    sessionKey: string;
  }): Promise<FacebookAccount> {
    return this.withWriteLock(async () => {
      const document = await this.read();
      const id = assertAccountId(input.id);
      if (document.accounts.some((account) => account.id === id)) {
        throw new Error(`Account already exists: ${id}`);
      }
      if (document.accounts.some((account) => account.camofoxUserId === input.camofoxUserId)) {
        throw new Error(`Camofox profile already exists: ${input.camofoxUserId}`);
      }

      const now = new Date().toISOString();
      const account: FacebookAccount = {
        id,
        label: assertLabel(input.label),
        camofoxUserId: input.camofoxUserId,
        sessionKey: input.sessionKey,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      await this.write({ version: 1, accounts: [...document.accounts, account] });
      return account;
    });
  }

  public async remove(accountId: string): Promise<FacebookAccount> {
    return this.withWriteLock(async () => {
      const document = await this.read();
      const id = assertAccountId(accountId);
      const account = document.accounts.find((candidate) => candidate.id === id);
      if (!account) throw new Error(`Unknown account: ${id}`);
      await this.write({
        version: 1,
        accounts: document.accounts.filter((candidate) => candidate.id !== id),
      });
      return account;
    });
  }

  private async read(): Promise<RegistryDocument> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRegistryDocument(parsed)) {
        throw new Error(`Invalid account registry format: ${this.filePath}`);
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return EMPTY_REGISTRY;
      throw error;
    }
  }

  private async write(document: RegistryDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for account registry lock");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (Date.now() - details.mtimeMs > STALE_LOCK_MS) await unlink(this.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRegistryDocument(value: unknown): value is RegistryDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) return false;
  if (!candidate.accounts.every(isFacebookAccount)) return false;
  const accounts = candidate.accounts;
  return (
    new Set(accounts.map((account) => account.id)).size === accounts.length &&
    new Set(accounts.map((account) => account.camofoxUserId)).size === accounts.length
  );
}

function isFacebookAccount(value: unknown): value is FacebookAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.id === "string" &&
    assertIdWithoutNormalization(account.id) &&
    typeof account.label === "string" &&
    account.label.trim().length >= 1 &&
    account.label.length <= 100 &&
    typeof account.camofoxUserId === "string" &&
    /^[a-zA-Z0-9_-]{1,97}$/.test(account.camofoxUserId) &&
    typeof account.sessionKey === "string" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(account.sessionKey) &&
    typeof account.enabled === "boolean" &&
    isIsoDate(account.createdAt) &&
    isIsoDate(account.updatedAt)
  );
}

function assertIdWithoutNormalization(value: string): boolean {
  try {
    return assertAccountId(value) === value;
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
