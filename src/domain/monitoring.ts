export type GroupScanStatus = "never" | "running" | "succeeded" | "failed" | "auth_required";
export type ScanRunStatus = "running" | "succeeded" | "failed" | "auth_required";
export type DecisionStatus = "ignored" | "review";
export type JobStatus = "queued" | "running" | "succeeded" | "dead";
export type ExtractionHealth = "unknown" | "healthy" | "empty" | "suspected_drift" | "error";
export type LlmRunOperation = "classification" | "draft";
export type LlmRunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped_budget";
export type LlmErrorCategory =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "invalid_response"
  | "client_error"
  | "stale_input"
  | "budget_daily"
  | "budget_scan"
  | "operation_failed";

export interface LlmWorkDescriptor {
  readonly operation: LlmRunOperation;
  readonly entityId: string;
  readonly groupId: string;
  readonly scanId?: string;
  readonly templateId?: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly sourceVersion: string;
  readonly reservedTokens: number;
}

export interface LlmRun {
  readonly id: string;
  readonly operation: LlmRunOperation;
  readonly entityId: string;
  readonly groupId: string;
  readonly scanId?: string;
  readonly templateId?: string;
  readonly idempotencyKey: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly sourceVersion: string;
  readonly status: LlmRunStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly leaseToken?: string;
  readonly reservedTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs?: number;
  readonly errorCategory?: LlmErrorCategory;
  readonly error?: string;
  readonly retryable?: boolean;
  readonly requestAttempts?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LlmQueueSummary {
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skippedBudget: number;
  readonly tokensToday: number;
  readonly reservedToday: number;
}

export type RecordedFacebookAuthState =
  | "unknown"
  | "authenticated"
  | "login_required"
  | "checkpoint"
  | "blocked"
  | "access_denied";

export interface ScanExtractionDiagnostics {
  readonly extractorVersion: string;
  readonly authState: RecordedFacebookAuthState;
  readonly currentUrl: string;
  readonly snapshotChecks: number;
  readonly scrollRounds: number;
  readonly postsExtracted: number;
  readonly pageErrorCount: number;
}

export interface MonitoredGroup {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly scanIntervalSeconds: number;
  readonly maxPostsPerScan: number;
  readonly promptContext: string;
  readonly lastScannedAt?: string;
  readonly nextScanAt: string;
  readonly lastStatus: GroupScanStatus;
  readonly lastError?: string;
  readonly extractionHealth: ExtractionHealth;
  readonly emptyScanStreak: number;
  readonly extractorVersion?: string;
  readonly lastExtractionAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateGroupInput {
  readonly accountId: string;
  readonly name: string;
  readonly url: string;
  readonly scanIntervalSeconds: number;
  readonly maxPostsPerScan: number;
  readonly promptContext?: string;
}

export interface DiscoveredPostInput {
  readonly externalId: string;
  readonly url: string;
  readonly author?: string;
  readonly content: string;
  readonly publishedAt?: string;
}

export interface StoredPost {
  readonly id: string;
  readonly groupId: string;
  readonly externalId: string;
  readonly url: string;
  readonly author?: string;
  readonly content: string;
  readonly contentHash: string;
  readonly publishedAt?: string;
  readonly discoveredAt: string;
  readonly updatedAt: string;
}

export interface LeadDecision {
  readonly id: string;
  readonly postId: string;
  readonly relevant: boolean;
  readonly category: string;
  readonly confidence: number;
  readonly reason: string;
  readonly status: DecisionStatus;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly createdAt: string;
}

export interface LeadDecisionInput {
  readonly postId: string;
  readonly relevant: boolean;
  readonly category: string;
  readonly confidence: number;
  readonly reason: string;
  readonly status: DecisionStatus;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly requestAttempts?: number;
}

export interface ResponseTemplate {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly body: string;
  readonly llmInstruction: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateResponseTemplateInput {
  readonly name: string;
  readonly category: string;
  readonly body: string;
  readonly llmInstruction?: string;
}

export interface UpdateResponseTemplateInput {
  readonly name?: string;
  readonly category?: string;
  readonly body?: string;
  readonly llmInstruction?: string;
  readonly enabled?: boolean;
}

export interface ResponseDraft {
  readonly id: string;
  readonly decisionId: string;
  readonly templateId?: string;
  readonly renderedTemplate: string;
  readonly text: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResponseDraftInput {
  readonly decisionId: string;
  readonly templateId: string;
  readonly templateUpdatedAt: string;
  readonly renderedTemplate: string;
  readonly text: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly requestAttempts?: number;
}

export interface ScanRun {
  readonly id: string;
  readonly groupId: string;
  readonly jobId: string;
  readonly status: ScanRunStatus;
  readonly postsSeen: number;
  readonly postsNew: number;
  readonly decisionsCreated: number;
  readonly extractorVersion?: string;
  readonly extractionAuthState?: RecordedFacebookAuthState;
  readonly extractionCurrentUrl?: string;
  readonly extractionErrorCategory?: string;
  readonly snapshotChecks: number;
  readonly scrollRounds: number;
  readonly pageErrorCount: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface AgentJob {
  readonly id: string;
  readonly type: "scan_group";
  readonly groupId: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly leaseToken?: string;
  readonly idempotencyKey: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MonitoringSummary {
  readonly groups: number;
  readonly enabledGroups: number;
  readonly queuedJobs: number;
  readonly runningJobs: number;
  readonly deadJobs: number;
  readonly posts: number;
  readonly reviewDecisions: number;
  readonly responseTemplates: number;
  readonly responseDrafts: number;
  readonly extractionDriftGroups: number;
  readonly extractionErrorGroups: number;
  readonly queuedLlmRuns: number;
  readonly failedLlmRuns: number;
  readonly skippedBudgetLlmRuns: number;
  readonly llmTokensToday: number;
  readonly lastSuccessfulScanAt?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly detail?: string;
  readonly createdAt: string;
}
