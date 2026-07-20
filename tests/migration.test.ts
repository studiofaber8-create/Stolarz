import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitoringStore } from "../src/infra/monitoring-store.js";

describe("schema migrations", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "stolarz-mig-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates fresh database at latest version", () => {
    const store = new MonitoringStore(dataDir);
    expect(store.schemaVersion()).toBe(2);
    store.close();
  });

  it("reopening database is idempotent", () => {
    const store1 = new MonitoringStore(dataDir);
    store1.close();
    const store2 = new MonitoringStore(dataDir);
    expect(store2.schemaVersion()).toBe(2);
    store2.close();
  });

  it("detects legacy schema without schema_migrations table", () => {
    const dbPath = path.join(dataDir, "agent.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, camofox_user_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE monitored_groups (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL,
        scan_interval_seconds INTEGER NOT NULL, max_posts_per_scan INTEGER NOT NULL,
        prompt_context TEXT NOT NULL DEFAULT '', last_scanned_at TEXT,
        next_scan_at TEXT NOT NULL, last_status TEXT NOT NULL DEFAULT 'never',
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, group_id TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5, available_at TEXT NOT NULL,
        lease_owner TEXT, lease_until TEXT, idempotency_key TEXT NOT NULL UNIQUE,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE scan_runs (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, job_id TEXT NOT NULL,
        status TEXT NOT NULL, posts_seen INTEGER NOT NULL DEFAULT 0,
        posts_new INTEGER NOT NULL DEFAULT 0, decisions_created INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL, completed_at TEXT, error TEXT
      );
      CREATE TABLE posts (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, external_id TEXT NOT NULL,
        url TEXT NOT NULL, author TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL,
        published_at TEXT, discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(group_id, external_id)
      );
      CREATE TABLE lead_decisions (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL UNIQUE, relevant INTEGER NOT NULL,
        category TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE response_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
        body TEXT NOT NULL, llm_instruction TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE response_drafts (
        id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, template_id TEXT,
        rendered_template TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)").run(
      "disabled-acc", "Disabled", "profile-d", "facebook-main", 0, now, now,
    );
    db.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)").run(
      "active-acc", "Active", "profile-a", "facebook-main", 1, now, now,
    );
    db.close();

    const store = new MonitoringStore(dataDir);
    expect(store.schemaVersion()).toBe(2);
    store.close();
  });

  it("backfills recovery_required for disabled legacy accounts", async () => {
    const dbPath = path.join(dataDir, "agent.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, camofox_user_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE monitored_groups (id TEXT PRIMARY KEY, account_id TEXT, name TEXT, url TEXT UNIQUE, enabled INTEGER, scan_interval_seconds INTEGER, max_posts_per_scan INTEGER, prompt_context TEXT DEFAULT '', last_scanned_at TEXT, next_scan_at TEXT, last_status TEXT DEFAULT 'never', last_error TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT, group_id TEXT, status TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5, available_at TEXT, lease_owner TEXT, lease_until TEXT, idempotency_key TEXT UNIQUE, last_error TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE scan_runs (id TEXT PRIMARY KEY, group_id TEXT, job_id TEXT, status TEXT, posts_seen INTEGER DEFAULT 0, posts_new INTEGER DEFAULT 0, decisions_created INTEGER DEFAULT 0, started_at TEXT, completed_at TEXT, error TEXT);
      CREATE TABLE posts (id TEXT PRIMARY KEY, group_id TEXT, external_id TEXT, url TEXT, author TEXT, content TEXT, content_hash TEXT, published_at TEXT, discovered_at TEXT, updated_at TEXT, UNIQUE(group_id, external_id));
      CREATE TABLE lead_decisions (id TEXT PRIMARY KEY, post_id TEXT UNIQUE, relevant INTEGER, category TEXT, confidence REAL, reason TEXT, status TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, created_at TEXT);
      CREATE TABLE response_templates (id TEXT PRIMARY KEY, name TEXT UNIQUE, category TEXT, body TEXT, llm_instruction TEXT DEFAULT '', enabled INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE response_drafts (id TEXT PRIMARY KEY, decision_id TEXT UNIQUE, template_id TEXT, rendered_template TEXT, text TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, type TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT);
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)").run(
      "off", "Off", "off-profile", "facebook-main", 0, now, now,
    );
    db.prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)").run(
      "on", "On", "on-profile", "facebook-main", 1, now, now,
    );
    db.close();

    const store = new MonitoringStore(dataDir);
    const off = await store.get("off");
    expect(off.recoveryRequired).toBe(true);
    expect(off.disabledReason).toContain("requires verification");

    const on = await store.get("on");
    expect(on.recoveryRequired).toBe(false);
    expect(on.disabledReason).toBeUndefined();
    store.close();
  });
});
