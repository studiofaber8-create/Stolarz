import { hostname } from "node:os";
import type { AgentConfig } from "../config.js";
import type { AgentJob, LeadDecision, MonitoredGroup, ScanRun } from "../domain/monitoring.js";
import {
  FacebookAdapter,
  FacebookSessionStateError,
} from "../facebook/facebook-adapter.js";
import { MonitoringStore } from "../infra/monitoring-store.js";
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
    };
  }

  public async runOnce(scheduleDue = true): Promise<boolean> {
    if (scheduleDue) this.scheduleDueScans();
    const job = this.store.claimNextJob(this.workerId, this.config.leaseMs);
    if (job === undefined) return false;
    await this.processJob(job);
    return true;
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
        const job = this.store.claimNextJob(this.workerId, this.config.leaseMs);
        if (job === undefined) {
          await abortableDelay(this.config.pollIntervalMs, signal);
          continue;
        }
        await this.processJob(job);
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

  private scheduleDueScans(): void {
    const created = this.store.enqueueDueScans();
    if (created > 0) {
      this.logger.info("scheduler.jobs_created", { count: created });
    }
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
        const shouldClassify =
          this.classifier !== undefined &&
          (stored.isNew || stored.contentChanged || !this.store.hasDecision(stored.post.id));
        let decision: LeadDecision | undefined = this.store.getDecisionByPost(stored.post.id);
        if (shouldClassify && this.classifier !== undefined) {
          const classified = await this.classifier.classify(group, stored.post);
          if (leaseLost) throw new Error(`Job lease lost: ${job.id}`);
          this.store.assertJobLease(job.id, leaseToken);
          decision = this.store.saveDecisionForJob(job.id, leaseToken, {
            postId: stored.post.id,
            relevant: classified.decision.relevant,
            category: classified.decision.category,
            confidence: classified.decision.confidence,
            reason: classified.decision.reason,
            status: classified.decision.status,
            model: classified.model,
            latencyMs: classified.latencyMs,
            ...(classified.inputTokens === undefined ? {} : { inputTokens: classified.inputTokens }),
            ...(classified.outputTokens === undefined ? {} : { outputTokens: classified.outputTokens }),
          });
          counts.decisionsCreated += 1;
        }
        if (
          decision?.status === "review" &&
          this.draftGenerator !== undefined &&
          this.store.getResponseDraftByDecision(decision.id) === undefined
        ) {
          const template = this.store.findResponseTemplate(decision.category);
          if (template !== undefined) {
            try {
              const draft = await this.draftGenerator.generate(
                template,
                group,
                stored.post,
                decision,
              );
              if (leaseLost) throw new Error(`Job lease lost: ${job.id}`);
              this.store.assertJobLease(job.id, leaseToken);
              this.store.saveResponseDraftForJob(job.id, leaseToken, draft);
            } catch (error) {
              const draftError = errorMessage(error);
              if (draftError.startsWith("Job lease lost:")) throw error;
              this.store.recordAudit(
                "response_draft.failed",
                "decision",
                decision.id,
                draftError.slice(0, 2_000),
              );
              this.logger.warn("response_draft.failed", {
                decisionId: decision.id,
                templateId: template.id,
                error: draftError.slice(0, 1_000),
              });
            }
          }
        }
      }
      if (leaseLost) throw new Error(`Job lease lost: ${job.id}`);
      this.store.finishSuccessfulScan(scan.id, job.id, leaseToken, counts);
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
        suspension === "account"
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
        suspension === "account"
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
