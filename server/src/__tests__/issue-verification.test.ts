import { describe, expect, it } from "vitest";
import {
  isVerificationRequired,
  validateVerificationBlock,
  assertReviewerVerificationBlock,
} from "../services/issue-verification.js";
import { HttpError } from "../errors.js";

// --- isVerificationRequired ---

describe("isVerificationRequired", () => {
  it("returns false for non-qa agents", () => {
    expect(
      isVerificationRequired({
        agentRole: "general",
        currentStatus: "in_progress",
        nextStatus: "in_review",
      }),
    ).toBe(false);
  });

  it("returns false for null agentRole", () => {
    expect(
      isVerificationRequired({
        agentRole: null,
        currentStatus: "in_progress",
        nextStatus: "in_review",
      }),
    ).toBe(false);
  });

  it("returns false for undefined agentRole", () => {
    expect(
      isVerificationRequired({
        agentRole: undefined,
        currentStatus: "in_progress",
        nextStatus: "in_review",
      }),
    ).toBe(false);
  });

  it("returns false when status does not change", () => {
    expect(
      isVerificationRequired({
        agentRole: "qa",
        currentStatus: "in_review",
        nextStatus: "in_review",
      }),
    ).toBe(false);
  });

  it("returns true for qa agent transitioning to in_review", () => {
    expect(
      isVerificationRequired({
        agentRole: "qa",
        currentStatus: "in_progress",
        nextStatus: "in_review",
      }),
    ).toBe(true);
  });

  it("returns true for qa agent transitioning to done", () => {
    expect(
      isVerificationRequired({
        agentRole: "qa",
        currentStatus: "in_review",
        nextStatus: "done",
      }),
    ).toBe(true);
  });

  it("returns false for qa agent transitioning to in_progress", () => {
    expect(
      isVerificationRequired({
        agentRole: "qa",
        currentStatus: "todo",
        nextStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("returns false for qa agent transitioning to blocked", () => {
    expect(
      isVerificationRequired({
        agentRole: "qa",
        currentStatus: "in_progress",
        nextStatus: "blocked",
      }),
    ).toBe(false);
  });
});

// --- validateVerificationBlock ---

describe("validateVerificationBlock", () => {
  const validBlock = {
    prDiffLinesReviewed: 42,
    acCommandsRun: [
      { command: "npm test", exitCode: 0, outputSnippet: "3 tests passed" },
    ],
    ciState: "green" as const,
    filesystemChecks: [{ path: "/src/app.ts", exists: true }],
  };

  it("accepts a fully populated valid block", () => {
    const result = validateVerificationBlock(validBlock);
    expect(result.prDiffLinesReviewed).toBe(42);
    expect(result.acCommandsRun).toHaveLength(1);
    expect(result.ciState).toBe("green");
  });

  it("accepts a block with only prDiffLinesReviewed > 0", () => {
    const block = {
      prDiffLinesReviewed: 10,
      acCommandsRun: [],
      ciState: "not_applicable" as const,
      filesystemChecks: [],
    };
    const result = validateVerificationBlock(block);
    expect(result.prDiffLinesReviewed).toBe(10);
  });

  it("accepts a block with only acCommandsRun", () => {
    const block = {
      prDiffLinesReviewed: 0,
      acCommandsRun: [{ command: "npm test", exitCode: 0 }],
      ciState: "green" as const,
      filesystemChecks: [],
    };
    const result = validateVerificationBlock(block);
    expect(result.acCommandsRun).toHaveLength(1);
  });

  it("rejects an empty block with no verification evidence", () => {
    const emptyBlock = {
      prDiffLinesReviewed: 0,
      acCommandsRun: [],
      ciState: "not_applicable" as const,
      filesystemChecks: [],
    };
    expect(() => validateVerificationBlock(emptyBlock)).toThrow();
  });

  it("rejects a block with invalid ciState", () => {
    const block = {
      ...validBlock,
      ciState: "invalid_state",
    };
    expect(() => validateVerificationBlock(block)).toThrow();
  });

  it("rejects a block with missing required fields", () => {
    expect(() => validateVerificationBlock({})).toThrow();
  });

  it("accepts a block with optional narrative", () => {
    const block = {
      ...validBlock,
      narrative: "All AC criteria verified through independent command execution",
    };
    const result = validateVerificationBlock(block);
    expect(result.narrative).toBe("All AC criteria verified through independent command execution");
  });

  it("accepts ciState values: green, red, mixed, not_applicable", () => {
    for (const ciState of ["green", "red", "mixed", "not_applicable"] as const) {
      const block = { ...validBlock, ciState };
      const result = validateVerificationBlock(block);
      expect(result.ciState).toBe(ciState);
    }
  });
});

// --- assertReviewerVerificationBlock ---

describe("assertReviewerVerificationBlock", () => {
  const validVerification = {
    prDiffLinesReviewed: 50,
    acCommandsRun: [{ command: "npm test", exitCode: 0 }],
    ciState: "green" as const,
    filesystemChecks: [],
  };

  it("returns undefined for non-agent actors", async () => {
    const result = await assertReviewerVerificationBlock({
      actorType: "user",
      agentRole: "qa",
      currentStatus: "in_progress",
      nextStatus: "in_review",
      verification: validVerification,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-qa agents transitioning to in_review", async () => {
    const result = await assertReviewerVerificationBlock({
      actorType: "agent",
      agentRole: "general",
      currentStatus: "in_progress",
      nextStatus: "in_review",
      verification: validVerification,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when verification is not required (non-target status)", async () => {
    const result = await assertReviewerVerificationBlock({
      actorType: "agent",
      agentRole: "qa",
      currentStatus: "todo",
      nextStatus: "in_progress",
      verification: null,
    });
    expect(result).toBeUndefined();
  });

  it("returns parsed block for qa agent providing valid verification for in_review transition", async () => {
    const result = await assertReviewerVerificationBlock({
      actorType: "agent",
      agentRole: "qa",
      currentStatus: "in_progress",
      nextStatus: "in_review",
      verification: validVerification,
    });
    expect(result).toBeDefined();
    expect(result!.prDiffLinesReviewed).toBe(50);
  });

  it("throws when qa agent omits verification for in_review transition", async () => {
    await expect(
      assertReviewerVerificationBlock({
        actorType: "agent",
        agentRole: "qa",
        currentStatus: "in_progress",
        nextStatus: "in_review",
        verification: undefined,
      }),
    ).rejects.toThrow();
  });

  it("throws when qa agent provides null verification for done transition", async () => {
    await expect(
      assertReviewerVerificationBlock({
        actorType: "agent",
        agentRole: "qa",
        currentStatus: "in_review",
        nextStatus: "done",
        verification: null,
      }),
    ).rejects.toThrow();
  });

  it("throws when qa agent provides empty verification block", async () => {
    const emptyVerification = {
      prDiffLinesReviewed: 0,
      acCommandsRun: [],
      ciState: "not_applicable",
      filesystemChecks: [],
    };
    await expect(
      assertReviewerVerificationBlock({
        actorType: "agent",
        agentRole: "qa",
        currentStatus: "in_review",
        nextStatus: "done",
        verification: emptyVerification,
      }),
    ).rejects.toThrow();
  });

  it("returns parsed block for qa agent providing valid verification for done transition", async () => {
    const result = await assertReviewerVerificationBlock({
      actorType: "agent",
      agentRole: "qa",
      currentStatus: "in_review",
      nextStatus: "done",
      verification: validVerification,
    });
    expect(result).toBeDefined();
    expect(result!.ciState).toBe("green");
  });
});