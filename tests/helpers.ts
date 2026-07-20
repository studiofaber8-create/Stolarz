import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MonitoringStore } from "../src/infra/monitoring-store.js";

export interface TestContext {
  store: MonitoringStore;
  dataDir: string;
}

export function createTestStore(): TestContext {
  const dataDir = mkdtempSync(path.join(tmpdir(), "stolarz-test-"));
  const store = new MonitoringStore(dataDir);
  return { store, dataDir };
}

export function cleanupTestStore(ctx: TestContext): void {
  ctx.store.close();
  rmSync(ctx.dataDir, { recursive: true, force: true });
}
