import type { DecisionStatus } from "../domain/monitoring.js";

export interface ValidatedClassification {
  readonly relevant: boolean;
  readonly category:
    | "custom_kitchen"
    | "wardrobe"
    | "built_in_furniture"
    | "other_custom_furniture"
    | "recommendation_request"
    | "not_relevant";
  readonly confidence: number;
  readonly reason: string;
}

export interface PolicyDecision extends ValidatedClassification {
  readonly status: DecisionStatus;
}

export class LeadPolicyGate {
  public constructor(private readonly reviewThreshold: number) {
    if (!Number.isFinite(reviewThreshold) || reviewThreshold < 0 || reviewThreshold > 1) {
      throw new Error("Review threshold must be between 0 and 1");
    }
  }

  public evaluate(classification: ValidatedClassification): PolicyDecision {
    const internallyConsistent = classification.relevant
      ? classification.category !== "not_relevant"
      : classification.category === "not_relevant";
    const status =
      internallyConsistent && classification.relevant && classification.confidence >= this.reviewThreshold
        ? "review"
        : "ignored";
    return { ...classification, status };
  }
}
