import { createHash } from "node:crypto";
import type {
  LeadDecision,
  MonitoredGroup,
  ResponseTemplate,
  StoredPost,
} from "../domain/monitoring.js";

export function classificationSourceVersion(
  group: MonitoredGroup,
  post: StoredPost,
): string {
  return fingerprint({
    groupId: group.id,
    groupName: group.name,
    groupContext: group.promptContext,
    postId: post.id,
    postAuthor: post.author ?? null,
    postContent: post.content,
    postUrl: post.url,
  });
}

export function draftSourceVersion(
  template: ResponseTemplate,
  group: MonitoredGroup,
  post: StoredPost,
  decision: LeadDecision,
): string {
  return fingerprint({
    templateId: template.id,
    templateBody: template.body,
    templateInstruction: template.llmInstruction,
    templateEnabled: template.enabled,
    templateUpdatedAt: template.updatedAt,
    groupId: group.id,
    groupName: group.name,
    groupContext: group.promptContext,
    postId: post.id,
    postAuthor: post.author ?? null,
    postContent: post.content,
    decisionId: decision.id,
    decisionRelevant: decision.relevant,
    decisionCategory: decision.category,
    decisionConfidence: decision.confidence,
    decisionReason: decision.reason,
    decisionStatus: decision.status,
    decisionCreatedAt: decision.createdAt,
  });
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
