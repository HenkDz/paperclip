/**
 * AGE-14800: Route-level integration tests for reviewer verification block enforcement.
 *
 * Tests that PATCH /api/issues/:id correctly:
 * - Rejects QA agents transitioning to in_review/done without verification (HTTP 422)
 * - Allows non-QA agents to transition without verification
 * - Allows QA agents with valid verification to transition
 * - Returns the verification block in activity log details
 *
 * NOTE: The PATCH handler runs assertAgentInReviewReviewPath before the verification
 * block guard. For in_review transitions, the disposition check requires a review path
 * (pending interaction, human assignee, approval, execution participant, or monitor).
 * We satisfy this by having a pending issue thread interaction in the mock for in_review tests.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(async (_id: string, _updates: Record<string, unknown>, _actor: unknown) => ({
    id: _id,
    companyId: "company-1",
    status: _updates.status ?? "in_review",
    assigneeAgentId: _updates.assigneeAgentId ?? null,
    assigneeUserId: null,
    identifier: "PAP-2001",
    title: "Test issue",
    description: "",
    priority: "medium",
    labels: [],
    createdByUserId: "local-board",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

// QA agent returned by agentService.getById
const qaAgent = {
  id: "qa-agent-1",
  companyId: "company-1",
  role: "qa",
  name: "Quinn QA",
};

// General agent returned by agentService getById override
const generalAgent = {
  id: "general-agent-1",
  companyId: "company-1",
  role: "general",
  name: "Axel General",
};

// Mock verification functions.
// assertReviewerVerificationBlock: replays the real verification logic inline so the
// route-level integration tests exercise the actual guard wiring. A full mock would
// only prove that the mock works, not that the route calls the right function.
// evaluateACForIssue: stubbed to always pass since these tests focus on verification,
// not AC evaluation.
const mockAssertReviewerVerificationBlock = vi.hoisted(() =>
  vi.fn(async (input: {
    actorType: string;
    agentRole: string | null | undefined;
    currentStatus: string;
    nextStatus: string;
    verification: unknown;
  }) => {
    const { actorType, agentRole, currentStatus, nextStatus, verification } = input;
    // Only applies to agent actors
    if (actorType !== "agent") return undefined;
    // Only QA/reviewer roles are gated
    if (!agentRole || agentRole !== "qa") return undefined;
    // Only in_review/done transitions that actually change status
    if (currentStatus === nextStatus) return undefined;
    if (nextStatus !== "in_review" && nextStatus !== "done") return undefined;
    // Verification required but missing
    if (verification === undefined || verification === null) {
      const { unprocessable } = await import("../errors.js");
      throw unprocessable(
        "Reviewer agents must include a verification block when transitioning to in_review or done",
        { code: "VERIFICATION_BLOCK_REQUIRED", requiredForStatuses: ["in_review", "done"], agentRole },
      );
    }
    // Validate the block structurally (simplified)
    const block = verification as Record<string, unknown>;
    const hasCommands = Array.isArray(block.acCommandsRun) && block.acCommandsRun.length > 0;
    const hasFsChecks = Array.isArray(block.filesystemChecks) && block.filesystemChecks.length > 0;
    const hasDiffReview = typeof block.prDiffLinesReviewed === "number" && block.prDiffLinesReviewed > 0;
    if (!hasCommands && !hasFsChecks && !hasDiffReview) {
      const { unprocessable } = await import("../errors.js");
      throw unprocessable(
        "Verification block must include at least one of: AC commands, filesystem checks, or diff lines reviewed",
        { code: "VERIFICATION_BLOCK_EMPTY", hint: "Include prDiffLinesReviewed > 0, or at least one acCommandsRun entry, or at least one filesystemChecks entry" },
      );
    }
    return verification;
  }),
);

const mockEvaluateACForIssue = vi.hoisted(() =>
  vi.fn(async () => ({
    passed: true,
    optedOut: false,
    commandResults: [],
    fileCheckResults: [],
    failureReasons: [],
  })),
);

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => {
    return {
      companyService: () => ({
        getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
      }),
      accessService: () => mockAccessService,
      agentService: () => ({
        getById: vi.fn(async (id: string) => {
          if (id === "qa-agent-1") return qaAgent;
          if (id === "general-agent-1") return generalAgent;
          return null;
        }),
      }),
      companySearchService: () => ({}),
      documentService: () => ({}),
      executionWorkspaceService: () => ({}),
      feedbackService: () => ({
        listIssueVotesForUser: vi.fn(async () => []),
        saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabledNow: false })),
      }),
      goalService: () => ({}),
      heartbeatService: () => mockHeartbeatService,
      environmentService: () => ({
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
      }),
      instanceSettingsService: () => ({
        get: vi.fn(async () => ({
          id: "instance-settings-1",
          general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
        })),
        listCompanyIds: vi.fn(async () => ["company-1"]),
      }),
      issueApprovalService: () => mockIssueApprovalService,
      issueReferenceService: () => ({
        deleteDocumentSource: async () => undefined,
        diffIssueReferenceSummary: () => ({
          addedReferencedIssues: [],
          removedReferencedIssues: [],
          currentReferencedIssues: [],
        }),
        emptySummary: () => ({ outbound: [], inbound: [] }),
        listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
        syncComment: async () => undefined,
        syncDocument: async () => undefined,
        syncIssue: async () => undefined,
      }),
      issueRecoveryActionService: () => ({
        getActiveForIssue: vi.fn(async () => null),
        listActiveForIssues: vi.fn(async () => new Map()),
      }),
      issueService: () => mockIssueService,
      issueThreadInteractionService: () => mockIssueThreadInteractionService,
      issueTreeControlService: () => ({
        computeTreeControl: vi.fn(async () => ({ blocked: false, shouldConstrain: false })),
      }),
      logActivity: mockLogActivity,
      projectService: () => ({}),
      routineService: () => ({
        syncRunStatusForIssue: vi.fn(async () => undefined),
      }),
      workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
      ISSUE_LIST_DEFAULT_LIMIT: 50,
      ISSUE_LIST_MAX_LIMIT: 100,
      clampIssueListLimit: (limit: number) => Math.min(Math.max(1, limit), 100),
      isVerificationRequired: vi.fn((input: { agentRole: string | null | undefined; currentStatus: string; nextStatus: string }) => {
        const { agentRole, currentStatus, nextStatus } = input;
        if (!agentRole || agentRole !== "qa") return false;
        if (currentStatus === nextStatus) return false;
        return nextStatus === "in_review" || nextStatus === "done";
      }),
      validateVerificationBlock: vi.fn(),
      assertReviewerVerificationBlock: mockAssertReviewerVerificationBlock,
      evaluateACForIssue: mockEvaluateACForIssue,
    };
  });
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const baseIssue = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "company-1",
  status: "in_progress",
  assigneeAgentId: "qa-agent-1",
  assigneeUserId: null,
  createdByUserId: "local-board",
  identifier: "PAP-2001",
  title: "Test issue",
  description: "",
  priority: "medium",
  labels: [],
  executionPolicy: null,
  executionState: null,
};

const validVerification = {
  prDiffLinesReviewed: 42,
  acCommandsRun: [
    { command: "npm test", exitCode: 0, outputSnippet: "3 tests passed" },
  ],
  ciState: "green",
  filesystemChecks: [{ path: "/src/app.ts", exists: true }],
};

describe("Reviewer verification block route guard (AGE-14800)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  // --- in_review tests ---
  // For agent-authored in_review transitions, the disposition check requires a review path.
  // We satisfy this by returning a pending thread interaction from the mock.

  it("rejects QA agent transitioning to in_review without verification (HTTP 422)", async () => {
    // Satisfy disposition check: provide a pending interaction so in_review is allowed
    mockIssueService.getById.mockResolvedValue({ ...baseIssue });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/verification/i);
  });

  it("rejects QA agent transitioning to done without verification (HTTP 422)", async () => {
    // done transitions don't need a disposition check, but we still need issue to exist
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      status: "in_review",
    });

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/verification/i);
  });

  it("rejects QA agent with empty verification block (HTTP 422)", async () => {
    // Satisfy disposition check for in_review
    mockIssueService.getById.mockResolvedValue({ ...baseIssue });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);

    const emptyVerification = {
      prDiffLinesReviewed: 0,
      acCommandsRun: [],
      ciState: "not_applicable",
      filesystemChecks: [],
    };

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", verification: emptyVerification });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/verification/i);
  });

  it("allows QA agent transitioning to in_review WITH valid verification (HTTP 200)", async () => {
    // Satisfy disposition check for in_review
    mockIssueService.getById.mockResolvedValue({ ...baseIssue });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", verification: validVerification });

    // Should NOT be 422 — the verification block is valid
    expect(res.status).not.toBe(422);
  });

  it("allows QA agent transitioning to done WITH valid verification (HTTP 200)", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      status: "in_review",
    });

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", verification: validVerification });

    expect(res.status).not.toBe(422);
  });

  it("allows general agent transitioning to in_review without verification", async () => {
    // Satisfy disposition check for in_review: provide pending interaction
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      assigneeAgentId: "general-agent-1",
    });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "general-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).not.toBe(422);
  });

  it("allows board user transitioning to in_review without verification", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue });

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).not.toBe(422);
  });

  it("allows QA agent to transition to blocked without verification (not a review status)", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      status: "in_progress",
    });

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "blocked" });

    // blocked is NOT in_review/done, so no verification required
    expect(res.status).not.toBe(422);
  });

  it("does not require verification when status stays the same (no transition)", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      status: "in_review",
    });

    // QA agent sends PATCH with status: in_review but it's already in_review
    const res = await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    // No transition → no verification required
    expect(res.status).not.toBe(422);
  });

  it("includes verification block in activity log when QA agent provides valid verification", async () => {
    // Satisfy disposition check for in_review
    mockIssueService.getById.mockResolvedValue({ ...baseIssue });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);

    await request(
      await createApp({
        type: "agent",
        agentId: "qa-agent-1",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", verification: validVerification });

    // The mockLogActivity should have been called with verification block details
    // logActivity(db, input) — second arg is the input object with details
    expect(mockLogActivity).toHaveBeenCalled();
    const calls = mockLogActivity.mock.calls;
    const logCallWithVerification = calls.find(
      (call: any[]) => call.length > 1 && call[1]?.details?.verificationBlock,
    );
    expect(logCallWithVerification).toBeDefined();
    expect(logCallWithVerification![1].details.verificationBlock).toMatchObject({
      prDiffLinesReviewed: 42,
      ciState: "green",
    });
  });
});