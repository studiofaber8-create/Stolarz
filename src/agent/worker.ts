import { hostname } from "node:os";
import type { AgentConfig } from "../config.js";
import type {
  AgentJob,
  LeadDecision,
  LlmErrorCategory,
  LlmRun,
  LlmWorkDescriptor,
  MonitoredGroup,
  ScanRun,
} from "../domain/monitoring.js";
import {
  FacebookAdapter,
  FacebookExtractionError,
  FacebookSessionStateError,
} from "../facebook/facebook-adapter.js";
import { MonitoringStore } from "../infra/monitoring-store.js";
import { LlmRequestError } from "../llm/custom-llm-client.js";
import type { Logger } from "../observability/logger.js";
import { LeadClassifier } from "./lead-classifier.js";
import { ResponseDraftGenerator } from "./response-draft-generator.js";

export interface WorkerStatus {
  readonly running: boolean;
  readonly workerId: string;
  readonly startedAt?: string;
  readonly lastLoopAt?: string;
  readonly lastJobAt?: string;
  readonly lastError?: string;
  readonly jobsProcessed: number;
  readonly llmRunsProcessed: number;
}

export class AgentWorker {
  private readonly workerId = `${hostname()}-${process.pid}`;
  private abortController: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;
  private startedAt: string | undefined;
  private lastLoopAt: string | undefined;
  private lastJobAt: string | undefined;
  private lastError: string | undefined;
  private jobsProcessed = 0;
  private llmRunsProcessed = 0;
  private preferLlmWork = false;

  public constructor(
    private readonly config: AgentConfig,
    private readonly store: MonitoringStore,
    private readonly facebook: FacebookAdapter,
    private readonly classifier: LeadClassifier | undefined,
    private readonly logger: Logger,
    private readonly draftGenerator?: ResponseDraftGenerator,
  ) {}

  public start(): void {
    if (this.loopPromise !== undefined) return;
    this.abortController = new AbortController();
    this.startedAt = new Date().toISOString();
    this.logger.info("worker.started", { workerId: this.workerId });
    this.loopPromise = this.runLoop(this.abortController.signal).finally(() => {
      this.loopPromise = undefined;
      this.abortController = undefined;
      this.logger.info("worker.stopped", { workerId: this.workerId });
    });
  }

  public async stop(): Promise<void> {
    this.abortController?.abort();
    await this.loopPromise;
  }

  public status(): WorkerStatus {
    return {
      running: this.loopPromise !== undefined,
      workerId: this.workerId,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.lastLoopAt === undefined ? {} : { lastLoopAt: this.lastLoopAt }),
      ...(this.lastJobAt === undefined ? {} : { lastJobAt: this.lastJobAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      jobsProcessed: this.jobsProcessed,
      llmRunsProcessed: this.llmRunsProcessed,
    };
  }

  public async runOnce(scheduleDue = true): Promise<boolean> {
    if (scheduleDue) this.scheduleDueScans();
    return this.runNextWork();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let nextScheduleAt = 0;
    while (!signal.aborted) {
      this.lastLoopAt = new Date().toISOString();
      try {
        if (Date.now() >= nextScheduleAt) {
          this.scheduleDueScans();
          nextScheduleAt = Date.now() + this.config.schedulerIntervalMs;
        }
        if (!await this.runNextWork()) {
          await abortableDelay(this.config.pollIntervalMs, signal);
        }
        this.lastError = undefined;
      } catch (error) {
        if (signal.aborted) break;
        this.lastError = errorMessage(error);
        this.logger.error("worker.loop_failed", {
          workerId: this.workerId,
          error: this.lastError.slice(0, 1_000),
        });
        await abortableDelay(this.config.pollIntervalMs, signal);
      }
    }
  }

  private async runNextWork(): Promise<boolean> {
    this.reconcileLlmWork();
    if (this.preferLlmWork && await this.claimAndProcessLlmRun()) {
      this.preferLlmWork = false;
      return true;
    }
    const job = this.store.claimNextJob(this.workerId, this.config.leaseMs);
    if (job !== undefined) {
      await this.processJob(job);
      this.preferLlmWork = true;
      return true;
    }
    if (await this.claimAndProcessLlmRun()) {
      this.preferLlmWork = false;
      return true;
    }
    return false;
  }

  private scheduleDueScans(): void {
    const created = this.store.enqueueDueScans();
    if (created > 0) {
      this.logger.info("scheduler.jobs_created", { count: created });
    }
  }

  private reconcileLlmWork(): void {
    if (this.classifier === undefined) return;
    for (const post of this.store.listPostsNeedingClassification(100)) {
      try {
        const group = this.store.getGroup(post.groupId);
        this.store.enqueueLlmRun(
          this.classifier.describe(group, post),
          this.config.llmRunMaxAttempts,
        );
      } catch (error) {
        this.logger.warn("llm.reconcile_classification_failed", {
          postId: post.id,
          error: errorMessage(error).slice(0, 1_000),
        });
      }
    }
    if (this.draftGenerator === undefined) return;
    for (const decision of this.store.listDecisionsNeedingDraft(100)) {
      try {
        this.enqueueDraftForDecision(
          decision,
          this.store.findClassificationScanId(decision.postId),
        );
      } catch (error) {
        this.logger.warn("llm.reconcile_draft_failed", {
          decisionId: decision.id,
          error: errorMessage(error).slice(0, 1_000),
        });
      }
    }
  }

  private async claimAndProcessLlmRun(): Promise<boolean> {
    if (this.classifier === undefined) return false;
    const run = this.store.claimNextLlmRun(
      this.workerId,
      this.config.leaseMs,
      this.config.llmDailyTokenBudget,
      this.config.llmScanTokenBudget,
    );
    if (run === undefined) return false;
    await this.processLlmRun(run);
    return true;
  }

  private async processLlmRun(run: LlmRun): Promise<void> {
    const leaseToken = requiredLlmLeaseToken(run);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        this.store.extendLlmRunLease(run.id, leaseToken, this.config.leaseMs);
      } catch (error) {
        leaseLost = true;
        this.logger.error("llm.lease_lost", {
          runId: run.id,
          error: errorMessage(error),
        });
      }
    }, Math.max(1_000, Math.floor(this.config.leaseMs / 3)));
    heartbeat.unref();
    this.logger.info("llm.run_started", {
      runId: run.id,
      operation: run.operation,
      attempt: run.attempts,
    });
    try {
      const completed = run.operation === "classification"
        ? await this.processClassificationRun(run, leaseToken)
        : await this.processDraftRun(run, leaseToken);
      if (!completed) {
        this.llmRunsProcessed += 1;
        this.store.recordAudit("llm.superseded", "llm_run", run.id, run.operation);
        this.logger.info("llm.run_superseded", { runId: run.id, operation: run.operation });
        return;
      }
      if (leaseLost) throw new Error(`LLM run lease lost: ${run.id}`);
      this.llmRunsProcessed += 1;
      this.store.recordAudit("llm.succeeded", "llm_run", run.id, run.operation);
      this.logger.info("llm.run_succeeded", { runId: run.id, operation: run.operation });
    } catch (error) {
      const message = errorMessage(error);
      if (leaseLost || message.startsWith("LLM run lease lost:")) {
        this.lastError = message;
        this.llmRunsProcessed += 1;
        this.logger.warn("llm.abandoned_after_lease_loss", { runId: run.id, error: message });
        return;
      }
      const failure = classifyLlmFailure(error);
      const failed = this.store.failLlmRun(
        run.id,
        leaseToken,
        failure.category,
        message,
        failure.retryable,
        llmRetryTime(run.attempts, failure.retryAfterMs),
        failure.requestAttempts,
      );
      this.llmRunsProcessed += 1;
      this.lastError = message;
      this.store.recordAudit(
        failed.status === "queued" ? "llm.retry_scheduled" : "llm.failed",
        "llm_run",
        run.id,
        `${failure.category}: ${message}`.slice(0, 2_000),
      );
      this.logger.warn(
        failed.status === "queued" ? "llm.run_retry_scheduled" : "llm.run_failed",
        {
          runId: run.id,
          operation: run.operation,
          attempt: failed.attempts,
          category: failure.category,
          error: message.slice(0, 1_000),
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processClassificationRun(run: LlmRun, leaseToken: string): Promise<boolean> {
    if (this.classifier === undefined) throw new Error("Lead classifier is not configured");
    const post = this.store.getPost(run.entityId);
    const group = this.store.getGroup(post.groupId);
    const descriptor = this.classifier.describe(group, post);
    if (!matchesLlmDescriptor(run, descriptor)) {
      this.store.failLlmRun(
        run.id,
        leaseToken,
        "stale_input",
        "Classification input changed before execution",
        false,
        new Date().toISOString(),
      );
      this.store.enqueueLlmRun(descriptor, this.config.llmRunMaxAttempts);
      return false;
    }
    const classified = await this.classifier.classify(group, post, run.idempotencyKey);
    const decision = this.store.completeClassificationLlmRun(run.id, leaseToken, {
      postId: post.id,
      relevant: classified.decision.relevant,
      category: classified.decision.category,
      confidence: classified.decision.confidence,
      reason: classified.decision.reason,
      status: classified.decision.status,
      model: classified.model,
      latencyMs: classified.latencyMs,
      requestAttempts: classified.requestAttempts,
      ...(classified.inputTokens === undefined ? {} : { inputTokens: classified.inputTokens }),
      ...(classified.outputTokens === undefined ? {} : { outputTokens: classified.outputTokens }),
    });
    try {
      this.enqueueDraftForDecision(decision, run.scanId);
    } catch (error) {
      this.logger.warn("llm.enqueue_draft_failed", {
        decisionId: decision.id,
        error: errorMessage(error).slice(0, 1_000),
      });
    }
    return true;
  }

  private async processDraftRun(run: LlmRun, leaseToken: string): Promise<boolean> {
    if (this.draftGenerator === undefined) throw new Error("Response draft generator is not configured");
    const decision = this.store.getDecision(run.entityId);
    const post = this.store.getPost(decision.postId);
    const group = this.store.getGroup(post.groupId);
    if (decision.status !== "review" || run.templateId === undefined) {
      throw new Error("Draft input is no longer eligible for review");
    }
    const template = this.store.getResponseTemplate(run.templateId);
    const descriptor = this.draftGenerator.describe(template, group, post, decision);
    if (!template.enabled || !matchesLlmDescriptor(run, descriptor)) {
      this.store.failLlmRun(
        run.id,
        leaseToken,
        "stale_input",
        "Draft input or template changed before execution",
        false,
        new Date().toISOString(),
      );
      if (template.enabled) {
        this.store.enqueueLlmRun(descriptor, this.config.llmRunMaxAttempts);
      }
      return false;
    }
    const draft = await this.draftGenerator.generate(
      template,
      group,
      post,
      decision,
      run.idempotencyKey,
    );
    this.store.completeDraftLlmRun(run.id, leaseToken, draft);
    return true;
  }

  private enqueueDraftForDecision(decision: LeadDecision, scanId?: string): void {
    if (decision.status !== "review" || this.draftGenerator === undefined) return;
    const template = this.store.findResponseTemplate(decision.category);
    if (template === undefined) return;
    const post = this.store.getPost(decision.postId);
    const group = this.store.getGroup(post.groupId);
    this.store.enqueueLlmRun(
      {
        ...this.draftGenerator.describe(template, group, post, decision),
        ...(scanId === undefined ? {} : { scanId }),
      },
      this.config.llmRunMaxAttempts,
    );
  }

  private async processJob(job: AgentJob): Promise<void> {
    const leaseToken = requiredLeaseToken(job);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        this.store.extendJobLease(job.id, leaseToken, this.config.leaseMs);
      } catch (error) {
        leaseLost = true;
        this.logger.error("job.lease_lost", {
          jobId: job.id,
          error: errorMessage(error),
        });
      }
    }, Math.max(1_000, Math.floor(this.config.leaseMs / 3)));
    heartbeat.unref();
    this.lastJobAt = new Date().toISOString();
    this.logger.info("job.started", {
      jobId: job.id,
      groupId: job.groupId,
      attempt: job.attempts,
    });
    let scan: ScanRun | undefined;
    let group: MonitoredGroup | undefined;
    const counts = { postsSeen: 0, postsNew: 0, decisionsCreated: 0 };
    try {
      group = this.store.getGroup(job.groupId);
      scan = this.store.startScanRunForJob(group.id, job.id, leaseToken);
      const result = await this.facebook.scanGroup(group);
      counts.postsSeen = result.posts.length;
      this.store.recordScanExtraction(
        scan.id,
        job.id,
        leaseToken,
        { ...result.diagnostics, currentUrl: result.currentUrl },
      );
      for (const discovered of result.posts) {
        if (leaseLost) throw new Error(`Job lease lost: ${job.id}`);
        this.store.assertJobLease(job.id, leaseToken);
        const stored = this.store.upsertPostForJob(
          job.id,
          leaseToken,
          group.id,
          discovered,
        );
        if (stored.isNew) counts.postsNew += 1;
        if (this.classifier !== undefined) {
          this.store.enqueueLlmRunForJob(
            job.id,
            leaseToken,
            { ...this.classifier.describe(group, stored.post), scanId: scan.id },
            this.config.llmRunMaxAttempts,
          );
        }
      }
      if (leaseLost) throw new Error(`Job lease lost: ${job.id}`);
      const completion = this.store.finishSuccessfulScan(scan.id, job.id, leaseToken, counts);
      if (completion.extraction?.driftDetected) {
        this.logger.warn("extractor.drift_suspected", {
          groupId: group.id,
          extractorVersion: result.diagnostics.extractorVersion,
          emptyScanStreak: completion.extraction.emptyScanStreak,
        });
      } else if (completion.extraction?.recovered) {
        this.logger.info("extractor.recovered", {
          groupId: group.id,
          extractorVersion: result.diagnostics.extractorVersion,
        });
      }
      this.store.recordAudit(
        "scan.succeeded",
        "scan",
        scan.id,
        JSON.stringify(counts),
      );
      this.jobsProcessed += 1;
      this.logger.info("job.succeeded", {
        jobId: job.id,
        groupId: group.id,
        postsSeen: counts.postsSeen,
        postsNew: counts.postsNew,
        decisionsCreated: counts.decisionsCreated,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (leaseLost || message.startsWith("Job lease lost:")) {
        this.lastError = message;
        this.jobsProcessed += 1;
        this.logger.warn("job.abandoned_after_lease_loss", {
          jobId: job.id,
          groupId: job.groupId,
          error: message,
        });
        return;
      }
      this.store.assertJobLease(job.id, leaseToken);
      if (error instanceof FacebookExtractionError && scan !== undefined) {
        this.store.recordScanExtractionFailure(
          scan.id,
          job.id,
          leaseToken,
          error.extractorVersion,
          error.category,
        );
      }
      const accountAuthState =
        error instanceof FacebookSessionStateError &&
        (error.state === "login_required" || error.state === "checkpoint" || error.state === "blocked")
          ? error.state
          : undefined;
      const suspension =
        accountAuthState !== undefined
          ? "account"
          : error instanceof FacebookSessionStateError && error.state === "access_denied"
            ? "group"
            : undefined;
      this.store.finishFailedScanAndJob(
        scan?.id,
        job.id,
        leaseToken,
        counts,
        message,
        retryTime(job.attempts),
        suspension,
        accountAuthState,
      );
      const auditEvent =
        error instanceof FacebookExtractionError
          ? "scan.extraction_failed"
          : suspension === "account"
            ? "scan.auth_required"
            : suspension === "group"
              ? "scan.access_denied"
              : "scan.failed";
      this.store.recordAudit(
        auditEvent,
        "job",
        job.id,
        message.slice(0, 2_000),
      );
      this.lastError = message;
      this.jobsProcessed += 1;
      const logEvent =
        error instanceof FacebookExtractionError
          ? "job.extraction_failed"
          : suspension === "account"
            ? "job.auth_required"
            : suspension === "group"
              ? "job.access_denied"
              : "job.failed";
      this.logger.warn(logEvent, {
        jobId: job.id,
        groupId: job.groupId,
        attempt: job.attempts,
        error: message.slice(0, 1_000),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function requiredLlmLeaseToken(run: LlmRun): string {
  if (run.leaseToken === undefined) throw new Error(`Claimed LLM run has no lease token: ${run.id}`);
  return run.leaseToken;
}

function matchesLlmDescriptor(run: LlmRun, descriptor: LlmWorkDescriptor): boolean {
  return run.operation === descriptor.operation &&
    run.entityId === descriptor.entityId &&
    run.groupId === descriptor.groupId &&
    run.templateId === descriptor.templateId &&
    run.model === descriptor.model &&
    run.promptVersion === descriptor.promptVersion &&
    run.inputHash === descriptor.inputHash &&
    run.sourceVersion === descriptor.sourceVersion;
}

function classifyLlmFailure(error: unknown): {
  category: LlmErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
  requestAttempts?: number;
} {
  if (error instanceof LlmRequestError) {
    return {
      category: error.category,
      retryable: error.retryable,
      requestAttempts: error.attempts,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  const message = errorMessage(error);
  if (
    message.startsWith("LLM classification") ||
    message.startsWith("Generated response draft")
  ) {
    return { category: "invalid_response", retryable: true };
  }
  if (
    message.startsWith("Response template changed") ||
    message.startsWith("LLM source changed during request:") ||
    message.includes("no longer eligible") ||
    message.startsWith("Unknown response template:")
  ) {
    return { category: "stale_input", retryable: false };
  }
  return { category: "operation_failed", retryable: false };
}

function llmRetryTime(attempts: number, retryAfterMs?: number): string {
  const exponential = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + Math.max(exponential, retryAfterMs ?? 0)).toISOString();
}

function requiredLeaseToken(job: AgentJob): string {
  if (job.leaseToken === undefined) throw new Error(`Claimed job has no lease token: ${job.id}`);
  return job.leaseToken;
}

function retryTime(attempts: number): string {
  const delayMs = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
