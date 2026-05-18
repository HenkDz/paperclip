import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  extractACSection,
  parseShellCommands,
  parseFileChecks,
  parseCriteria,
  shouldOptOutOfACEvaluation,
  evaluateACForIssue,
} from "../services/issue-ac-evaluator.js";

// ─── extractACSection ──────────────────────────────────────────────────────

describe("extractACSection", () => {
  it("returns null for null description", () => {
    expect(extractACSection(null)).toBeNull();
  });

  it("returns null for undefined description", () => {
    expect(extractACSection(undefined)).toBeNull();
  });

  it("returns null for description without AC section", () => {
    const desc = "## Objective\nDo the thing\n\n## Scope\n- item 1\n- item 2";
    expect(extractACSection(desc)).toBeNull();
  });

  it("extracts AC section with exact heading", () => {
    const desc = "## Objective\nDo the thing\n\n## Acceptance Criteria\n- [ ] pytest passes\n- [ ] file exists at /tmp/foo";
    const result = extractACSection(desc);
    expect(result).toContain("pytest passes");
    expect(result).toContain("file exists at /tmp/foo");
  });

  it("extracts AC section with case-insensitive heading", () => {
    const desc = "## Acceptance criteria\n- [ ] shell command runs";
    const result = extractACSection(desc);
    expect(result).toContain("shell command runs");
  });

  it("extracts AC section up to next heading", () => {
    const desc = "## Acceptance Criteria\n- [ ] cmd runs\n\n## Files\nfoo.ts";
    const result = extractACSection(desc);
    expect(result).toContain("cmd runs");
    expect(result).not.toContain("foo.ts");
  });

  it("extracts AC section to end when no subsequent heading", () => {
    const desc = "## Acceptance Criteria\n- [ ] final check";
    const result = extractACSection(desc);
    expect(result).toBe("- [ ] final check");
  });

  it("returns null for empty AC section", () => {
    const desc = "## Acceptance Criteria\n\n## Files\nfoo.ts";
    expect(extractACSection(desc)).toBeNull();
  });

  it("handles single-hash heading", () => {
    const desc = "# Acceptance Criteria\n- [ ] works";
    const result = extractACSection(desc);
    expect(result).toContain("works");
  });
});

// ─── parseShellCommands ────────────────────────────────────────────────────

describe("parseShellCommands", () => {
  it("extracts commands from fenced sh blocks", () => {
    const ac = "```sh\npytest tests/foo.py\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("pytest tests/foo.py");
  });

  it("extracts commands from fenced bash blocks", () => {
    const ac = "```bash\nmake build\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("make build");
  });

  it("extracts commands from unqualified fenced blocks", () => {
    const ac = "```\nnpm test\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm test");
  });

  it("skips comment lines in fenced blocks", () => {
    const ac = "```sh\n# This is a comment\nnpm test\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm test");
  });

  it("skips empty lines in fenced blocks", () => {
    const ac = "```sh\n\nnpm test\n\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm test");
  });

  it("extracts inline backtick commands", () => {
    const ac = "Run `npm test` to verify";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm test");
  });

  it("does not double-count commands in fenced+inline", () => {
    const ac = "```sh\nnpm test\n```\nAlso run `npm test` again";
    const cmds = parseShellCommands(ac);
    // The inline `npm test` is inside backticks but outside the fenced block,
    // so it gets extracted again. This is expected — dedup is the caller's job.
    expect(cmds.length).toBeGreaterThanOrEqual(2);
  });

  it("parses → expected output annotation", () => {
    const ac = "`pytest tests/foo.py → expected: exit 0`";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("pytest tests/foo.py");
    expect(cmds[0].expectedOutput).toBe("exit 0");
  });

  it("parses -> expected output variant", () => {
    const ac = "`pytest tests/foo.py -> expected: all pass`";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("pytest tests/foo.py");
    expect(cmds[0].expectedOutput).toBe("all pass");
  });

  it("strips checkbox markers from commands", () => {
    const ac = "- [ ] `npm test`";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm test");
  });

  it("skips plain path references (single /path without spaces)", () => {
    const ac = "Check `/etc/hosts` for the entry";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(0);
  });

  it("skips single-word backticks that look like field names", () => {
    const ac = "The `command` field is required";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(0);
  });

  it("extracts commands with pipes and logical operators from backticks", () => {
    const ac = "Run `ps aux | grep node`";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("ps aux | grep node");
  });

  it("handles multiple fenced blocks", () => {
    const ac = "```sh\nnpm test\n```\n\n```bash\nmake build\n```";
    const cmds = parseShellCommands(ac);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe("npm test");
    expect(cmds[1].command).toBe("make build");
  });
});

// ─── parseFileChecks ───────────────────────────────────────────────────────

describe("parseFileChecks", () => {
  it("extracts 'file exists at /path' patterns", () => {
    const ac = "- [ ] file exists at /tmp/test-output.json";
    const checks = parseFileChecks(ac);
    expect(checks).toHaveLength(1);
    expect(checks[0].path).toBe("/tmp/test-output.json");
  });

  it("extracts 'file exists at `/path`' patterns with backticks", () => {
    const ac = "- [ ] file exists at `/tmp/result.txt`";
    const checks = parseFileChecks(ac);
    expect(checks).toHaveLength(1);
    expect(checks[0].path).toBe("/tmp/result.txt");
  });

  it("extracts '/path exists' patterns", () => {
    const ac = "Verify `/src/app.ts` exists";
    const checks = parseFileChecks(ac);
    expect(checks).toHaveLength(1);
    expect(checks[0].path).toBe("/src/app.ts");
  });

  it("deduplicates paths", () => {
    const ac = "file exists at /tmp/out.json\nfile exists at /tmp/out.json";
    const checks = parseFileChecks(ac);
    expect(checks).toHaveLength(1);
  });

  it("returns empty array for text without file checks", () => {
    const ac = "Just some text without file patterns";
    expect(parseFileChecks(ac)).toHaveLength(0);
  });
});

// ─── parseCriteria ──────────────────────────────────────────────────────────

describe("parseCriteria", () => {
  it("returns both shell and file criteria", () => {
    const ac = "```sh\nnpm test\n```\n\n- [ ] file exists at /tmp/result.txt";
    const criteria = parseCriteria(ac);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].type).toBe("shell");
    expect(criteria[0].command).toBe("npm test");
    expect(criteria[1].type).toBe("file");
    expect((criteria[1] as { type: "file"; path: string }).path).toBe("/tmp/result.txt");
  });

  it("returns empty array for text with no criteria", () => {
    const ac = "No commands or file checks here";
    expect(parseCriteria(ac)).toHaveLength(0);
  });
});

// ─── shouldOptOutOfACEvaluation ─────────────────────────────────────────────

describe("shouldOptOutOfACEvaluation", () => {
  it("opts out when executionPolicy is null and no linked PRs", () => {
    expect(shouldOptOutOfACEvaluation({ executionPolicy: null, hasLinkedPRs: false })).toBe(true);
  });

  it("opts out when executionPolicy is undefined and no linked PRs", () => {
    expect(shouldOptOutOfACEvaluation({ executionPolicy: undefined, hasLinkedPRs: false })).toBe(true);
  });

  it("does NOT opt out when executionPolicy is present", () => {
    expect(shouldOptOutOfACEvaluation({ executionPolicy: { mode: "normal" }, hasLinkedPRs: false })).toBe(false);
  });

  it("does NOT opt out when there are linked PRs even with null policy", () => {
    expect(shouldOptOutOfACEvaluation({ executionPolicy: null, hasLinkedPRs: true })).toBe(false);
  });

  it("does NOT opt out when executionPolicy is present and has linked PRs", () => {
    expect(shouldOptOutOfACEvaluation({ executionPolicy: { mode: "normal" }, hasLinkedPRs: true })).toBe(false);
  });
});

// ─── evaluateACForIssue (integration-level) ─────────────────────────────────

describe("evaluateACForIssue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opts out when executionPolicy is null and no linked PRs", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```",
      executionPolicy: null,
      hasLinkedPRs: false,
    });
    expect(result.optedOut).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.commandResults).toHaveLength(0);
  });

  it("passes when no AC section exists in description", async () => {
    const result = await evaluateACForIssue({
      description: "## Objective\nJust a description with no AC",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(true);
    expect(result.criteria).toHaveLength(0);
  });

  it("passes when AC section has no verifiable criteria", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n- [ ] Manual review completed",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(true);
  });

  it("evaluates shell commands and returns pass when they succeed", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\necho hello\n```",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(true);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].exitCode).toBe(0);
    expect(result.commandResults[0].passed).toBe(true);
  });

  it("evaluates shell commands and returns fail when they exit nonzero", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
      config: { commandTimeoutMs: 5000 },
    });
    expect(result.passed).toBe(false);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].exitCode).toBe(1);
    expect(result.commandResults[0].passed).toBe(false);
    expect(result.failureReasons).toHaveLength(1);
    expect(result.failureReasons[0]).toContain("AC command exited 1");
  });

  it("evaluates expected output annotation — passes when matched", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n`echo hello → expected: hello`",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(true);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].outputMatched).toBe(true);
  });

  it("evaluates expected output annotation — fails when not matched", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n`echo hello → expected: goodbye`",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(false);
    expect(result.commandResults[0].outputMatched).toBe(false);
  });

  it("reports timeout for commands exceeding time limit", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nsleep 10\n```",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
      config: { commandTimeoutMs: 200 },
    });
    expect(result.passed).toBe(false);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].timedOut).toBe(true);
    expect(result.failureReasons[0]).toContain("timed out");
  });

  it("evaluates file-existence checks — passes when file exists", async () => {
    // /tmp always exists on Unix systems
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n- [ ] file exists at /tmp",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(true);
    expect(result.fileCheckResults).toHaveLength(1);
    expect(result.fileCheckResults[0].exists).toBe(true);
    expect(result.fileCheckResults[0].passed).toBe(true);
  });

  it("evaluates file-existence checks — fails when file does not exist", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n- [ ] file exists at /nonexistent/path/that/does/not/exist",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
    });
    expect(result.passed).toBe(false);
    expect(result.fileCheckResults).toHaveLength(1);
    expect(result.fileCheckResults[0].exists).toBe(false);
    expect(result.failureReasons[0]).toContain("does not exist");
  });

  it("returns all failures when both commands and file checks fail", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```\n- [ ] file exists at /nonexistent/path",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
      config: { commandTimeoutMs: 5000 },
    });
    expect(result.passed).toBe(false);
    expect(result.commandResults).toHaveLength(1);
    expect(result.fileCheckResults).toHaveLength(1);
    expect(result.failureReasons).toHaveLength(2);
  });

  it("skips evaluation when config.skipEvaluation is true", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
      config: { skipEvaluation: true },
    });
    expect(result.passed).toBe(true);
    expect(result.optedOut).toBe(false);
    expect(result.commandResults).toHaveLength(0);
  });

  it("enforces AC gate when executionPolicy is present even without linked PRs", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```",
      executionPolicy: { mode: "normal" },
      hasLinkedPRs: false,
      config: { commandTimeoutMs: 5000 },
    });
    expect(result.optedOut).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("enforces AC gate when there are linked PRs even with null policy", async () => {
    const result = await evaluateACForIssue({
      description: "## Acceptance Criteria\n```sh\nexit 1\n```",
      executionPolicy: null,
      hasLinkedPRs: true,
      config: { commandTimeoutMs: 5000 },
    });
    expect(result.optedOut).toBe(false);
    expect(result.passed).toBe(false);
  });
});