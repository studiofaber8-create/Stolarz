import { createHash, randomUUID } from "node:crypto";
import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { renderSpintax } from "../agent/spintax.js";
import {
  assertAccountId,
  assertLabel,
  type AccountRepository,
  type FacebookAccount,
} from "../domain/account.js";
import type {
  AgentJob,
  AuditEvent,
  CreateGroupInput,
  CreateResponseTemplateInput,
  DiscoveredPostInput,
  LeadDecision,
  LeadDecisionInput,
  MonitoredGroup,
  MonitoringSummary,
  ResponseDraft,
  ResponseDraftInput,
  ResponseTemplate,
  ScanRun,
  ScanRunStatus,
  StoredPost,
  UpdateResponseTemplateInput,
} from "../domain/monitoring.js";

export class MonitoringStore implements AccountRepository {
  private readonly database: DatabaseSync;

  public constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = path.join(dataDir, "agent.sqlite");
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.migrateLegacyAccounts(dataDir);
    secureDatabaseFiles(databasePath);
  }

  public close(): void {
    this.database.close();
  }

  public async list(): Promise<FacebookAccount[]> {
    return this.database.prepare(
      "SELECT * FROM accounts ORDER BY label COLLATE NOCASE ASC",
    ).all().map(accountFromRow);
  }

  public async get(accountId: string): Promise<FacebookAccount> {
    const id = assertAccountId(accountId);
    const row = this.database.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
    if (row === undefined) throw new Error(`Unknown account: ${id}`);
    return accountFromRow(row);
  }

  public async add(input: {
    id: string;
    label: string;
    camofoxUserId: string;
    sessionKey: string;
  }): Promise<FacebookAccount> {
    const id = assertAccountId(input.id);
    const label = assertLabel(input.label);
    const camofoxUserId = accountToken("camofoxUserId", input.camofoxUserId, 97);
    const sessionKey = accountToken("sessionKey", input.sessionKey, 64);
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO accounts (
          id, label, camofox_user_id, session_key, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(id, label, camofoxUserId, sessionKey, now, now);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const existing = this.database.prepare("SELECT id FROM accounts WHERE id = ?").get(id);
        if (existing !== undefined) throw new Error(`Account already exists: ${id}`);
        throw new Error(`Camofox profile already exists: ${camofoxUserId}`);
      }
      throw error;
    }
    this.recordAudit("account.created", "account", id, camofoxUserId);
    return this.get(id);
  }

  public async remove(accountId: string): Promise<FacebookAccount> {
    const account = await this.get(accountId);
    const group = this.database.prepare(
      "SELECT id FROM monitored_groups WHERE account_id = ? LIMIT 1",
    ).get(account.id);
    if (group !== undefined) {
      throw new Error(`Account has monitored groups: ${account.id}`);
    }
    this.database.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
    this.recordAudit("account.deleted", "account", account.id, account.camofoxUserId);
    return account;
  }

  public async setAccountEnabled(accountId: string, enabled: boolean): Promise<FacebookAccount> {
    const id = assertAccountId(accountId);
    const now = new Date().toISOString();
    this.transaction(() => {
      const result = this.database.prepare(
        "UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?",
      ).run(enabled ? 1 : 0, now, id);
      if (result.changes === 0) throw new Error(`Unknown account: ${id}`);
      if (!enabled) {
        this.database.prepare(`
          UPDATE scan_runs
          SET status = 'failed', completed_at = ?, error = 'Account disabled by operator'
          WHERE status = 'running' AND job_id IN (
            SELECT jobs.id FROM jobs
            INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
            WHERE monitored_groups.account_id = ?
          )
        `).run(now, id);
        this.database.prepare(`
          UPDATE jobs
          SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
              last_error = 'Account disabled by operator', updated_at = ?
          WHERE status IN ('queued', 'running') AND group_id IN (
            SELECT id FROM monitored_groups WHERE account_id = ?
          )
        `).run(now, id);
      }
    });
    this.recordAudit(enabled ? "account.enabled" : "account.disabled", "account", id);
    return this.get(id);
  }

  public createGroup(input: CreateGroupInput): MonitoredGroup {
    const accountId = normalizedIdentifier("accountId", input.accountId);
    if (this.database.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId) === undefined) {
      throw new Error(`Unknown account: ${accountId}`);
    }
    const name = boundedText("name", input.name, 1, 120);
    const url = facebookGroupUrl(input.url);
    const scanIntervalSeconds = boundedInteger(
      "scanIntervalSeconds",
      input.scanIntervalSeconds,
      60,
      86_400,
    );
    const maxPostsPerScan = boundedInteger("maxPostsPerScan", input.maxPostsPerScan, 1, 100);
    const promptContext = boundedText("promptContext", input.promptContext ?? "", 0, 2_000);
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.database.prepare(`
        INSERT INTO monitored_groups (
          id, account_id, name, url, enabled, scan_interval_seconds,
          max_posts_per_scan, prompt_context, next_scan_at, last_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'never', ?, ?)
      `).run(
        id,
        accountId,
        name,
        url,
        scanIntervalSeconds,
        maxPostsPerScan,
        promptContext,
        now,
        now,
        now,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) throw new Error(`Group URL already exists: ${url}`);
      throw error;
    }
    this.recordAudit("group.created", "group", id, `${accountId}:${url}`);
    return this.getGroup(id);
  }

  public listGroups(): MonitoredGroup[] {
    const rows = this.database.prepare(
      "SELECT * FROM monitored_groups ORDER BY enabled DESC, name COLLATE NOCASE ASC",
    ).all();
    return rows.map(groupFromRow);
  }

  public getGroup(groupId: string): MonitoredGroup {
    const row = this.database.prepare("SELECT * FROM monitored_groups WHERE id = ?").get(groupId);
    if (row === undefined) throw new Error(`Unknown group: ${groupId}`);
    return groupFromRow(row);
  }

  public setGroupEnabled(groupId: string, enabled: boolean): MonitoredGroup {
    const now = new Date().toISOString();
    this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE monitored_groups
        SET enabled = ?, next_scan_at = CASE WHEN ? = 1 THEN ? ELSE next_scan_at END,
            updated_at = ?
        WHERE id = ?
      `).run(enabled ? 1 : 0, enabled ? 1 : 0, now, now, groupId);
      if (result.changes === 0) throw new Error(`Unknown group: ${groupId}`);
      if (!enabled) {
        this.database.prepare(`
          UPDATE scan_runs
          SET status = 'failed', completed_at = ?, error = 'Group disabled by operator'
          WHERE status = 'running' AND job_id IN (
            SELECT id FROM jobs WHERE group_id = ?
          )
        `).run(now, groupId);
        this.database.prepare(`
          UPDATE jobs
          SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
              last_error = 'Group disabled by operator', updated_at = ?
          WHERE group_id = ? AND status IN ('queued', 'running')
        `).run(now, groupId);
      }
    });
    this.recordAudit(enabled ? "group.enabled" : "group.disabled", "group", groupId);
    return this.getGroup(groupId);
  }

  public deleteGroup(groupId: string): void {
    this.transaction(() => {
      const group = this.database.prepare("SELECT id FROM monitored_groups WHERE id = ?").get(groupId);
      if (group === undefined) throw new Error(`Unknown group: ${groupId}`);
      this.database.prepare("DELETE FROM monitored_groups WHERE id = ?").run(groupId);
    });
    this.recordAudit("group.deleted", "group", groupId);
  }

  public enqueueDueScans(now = new Date()): number {
    const nowIso = now.toISOString();
    return this.transaction(() => {
      const groups = this.database.prepare(`
        SELECT monitored_groups.* FROM monitored_groups
        INNER JOIN accounts ON accounts.id = monitored_groups.account_id
        WHERE monitored_groups.enabled = 1 AND accounts.enabled = 1
          AND monitored_groups.next_scan_at <= ?
        ORDER BY monitored_groups.next_scan_at ASC
      `).all(nowIso).map(groupFromRow);
      let created = 0;
      for (const group of groups) {
        const key = `scheduled:${group.id}:${group.nextScanAt}`;
        if (this.insertJob(group.id, key, nowIso)) created += 1;
        const nextScanAt = new Date(now.getTime() + group.scanIntervalSeconds * 1_000).toISOString();
        this.database.prepare(`
          UPDATE monitored_groups SET next_scan_at = ?, updated_at = ? WHERE id = ?
        `).run(nextScanAt, nowIso, group.id);
      }
      return created;
    });
  }

  public enqueueScanNow(groupId: string): AgentJob {
    const group = this.getGroup(groupId);
    if (!group.enabled) throw new Error(`Group is disabled: ${groupId}`);
    const account = this.database.prepare(
      "SELECT enabled FROM accounts WHERE id = ?",
    ).get(group.accountId);
    if (account === undefined || numeric(account.enabled) !== 1) {
      throw new Error(`Account is disabled: ${group.accountId}`);
    }
    const now = new Date().toISOString();
    const idempotencyKey = `manual:${groupId}:${randomUUID()}`;
    this.insertJob(groupId, idempotencyKey, now);
    const row = this.database.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);
    if (row === undefined) throw new Error("Failed to create scan job");
    const job = jobFromRow(row);
    this.recordAudit("scan.enqueued", "job", job.id, groupId);
    return job;
  }

  public claimNextJob(workerId: string, leaseMs: number): AgentJob | undefined {
    boundedText("workerId", workerId, 1, 120);
    boundedInteger("leaseMs", leaseMs, 1_000, 3_600_000);
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE scan_runs
        SET status = 'failed', completed_at = ?, error = 'Worker lease expired'
        WHERE status = 'running' AND job_id IN (
          SELECT id FROM jobs
          WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
        )
      `).run(nowIso, nowIso);
      this.database.prepare(`
        UPDATE jobs
        SET status = 'queued', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
            available_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'Worker lease expired')
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
      `).run(nowIso, nowIso, nowIso);

      this.database.prepare(`
        UPDATE jobs
        SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
            last_error = 'Account or group is disabled', updated_at = ?
        WHERE status = 'queued' AND EXISTS (
          SELECT 1 FROM monitored_groups
          INNER JOIN accounts ON accounts.id = monitored_groups.account_id
          WHERE monitored_groups.id = jobs.group_id
            AND (monitored_groups.enabled = 0 OR accounts.enabled = 0)
        )
      `).run(nowIso);

      const row = this.database.prepare(`
        SELECT jobs.* FROM jobs
        INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
        INNER JOIN accounts ON accounts.id = monitored_groups.account_id
        WHERE jobs.status = 'queued' AND jobs.available_at <= ?
          AND monitored_groups.enabled = 1 AND accounts.enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM jobs AS running_job
            WHERE running_job.group_id = jobs.group_id AND running_job.status = 'running'
          )
        ORDER BY jobs.available_at ASC, jobs.created_at ASC
        LIMIT 1
      `).get(nowIso);
      if (row === undefined) return undefined;
      const job = jobFromRow(row);
      const leaseToken = randomUUID();
      const result = this.database.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, lease_owner = ?,
            lease_until = ?, lease_token = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(workerId, leaseUntil, leaseToken, nowIso, job.id);
      if (result.changes === 0) return undefined;
      const claimed = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
      return claimed === undefined ? undefined : jobFromRow(claimed);
    });
  }

  public extendJobLease(jobId: string, leaseToken: string, leaseMs: number): void {
    boundedInteger("leaseMs", leaseMs, 1_000, 3_600_000);
    const now = new Date();
    const result = this.database.prepare(`
      UPDATE jobs SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?
        AND lease_until IS NOT NULL AND lease_until >= ?
        AND EXISTS (
          SELECT 1 FROM monitored_groups
          INNER JOIN accounts ON accounts.id = monitored_groups.account_id
          WHERE monitored_groups.id = jobs.group_id
            AND monitored_groups.enabled = 1 AND accounts.enabled = 1
        )
    `).run(
      new Date(now.getTime() + leaseMs).toISOString(),
      now.toISOString(),
      jobId,
      leaseToken,
      now.toISOString(),
    );
    if (result.changes === 0) throw new Error(`Job lease lost: ${jobId}`);
  }

  public assertJobLease(jobId: string, leaseToken: string): void {
    const row = this.database.prepare(`
      SELECT jobs.id FROM jobs
      INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
      INNER JOIN accounts ON accounts.id = monitored_groups.account_id
      WHERE jobs.id = ? AND jobs.status = 'running' AND jobs.lease_token = ?
        AND jobs.lease_until >= ? AND monitored_groups.enabled = 1 AND accounts.enabled = 1
    `).get(jobId, leaseToken, new Date().toISOString());
    if (row === undefined) throw new Error(`Job lease lost: ${jobId}`);
  }

  public finishSuccessfulScan(
    scanId: string,
    jobId: string,
    leaseToken: string,
    counts: { postsSeen: number; postsNew: number; decisionsCreated: number },
  ): ScanRun {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const owned = this.database.prepare(`
        SELECT scan_runs.group_id FROM scan_runs
        INNER JOIN jobs ON jobs.id = scan_runs.job_id
        INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
        INNER JOIN accounts ON accounts.id = monitored_groups.account_id
        WHERE scan_runs.id = ? AND scan_runs.job_id = ? AND scan_runs.status = 'running'
          AND jobs.status = 'running' AND jobs.lease_token = ? AND jobs.lease_until >= ?
          AND monitored_groups.enabled = 1 AND accounts.enabled = 1
      `).get(scanId, jobId, leaseToken, now);
      if (owned === undefined) throw new Error(`Job lease lost: ${jobId}`);
      this.database.prepare(`
        UPDATE scan_runs
        SET status = 'succeeded', posts_seen = ?, posts_new = ?, decisions_created = ?,
            completed_at = ?, error = NULL
        WHERE id = ? AND status = 'running'
      `).run(counts.postsSeen, counts.postsNew, counts.decisionsCreated, now, scanId);
      this.database.prepare(`
        UPDATE monitored_groups
        SET last_status = 'succeeded', last_error = NULL, last_scanned_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, requiredString(owned.group_id));
      const completed = this.database.prepare(`
        UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL,
          lease_token = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?
      `).run(now, jobId, leaseToken, now);
      if (completed.changes === 0) throw new Error(`Job lease lost: ${jobId}`);
      return this.getScanRun(scanId);
    });
  }

  public finishFailedScanAndJob(
    scanId: string | undefined,
    jobId: string,
    leaseToken: string,
    counts: { postsSeen: number; postsNew: number; decisionsCreated: number },
    error: string,
    retryAt: string,
    suspension: "account" | "group" | undefined,
  ): void {
    const now = new Date().toISOString();
    const terminal = suspension !== undefined;
    this.transaction(() => {
      const owned = this.database.prepare(`
        SELECT jobs.attempts, jobs.max_attempts, monitored_groups.id AS group_id,
          monitored_groups.account_id
        FROM jobs
        INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
        WHERE jobs.id = ? AND jobs.status = 'running' AND jobs.lease_token = ?
          AND jobs.lease_until >= ?
      `).get(jobId, leaseToken, now);
      if (owned === undefined) throw new Error(`Job lease lost: ${jobId}`);
      if (scanId !== undefined) {
        const scan = this.database.prepare(`
          UPDATE scan_runs
          SET status = ?, posts_seen = ?, posts_new = ?, decisions_created = ?,
              completed_at = ?, error = ?
          WHERE id = ? AND job_id = ? AND status = 'running'
        `).run(
          terminal ? "auth_required" : "failed",
          counts.postsSeen,
          counts.postsNew,
          counts.decisionsCreated,
          now,
          error.slice(0, 2_000),
          scanId,
          jobId,
        );
        if (scan.changes === 0) throw new Error(`Running scan not found: ${scanId}`);
      }
      const groupId = requiredString(owned.group_id);
      this.database.prepare(`
        UPDATE monitored_groups
        SET enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
            last_status = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        terminal ? 1 : 0,
        terminal ? "auth_required" : "failed",
        error.slice(0, 2_000),
        now,
        groupId,
      );
      if (suspension === "account") {
        const accountId = requiredString(owned.account_id);
        this.database.prepare(`
          UPDATE scan_runs
          SET status = 'auth_required', completed_at = ?, error = ?
          WHERE status = 'running' AND job_id IN (
            SELECT jobs.id FROM jobs
            INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
            WHERE monitored_groups.account_id = ? AND jobs.id <> ?
          )
        `).run(now, error.slice(0, 2_000), accountId, jobId);
        this.database.prepare(`
          UPDATE jobs
          SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
              last_error = ?, updated_at = ?
          WHERE id <> ? AND status IN ('queued', 'running') AND group_id IN (
            SELECT id FROM monitored_groups WHERE account_id = ?
          )
        `).run(error.slice(0, 2_000), now, jobId, accountId);
        this.database.prepare(
          "UPDATE accounts SET enabled = 0, updated_at = ? WHERE id = ?",
        ).run(now, accountId);
      } else if (suspension === "group") {
        this.database.prepare(`
          UPDATE scan_runs
          SET status = 'auth_required', completed_at = ?, error = ?
          WHERE status = 'running' AND job_id IN (
            SELECT id FROM jobs WHERE group_id = ? AND id <> ?
          )
        `).run(now, error.slice(0, 2_000), groupId, jobId);
        this.database.prepare(`
          UPDATE jobs
          SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
              last_error = ?, updated_at = ?
          WHERE id <> ? AND status IN ('queued', 'running') AND group_id = ?
        `).run(error.slice(0, 2_000), now, jobId, groupId);
      }
      const dead = terminal || numeric(owned.attempts) >= numeric(owned.max_attempts);
      const job = this.database.prepare(`
        UPDATE jobs
        SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
            lease_token = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?
      `).run(
        dead ? "dead" : "queued",
        retryAt,
        error.slice(0, 2_000),
        now,
        jobId,
        leaseToken,
        now,
      );
      if (job.changes === 0) throw new Error(`Job lease lost: ${jobId}`);
    });
  }

  public failJob(jobId: string, leaseToken: string, error: string, retryAt: string): AgentJob {
    const now = new Date().toISOString();
    const currentRow = this.database.prepare(
      `SELECT * FROM jobs
       WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?`,
    ).get(jobId, leaseToken, now);
    if (currentRow === undefined) throw new Error(`Job lease lost: ${jobId}`);
    const current = jobFromRow(currentRow);
    const dead = current.attempts >= current.maxAttempts;
    const result = this.database.prepare(`
      UPDATE jobs
      SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          lease_token = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?
    `).run(
      dead ? "dead" : "queued",
      retryAt,
      error.slice(0, 2_000),
      now,
      jobId,
      leaseToken,
      now,
    );
    if (result.changes === 0) throw new Error(`Job lease lost: ${jobId}`);
    const updated = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (updated === undefined) throw new Error(`Unknown job: ${jobId}`);
    return jobFromRow(updated);
  }

  public deadLetterJob(jobId: string, leaseToken: string, error: string): AgentJob {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE jobs
      SET status = 'dead', lease_owner = NULL, lease_until = NULL, lease_token = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?
    `).run(error.slice(0, 2_000), now, jobId, leaseToken, now);
    if (result.changes === 0) throw new Error(`Job lease lost: ${jobId}`);
    const updated = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (updated === undefined) throw new Error(`Unknown job: ${jobId}`);
    return jobFromRow(updated);
  }

  public listJobs(limit = 100): AgentJob[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    return this.database.prepare(
      "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
    ).all(safeLimit).map(jobFromRow);
  }

  public startScanRunForJob(
    groupId: string,
    jobId: string,
    leaseToken: string,
  ): ScanRun {
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      const owned = this.database.prepare(`
        SELECT jobs.id FROM jobs
        INNER JOIN monitored_groups ON monitored_groups.id = jobs.group_id
        INNER JOIN accounts ON accounts.id = monitored_groups.account_id
        WHERE jobs.id = ? AND jobs.group_id = ? AND jobs.status = 'running'
          AND jobs.lease_token = ? AND jobs.lease_until >= ?
          AND monitored_groups.enabled = 1 AND accounts.enabled = 1
      `).get(jobId, groupId, leaseToken, now);
      if (owned === undefined) throw new Error(`Job lease lost: ${jobId}`);
      this.database.prepare(`
        INSERT INTO scan_runs (
          id, group_id, job_id, status, posts_seen, posts_new,
          decisions_created, started_at
        ) VALUES (?, ?, ?, 'running', 0, 0, 0, ?)
      `).run(id, groupId, jobId, now);
      this.database.prepare(`
        UPDATE monitored_groups SET last_status = 'running', last_error = NULL, updated_at = ?
        WHERE id = ? AND enabled = 1
      `).run(now, groupId);
      return this.getScanRun(id);
    });
  }

  public finishScanRun(
    scanId: string,
    status: Exclude<ScanRunStatus, "running">,
    counts: { postsSeen: number; postsNew: number; decisionsCreated: number },
    error?: string,
  ): ScanRun {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE scan_runs
      SET status = ?, posts_seen = ?, posts_new = ?, decisions_created = ?,
          completed_at = ?, error = ?
      WHERE id = ? AND status = 'running'
    `).run(
      status,
      counts.postsSeen,
      counts.postsNew,
      counts.decisionsCreated,
      now,
      error?.slice(0, 2_000) ?? null,
      scanId,
    );
    if (result.changes === 0) throw new Error(`Running scan not found: ${scanId}`);
    const scan = this.getScanRun(scanId);
    this.database.prepare(`
      UPDATE monitored_groups
      SET last_status = ?, last_error = ?,
          last_scanned_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_scanned_at END,
          updated_at = ?
      WHERE id = ?
    `).run(status, error?.slice(0, 2_000) ?? null, status, now, now, scan.groupId);
    return scan;
  }

  public listScanRuns(limit = 100): ScanRun[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    return this.database.prepare(
      "SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?",
    ).all(safeLimit).map(scanFromRow);
  }

  public upsertPost(
    groupId: string,
    input: DiscoveredPostInput,
  ): { post: StoredPost; isNew: boolean; contentChanged: boolean } {
    return this.transaction(() => this.upsertPostInternal(groupId, input));
  }

  public upsertPostForJob(
    jobId: string,
    leaseToken: string,
    groupId: string,
    input: DiscoveredPostInput,
  ): { post: StoredPost; isNew: boolean; contentChanged: boolean } {
    return this.transaction(() => {
      this.assertJobLease(jobId, leaseToken);
      return this.upsertPostInternal(groupId, input);
    });
  }

  private upsertPostInternal(
    groupId: string,
    input: DiscoveredPostInput,
  ): { post: StoredPost; isNew: boolean; contentChanged: boolean } {
    const externalId = boundedText("externalId", input.externalId, 1, 500);
    const url = facebookPostUrl(input.url);
    const content = boundedText("content", input.content, 1, 20_000);
    const author = optionalBoundedText("author", input.author, 200);
    const publishedAt = optionalIsoDate("publishedAt", input.publishedAt);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const now = new Date().toISOString();
    const id = createHash("sha256").update(`${groupId}:${externalId}`).digest("hex");
    const existing = this.database.prepare(
      "SELECT id, content_hash FROM posts WHERE group_id = ? AND external_id = ?",
    ).get(groupId, externalId);
    this.database.prepare(`
      INSERT INTO posts (
        id, group_id, external_id, url, author, content, content_hash,
        published_at, discovered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, external_id) DO UPDATE SET
        url = excluded.url, author = excluded.author, content = excluded.content,
        content_hash = excluded.content_hash, published_at = COALESCE(excluded.published_at, posts.published_at),
        updated_at = excluded.updated_at
    `).run(
      id,
      groupId,
      externalId,
      url,
      author ?? null,
      content,
      contentHash,
      publishedAt ?? null,
      now,
      now,
    );
    const row = this.database.prepare("SELECT * FROM posts WHERE id = ?").get(id);
    if (row === undefined) throw new Error("Failed to persist post");
    const contentChanged =
      existing !== undefined && requiredString(existing.content_hash) !== contentHash;
    if (contentChanged) {
      this.database.prepare(`
        DELETE FROM response_drafts
        WHERE decision_id IN (SELECT id FROM lead_decisions WHERE post_id = ?)
      `).run(id);
    }
    return {
      post: postFromRow(row),
      isNew: existing === undefined,
      contentChanged,
    };
  }

  public listPosts(limit = 100, groupId?: string): StoredPost[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    const rows = groupId === undefined
      ? this.database.prepare("SELECT * FROM posts ORDER BY discovered_at DESC LIMIT ?").all(safeLimit)
      : this.database.prepare(
          "SELECT * FROM posts WHERE group_id = ? ORDER BY discovered_at DESC LIMIT ?",
        ).all(groupId, safeLimit);
    return rows.map(postFromRow);
  }

  public hasDecision(postId: string): boolean {
    return this.database.prepare(
      "SELECT 1 AS found FROM lead_decisions WHERE post_id = ?",
    ).get(postId) !== undefined;
  }

  public getDecisionByPost(postId: string): LeadDecision | undefined {
    const row = this.database.prepare(
      "SELECT * FROM lead_decisions WHERE post_id = ?",
    ).get(postId);
    return row === undefined ? undefined : decisionFromRow(row);
  }

  public saveDecision(input: LeadDecisionInput): LeadDecision {
    return this.transaction(() => this.saveDecisionInternal(input));
  }

  public saveDecisionForJob(
    jobId: string,
    leaseToken: string,
    input: LeadDecisionInput,
  ): LeadDecision {
    return this.transaction(() => {
      this.assertJobLease(jobId, leaseToken);
      return this.saveDecisionInternal(input);
    });
  }

  private saveDecisionInternal(input: LeadDecisionInput): LeadDecision {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO lead_decisions (
        id, post_id, relevant, category, confidence, reason, status, model,
        input_tokens, output_tokens, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        relevant = excluded.relevant, category = excluded.category,
        confidence = excluded.confidence, reason = excluded.reason,
        status = excluded.status, model = excluded.model,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        latency_ms = excluded.latency_ms, created_at = excluded.created_at
    `).run(
      id,
      input.postId,
      input.relevant ? 1 : 0,
      boundedText("category", input.category, 1, 80),
      boundedNumber("confidence", input.confidence, 0, 1),
      boundedText("reason", input.reason, 1, 2_000),
      input.status,
      boundedText("model", input.model, 1, 200),
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.latencyMs,
      now,
    );
    const row = this.database.prepare("SELECT * FROM lead_decisions WHERE post_id = ?").get(input.postId);
    if (row === undefined) throw new Error("Failed to persist decision");
    const decision = decisionFromRow(row);
    this.database.prepare("DELETE FROM response_drafts WHERE decision_id = ?").run(decision.id);
    return decision;
  }

  public listDecisions(limit = 100, status?: "ignored" | "review"): LeadDecision[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    const rows = status === undefined
      ? this.database.prepare(
          "SELECT * FROM lead_decisions ORDER BY created_at DESC LIMIT ?",
        ).all(safeLimit)
      : this.database.prepare(`
          SELECT * FROM lead_decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?
        `).all(status, safeLimit);
    return rows.map(decisionFromRow);
  }

  public createResponseTemplate(input: CreateResponseTemplateInput): ResponseTemplate {
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO response_templates (
          id, name, category, body, llm_instruction, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        boundedText("template name", input.name, 1, 120),
        responseCategory(input.category),
        validatedSpintaxBody(input.body),
        boundedText("LLM instruction", input.llmInstruction ?? "", 0, 2_000),
        now,
        now,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new Error(`Response template name already exists: ${input.name.trim()}`);
      }
      throw error;
    }
    this.recordAudit("response_template.created", "response_template", id);
    return this.getResponseTemplate(id);
  }

  public getResponseTemplate(templateId: string): ResponseTemplate {
    const row = this.database.prepare(
      "SELECT * FROM response_templates WHERE id = ?",
    ).get(templateId);
    if (row === undefined) throw new Error(`Unknown response template: ${templateId}`);
    return responseTemplateFromRow(row);
  }

  public listResponseTemplates(enabledOnly = false): ResponseTemplate[] {
    const rows = this.database.prepare(
      enabledOnly
        ? "SELECT * FROM response_templates WHERE enabled = 1 ORDER BY name COLLATE NOCASE ASC"
        : "SELECT * FROM response_templates ORDER BY enabled DESC, name COLLATE NOCASE ASC",
    ).all();
    return rows.map(responseTemplateFromRow);
  }

  public updateResponseTemplate(
    templateId: string,
    input: UpdateResponseTemplateInput,
  ): ResponseTemplate {
    return this.transaction(() => this.updateResponseTemplateInternal(templateId, input));
  }

  private updateResponseTemplateInternal(
    templateId: string,
    input: UpdateResponseTemplateInput,
  ): ResponseTemplate {
    const current = this.getResponseTemplate(templateId);
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        UPDATE response_templates
        SET name = ?, category = ?, body = ?, llm_instruction = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name === undefined
          ? current.name
          : boundedText("template name", input.name, 1, 120),
        input.category === undefined ? current.category : responseCategory(input.category),
        input.body === undefined
          ? current.body
          : validatedSpintaxBody(input.body),
        input.llmInstruction === undefined
          ? current.llmInstruction
          : boundedText("LLM instruction", input.llmInstruction, 0, 2_000),
        (input.enabled ?? current.enabled) ? 1 : 0,
        now,
        templateId,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new Error(`Response template name already exists: ${input.name?.trim() ?? current.name}`);
      }
      throw error;
    }
    if (
      input.body !== undefined ||
      input.category !== undefined ||
      input.llmInstruction !== undefined ||
      (input.enabled === false && current.enabled)
    ) {
      this.database.prepare("DELETE FROM response_drafts WHERE template_id = ?").run(templateId);
    }
    this.recordAudit("response_template.updated", "response_template", templateId);
    return this.getResponseTemplate(templateId);
  }

  public deleteResponseTemplate(templateId: string): void {
    this.transaction(() => {
      const existing = this.database.prepare(
        "SELECT id FROM response_templates WHERE id = ?",
      ).get(templateId);
      if (existing === undefined) throw new Error(`Unknown response template: ${templateId}`);
      this.database.prepare("DELETE FROM response_drafts WHERE template_id = ?").run(templateId);
      this.database.prepare("DELETE FROM response_templates WHERE id = ?").run(templateId);
      this.recordAudit("response_template.deleted", "response_template", templateId);
    });
  }

  public findResponseTemplate(category: string): ResponseTemplate | undefined {
    const normalized = responseCategory(category);
    const row = this.database.prepare(`
      SELECT * FROM response_templates
      WHERE enabled = 1 AND category IN (?, 'default')
      ORDER BY CASE WHEN category = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(normalized, normalized);
    return row === undefined ? undefined : responseTemplateFromRow(row);
  }

  public saveResponseDraft(input: ResponseDraftInput): ResponseDraft {
    return this.transaction(() => this.saveResponseDraftInternal(input));
  }

  public saveResponseDraftForJob(
    jobId: string,
    leaseToken: string,
    input: ResponseDraftInput,
  ): ResponseDraft {
    return this.transaction(() => {
      this.assertJobLease(jobId, leaseToken);
      return this.saveResponseDraftInternal(input);
    });
  }

  private saveResponseDraftInternal(input: ResponseDraftInput): ResponseDraft {
    const decision = this.database.prepare(
      "SELECT status FROM lead_decisions WHERE id = ?",
    ).get(input.decisionId);
    if (decision === undefined) throw new Error(`Unknown decision: ${input.decisionId}`);
    if (requiredString(decision.status) !== "review") {
      throw new Error("Response drafts can only be created for review decisions");
    }
    const template = this.getResponseTemplate(input.templateId);
    if (!template.enabled || template.updatedAt !== input.templateUpdatedAt) {
      throw new Error(`Response template changed during draft generation: ${input.templateId}`);
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO response_drafts (
        id, decision_id, template_id, rendered_template, text, model,
        input_tokens, output_tokens, latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET
        template_id = excluded.template_id,
        rendered_template = excluded.rendered_template,
        text = excluded.text,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        latency_ms = excluded.latency_ms,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(),
      input.decisionId,
      input.templateId,
      boundedText("rendered template", input.renderedTemplate, 1, 10_000),
      boundedText("response draft", input.text, 1, 10_000),
      boundedText("model", input.model, 1, 200),
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      boundedInteger("latencyMs", input.latencyMs, 0, 3_600_000),
      now,
      now,
    );
    const draft = this.getResponseDraftByDecision(input.decisionId);
    if (draft === undefined) throw new Error("Failed to persist response draft");
    this.recordAudit("response_draft.saved", "response_draft", draft.id, input.decisionId);
    return draft;
  }

  public getResponseDraftByDecision(decisionId: string): ResponseDraft | undefined {
    const row = this.database.prepare(
      "SELECT * FROM response_drafts WHERE decision_id = ?",
    ).get(decisionId);
    return row === undefined ? undefined : responseDraftFromRow(row);
  }

  public listResponseDrafts(limit = 100): ResponseDraft[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    return this.database.prepare(
      "SELECT * FROM response_drafts ORDER BY updated_at DESC LIMIT ?",
    ).all(safeLimit).map(responseDraftFromRow);
  }

  public summary(): MonitoringSummary {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM monitored_groups) AS groups_count,
        (SELECT COUNT(*) FROM monitored_groups WHERE enabled = 1) AS enabled_groups,
        (SELECT COUNT(*) FROM jobs WHERE status = 'queued') AS queued_jobs,
        (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS running_jobs,
        (SELECT COUNT(*) FROM jobs WHERE status = 'dead') AS dead_jobs,
        (SELECT COUNT(*) FROM posts) AS posts_count,
        (SELECT COUNT(*) FROM lead_decisions WHERE status = 'review') AS review_decisions,
        (SELECT COUNT(*) FROM response_templates) AS response_templates,
        (SELECT COUNT(*) FROM response_drafts) AS response_drafts,
        (SELECT MAX(completed_at) FROM scan_runs WHERE status = 'succeeded') AS last_successful_scan_at
    `).get();
    if (counts === undefined) throw new Error("Failed to calculate monitoring summary");
    const lastSuccessfulScanAt = nullableString(counts.last_successful_scan_at);
    return {
      groups: numeric(counts.groups_count),
      enabledGroups: numeric(counts.enabled_groups),
      queuedJobs: numeric(counts.queued_jobs),
      runningJobs: numeric(counts.running_jobs),
      deadJobs: numeric(counts.dead_jobs),
      posts: numeric(counts.posts_count),
      reviewDecisions: numeric(counts.review_decisions),
      responseTemplates: numeric(counts.response_templates),
      responseDrafts: numeric(counts.response_drafts),
      ...(lastSuccessfulScanAt === undefined ? {} : { lastSuccessfulScanAt }),
    };
  }

  public listAuditEvents(limit = 100): AuditEvent[] {
    const safeLimit = boundedInteger("limit", limit, 1, 500);
    return this.database.prepare(
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?",
    ).all(safeLimit).map(auditFromRow);
  }

  public recordAudit(
    type: string,
    entityType: string,
    entityId: string,
    detail?: string,
  ): void {
    this.database.prepare(`
      INSERT INTO audit_events (id, type, entity_type, entity_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      boundedText("audit type", type, 1, 100),
      boundedText("entity type", entityType, 1, 100),
      boundedText("entity id", entityId, 1, 500),
      optionalBoundedText("audit detail", detail, 2_000) ?? null,
      new Date().toISOString(),
    );
  }

  private getScanRun(scanId: string): ScanRun {
    const row = this.database.prepare("SELECT * FROM scan_runs WHERE id = ?").get(scanId);
    if (row === undefined) throw new Error(`Unknown scan: ${scanId}`);
    return scanFromRow(row);
  }

  private insertJob(groupId: string, idempotencyKey: string, availableAt: string): boolean {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO jobs (
        id, type, group_id, status, attempts, max_attempts, available_at,
        idempotency_key, created_at, updated_at
      ) VALUES (?, 'scan_group', ?, 'queued', 0, 5, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(randomUUID(), groupId, availableAt, idempotencyKey, now, now);
    return result.changes > 0;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateLegacyAccounts(dataDir: string): void {
    const legacyPath = path.join(dataDir, "accounts.json");
    if (!existsSync(legacyPath)) return;
    const accounts = parseLegacyAccounts(readFileSync(legacyPath, "utf8"));
    this.transaction(() => {
      for (const account of accounts) {
        const byId = this.database.prepare("SELECT * FROM accounts WHERE id = ?").get(account.id);
        const byProfile = this.database.prepare(
          "SELECT * FROM accounts WHERE camofox_user_id = ?",
        ).get(account.camofoxUserId);
        if (byId !== undefined) {
          const existing = accountFromRow(byId);
          if (
            existing.camofoxUserId !== account.camofoxUserId ||
            existing.sessionKey !== account.sessionKey
          ) {
            throw new Error(`Conflicting legacy account: ${account.id}`);
          }
          continue;
        }
        if (byProfile !== undefined) {
          throw new Error(`Conflicting legacy Camofox profile: ${account.camofoxUserId}`);
        }
        this.database.prepare(`
          INSERT INTO accounts (
            id, label, camofox_user_id, session_key, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          account.id,
          account.label,
          account.camofoxUserId,
          account.sessionKey,
          account.enabled ? 1 : 0,
          account.createdAt,
          account.updatedAt,
        );
      }
    });
    renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}`);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        camofox_user_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitored_groups (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        scan_interval_seconds INTEGER NOT NULL,
        max_posts_per_scan INTEGER NOT NULL,
        prompt_context TEXT NOT NULL DEFAULT '',
        last_scanned_at TEXT,
        next_scan_at TEXT NOT NULL,
        last_status TEXT NOT NULL CHECK(last_status IN ('never','running','succeeded','failed','auth_required')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type = 'scan_group'),
        group_id TEXT NOT NULL REFERENCES monitored_groups(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        lease_token TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, available_at, created_at);

      CREATE TABLE IF NOT EXISTS scan_runs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES monitored_groups(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','auth_required')),
        posts_seen INTEGER NOT NULL DEFAULT 0,
        posts_new INTEGER NOT NULL DEFAULT 0,
        decisions_created INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES monitored_groups(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        author TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS posts_discovered_idx ON posts(discovered_at DESC);

      CREATE TABLE IF NOT EXISTS response_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        llm_instruction TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS response_templates_category_idx
        ON response_templates(enabled, category, updated_at DESC);

      CREATE TABLE IF NOT EXISTS lead_decisions (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
        relevant INTEGER NOT NULL CHECK(relevant IN (0, 1)),
        category TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ignored','review')),
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS response_drafts (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE REFERENCES lead_decisions(id) ON DELETE CASCADE,
        template_id TEXT REFERENCES response_templates(id) ON DELETE SET NULL,
        rendered_template TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS response_drafts_updated_idx ON response_drafts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at DESC);
    `);
    this.ensureColumn("jobs", "lease_token", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function accountFromRow(row: Record<string, SQLOutputValue>): FacebookAccount {
  return {
    id: requiredString(row.id),
    label: requiredString(row.label),
    camofoxUserId: requiredString(row.camofox_user_id),
    sessionKey: requiredString(row.session_key),
    enabled: numeric(row.enabled) === 1,
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function groupFromRow(row: Record<string, SQLOutputValue>): MonitoredGroup {
  const lastScannedAt = nullableString(row.last_scanned_at);
  const lastError = nullableString(row.last_error);
  return {
    id: requiredString(row.id),
    accountId: requiredString(row.account_id),
    name: requiredString(row.name),
    url: requiredString(row.url),
    enabled: numeric(row.enabled) === 1,
    scanIntervalSeconds: numeric(row.scan_interval_seconds),
    maxPostsPerScan: numeric(row.max_posts_per_scan),
    promptContext: requiredString(row.prompt_context),
    ...(lastScannedAt === undefined ? {} : { lastScannedAt }),
    nextScanAt: requiredString(row.next_scan_at),
    lastStatus: requiredString(row.last_status) as MonitoredGroup["lastStatus"],
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function jobFromRow(row: Record<string, SQLOutputValue>): AgentJob {
  const leaseOwner = nullableString(row.lease_owner);
  const leaseUntil = nullableString(row.lease_until);
  const leaseToken = nullableString(row.lease_token);
  const lastError = nullableString(row.last_error);
  return {
    id: requiredString(row.id),
    type: "scan_group",
    groupId: requiredString(row.group_id),
    status: requiredString(row.status) as AgentJob["status"],
    attempts: numeric(row.attempts),
    maxAttempts: numeric(row.max_attempts),
    availableAt: requiredString(row.available_at),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    ...(leaseToken === undefined ? {} : { leaseToken }),
    idempotencyKey: requiredString(row.idempotency_key),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function scanFromRow(row: Record<string, SQLOutputValue>): ScanRun {
  const completedAt = nullableString(row.completed_at);
  const error = nullableString(row.error);
  return {
    id: requiredString(row.id),
    groupId: requiredString(row.group_id),
    jobId: requiredString(row.job_id),
    status: requiredString(row.status) as ScanRun["status"],
    postsSeen: numeric(row.posts_seen),
    postsNew: numeric(row.posts_new),
    decisionsCreated: numeric(row.decisions_created),
    startedAt: requiredString(row.started_at),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

function postFromRow(row: Record<string, SQLOutputValue>): StoredPost {
  const author = nullableString(row.author);
  const publishedAt = nullableString(row.published_at);
  return {
    id: requiredString(row.id),
    groupId: requiredString(row.group_id),
    externalId: requiredString(row.external_id),
    url: requiredString(row.url),
    ...(author === undefined ? {} : { author }),
    content: requiredString(row.content),
    contentHash: requiredString(row.content_hash),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    discoveredAt: requiredString(row.discovered_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function decisionFromRow(row: Record<string, SQLOutputValue>): LeadDecision {
  const inputTokens = nullableNumber(row.input_tokens);
  const outputTokens = nullableNumber(row.output_tokens);
  return {
    id: requiredString(row.id),
    postId: requiredString(row.post_id),
    relevant: numeric(row.relevant) === 1,
    category: requiredString(row.category),
    confidence: numeric(row.confidence),
    reason: requiredString(row.reason),
    status: requiredString(row.status) as LeadDecision["status"],
    model: requiredString(row.model),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    latencyMs: numeric(row.latency_ms),
    createdAt: requiredString(row.created_at),
  };
}

function responseTemplateFromRow(row: Record<string, SQLOutputValue>): ResponseTemplate {
  return {
    id: requiredString(row.id),
    name: requiredString(row.name),
    category: requiredString(row.category),
    body: requiredString(row.body),
    llmInstruction: requiredString(row.llm_instruction),
    enabled: numeric(row.enabled) === 1,
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function responseDraftFromRow(row: Record<string, SQLOutputValue>): ResponseDraft {
  const templateId = nullableString(row.template_id);
  const inputTokens = nullableNumber(row.input_tokens);
  const outputTokens = nullableNumber(row.output_tokens);
  return {
    id: requiredString(row.id),
    decisionId: requiredString(row.decision_id),
    ...(templateId === undefined ? {} : { templateId }),
    renderedTemplate: requiredString(row.rendered_template),
    text: requiredString(row.text),
    model: requiredString(row.model),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    latencyMs: numeric(row.latency_ms),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

function auditFromRow(row: Record<string, SQLOutputValue>): AuditEvent {
  const detail = nullableString(row.detail);
  return {
    id: requiredString(row.id),
    type: requiredString(row.type),
    entityType: requiredString(row.entity_type),
    entityId: requiredString(row.entity_id),
    ...(detail === undefined ? {} : { detail }),
    createdAt: requiredString(row.created_at),
  };
}

function requiredString(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid string value in monitoring database");
  return value;
}

function nullableString(value: SQLOutputValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numeric(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error("Invalid numeric value in monitoring database");
}

function nullableNumber(value: SQLOutputValue | undefined): number | undefined {
  return value === null ? undefined : numeric(value);
}

function validatedSpintaxBody(value: string): string {
  const body = boundedText("template body", value, 1, 10_000);
  renderSpintax(body, "validation");
  return body;
}

function responseCategory(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(normalized)) {
    throw new Error("response category must use lowercase letters, digits and underscores");
  }
  return normalized;
}

function normalizedIdentifier(name: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/.test(normalized)) {
    throw new Error(`${name} must be a valid account identifier`);
  }
  return normalized;
}

function boundedText(name: string, value: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain ${minimum}-${maximum} characters`);
  }
  return normalized;
}

function optionalBoundedText(
  name: string,
  value: string | undefined,
  maximum: number,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return boundedText(name, value, 1, maximum);
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedNumber(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalIsoDate(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid date`);
  return parsed.toISOString();
}

function facebookGroupUrl(value: string): string {
  const url = facebookUrl(value, "group URL");
  if (!url.pathname.toLowerCase().startsWith("/groups/")) {
    throw new Error("Group URL must point to a Facebook group");
  }
  url.hash = "";
  return url.toString();
}

function facebookPostUrl(value: string): string {
  const url = facebookUrl(value, "post URL");
  url.hash = "";
  return url.toString();
}

function facebookUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) {
    throw new Error(`${label} must use HTTPS and belong to facebook.com`);
  }
  return url;
}

function accountToken(name: string, value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || !/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error(`${name} must contain only letters, digits, underscores or hyphens`);
  }
  return normalized;
}

function parseLegacyAccounts(raw: string): FacebookAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid legacy account registry JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid legacy account registry");
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.accounts)) {
    throw new Error("Invalid legacy account registry version");
  }
  return document.accounts.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid legacy account entry");
    const account = value as Record<string, unknown>;
    if (
      typeof account.id !== "string" ||
      typeof account.label !== "string" ||
      typeof account.camofoxUserId !== "string" ||
      typeof account.sessionKey !== "string" ||
      typeof account.enabled !== "boolean" ||
      typeof account.createdAt !== "string" ||
      typeof account.updatedAt !== "string" ||
      Number.isNaN(Date.parse(account.createdAt)) ||
      Number.isNaN(Date.parse(account.updatedAt))
    ) {
      throw new Error("Invalid legacy account entry");
    }
    return {
      id: assertAccountId(account.id),
      label: assertLabel(account.label),
      camofoxUserId: accountToken("camofoxUserId", account.camofoxUserId, 97),
      sessionKey: accountToken("sessionKey", account.sessionKey, 64),
      enabled: account.enabled,
      createdAt: new Date(account.createdAt).toISOString(),
      updatedAt: new Date(account.updatedAt).toISOString(),
    };
  });
}

function secureDatabaseFiles(databasePath: string): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
