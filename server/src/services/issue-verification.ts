/**
 * AGE-14800: Reviewer verification block service.
 *
 * Provides validation that reviewer agents (role="qa") include a populated
 * verification block when transitioning issues to in_review or done status.
 * This provides structural enforcement that reviewers independently verify
 * work rather than approving based on narration alone.
 *
 * Verification block fields:
 * - prDiffLinesReviewed: number of diff lines the reviewer examined
 * - acCommandsRun: AC acceptance criteria commands with exit codes + snippets
 * - ciState: CI pipeline status at time of review
 * - filesystemChecks: paths checked for existence
 * - narrative: optional free-text verification summary
 */

import type { VerificationBlock } from "@paperclipai/shared";
import { verificationBlockSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/** Agent roles that require verification blocks for in_review/done transitions. */
const REVIEWER_ROLES = new Set(["qa"]);

/** Status transitions that require a verification block from reviewer agents. */
const VERIFICATION_REQUIRED_STATUSES = new Set(["in_review", "done"]);

/**
 * Determines whether a verification block is required for a given transition.
 *
 * A verification block is required when:
 * 1. The actor is an agent with the "qa" role, AND
 * 2. The transition is moving an issue to "in_review" or "done"
 *
 * Non-reviewer agents and other status transitions are not gated.
 */
export function isVerificationRequired(input: {
  agentRole: string | null | undefined;
  currentStatus: string;
  nextStatus: string;
}): boolean {
  const { agentRole, currentStatus, nextStatus } = input;

  // Only reviewer agents are gated
  if (!agentRole || !REVIEWER_ROLES.has(agentRole)) {
    return false;
  }

  // Only in_review/done transitions are gated; already-being-there is not
  if (currentStatus === nextStatus) {
    return false;
  }

  return VERIFICATION_REQUIRED_STATUSES.has(nextStatus);
}

/**
 * Validates a verification block for completeness.
 *
 * A "populated" verification block must:
 * - Parse successfully against the verificationBlockSchema
 * - Have at least 1 AC command run OR 1 filesystem check
 * - Have a non-zero prDiffLinesReviewed count
 *
 * Returns the parsed verification block on success.
 * Throws an unprocessable error on failure.
 */
export function validateVerificationBlock(raw: unknown): VerificationBlock {
  const parsed = verificationBlockSchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable("Invalid verification block: schema validation failed", {
      code: "VERIFICATION_BLOCK_INVALID",
      details: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const block = parsed.data;

  // Structural completeness: reviewer must have done *something* beyond narration
  const hasCommands = block.acCommandsRun.length > 0;
  const hasFsChecks = block.filesystemChecks.length > 0;
  const hasDiffReview = block.prDiffLinesReviewed > 0;

  if (!hasCommands && !hasFsChecks && !hasDiffReview) {
    throw unprocessable(
      "Verification block must include at least one of: AC commands, filesystem checks, or diff lines reviewed",
      {
        code: "VERIFICATION_BLOCK_EMPTY",
        hint: "Include prDiffLinesReviewed > 0, or at least one acCommandsRun entry, or at least one filesystemChecks entry",
      },
    );
  }

  return block;
}

/**
 * Asserts that a reviewer agent's transition to in_review/done includes a
 * valid verification block. Non-reviewer agents are not checked.
 *
 * This is the main guard function called from the PATCH handler.
 */
export async function assertReviewerVerificationBlock(input: {
  actorType: string;
  agentRole: string | null | undefined;
  currentStatus: string;
  nextStatus: string;
  verification: unknown;
}): Promise<VerificationBlock | undefined> {
  const { actorType, agentRole, currentStatus, nextStatus, verification } = input;

  // Only applies to agent actors
  if (actorType !== "agent") {
    return undefined;
  }

  if (!isVerificationRequired({ agentRole, currentStatus, nextStatus })) {
    return undefined;
  }

  if (verification === undefined || verification === null) {
    throw unprocessable(
      "Reviewer agents must include a verification block when transitioning to in_review or done",
      {
        code: "VERIFICATION_BLOCK_REQUIRED",
        requiredForStatuses: [...VERIFICATION_REQUIRED_STATUSES],
        agentRole,
      },
    );
  }

  return validateVerificationBlock(verification);
}