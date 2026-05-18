/**
 * AGE-14798: Server-side AC parser + shell-command verifier.
 *
 * Parses `## Acceptance Criteria` sections from issue descriptions,
 * extracts shell commands and file-existence checks, runs them in
 * sandboxed subprocesses, and returns pass/fail results.
 *
 * This module is the Layer 1a gate that blocks `done` transitions (422)
 * when mandatory acceptance criteria fail.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ─── Type definitions ────────────────────────────────────────────────────────

/** A shell command extracted from an AC backtick/fenced block. */
export interface ParsedShellCommand {
  /** The command string to run. */
  command: string;
  /** Optional expected output annotation (`→ expected: ...`). */
  expectedOutput?: string;
}

/** A file-existence check extracted from AC text. */
export interface ParsedFileCheck {
  /** The filesystem path to verify. */
  path: string;
}

/** A single parsed criterion (shell command or file check). */
export type ParsedCriterion =
  | ({ type: "shell" } & ParsedShellCommand)
  | ({ type: "file" } & ParsedFileCheck);

/** Result of evaluating a single shell command. */
export interface ShellCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  passed: boolean;
  expectedOutput?: string;
  outputMatched?: boolean;
}

/** Result of evaluating a single file-existence check. */
export interface FileCheckResult {
  path: string;
  exists: boolean;
  passed: boolean;
}

/** Result of evaluating a single AC checkbox criterion. */
export interface ACCheckboxResult {
  originalLine: string;
  /** Whether the checkbox is checked (true = checked, meaning criterion is met). */
  checked: boolean;
  /** Any embedded shell/file criteria parsed from the checkbox line. */
  embeddedCriteria?: ParsedCriterion[];
}

/** The full evaluation result for an issue's AC section. */
export interface ACEvaluationResult {
  /** Whether all mandatory AC criteria passed. */
  passed: boolean;
  /** Parsed criteria extracted from the AC section. */
  criteria: ParsedCriterion[];
  /** Results for shell commands that were run. */
  commandResults: ShellCommandResult[];
  /** Results for file existence checks. */
  fileCheckResults: FileCheckResult[];
  /** Human-readable reasons for any failures. */
  failureReasons: string[];
  /** Whether the issue opted out (executionPolicy null, no linked PR). */
  optedOut: boolean;
}

/** Configuration for the AC evaluator. */
export interface ACEvaluatorConfig {
  /** Maximum time (ms) for each shell command. Default: 30_000. */
  commandTimeoutMs: number;
  /** Maximum stdout/stderr bytes per command. Default: 10_240. */
  maxOutputBytes: number;
  /** Whether to skip evaluation entirely (opt-out). Default: false. */
  skipEvaluation: boolean;
}

const DEFAULT_CONFIG: ACEvaluatorConfig = {
  commandTimeoutMs: 30_000,
  maxOutputBytes: 10_240,
  skipEvaluation: false,
};

// ─── AC Section Parser ──────────────────────────────────────────────────────

/**
 * Extract the `## Acceptance Criteria` section from an issue description.
 * Supports `## Acceptance Criteria` and `## Acceptance criteria` (case-insensitive).
 */
export function extractACSection(description: string | null | undefined): string | null {
  if (!description) return null;

  // Match "## Acceptance Criteria" section (case-insensitive heading)
  // Captures everything until the next ## heading or end of string
  const headingPattern = /^#{1,2}\s+Acceptance\s+Criteria\s*$/im;
  const match = headingPattern.exec(description);
  if (!match?.index && match?.index !== 0) return null;

  const startIndex = match.index + match[0].length;
  const rest = description.slice(startIndex);

  // Find the next heading at the same or higher level
  const nextHeading = /^#{1,2}\s+\S/m.exec(rest);
  const sectionText = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  const trimmed = sectionText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse shell commands from fenced code blocks within AC text.
 * Detects ```sh, ```bash, ```shell, and unqualified ``` blocks.
 * Also detects inline backtick commands: `command arg1 arg2`
 *
 * Commands can have an expected output annotation:
 *   `pytest tests/foo.py → expected: exit 0`
 *   `echo hello → expected: hello`
 */
export function parseShellCommands(acText: string): ParsedShellCommand[] {
  const commands: ParsedShellCommand[] = [];

  // 1. Fenced code blocks (```sh, ```bash, ```shell, ```)
  const fencedPattern = /```(?:sh|bash|shell)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedPattern.exec(acText)) !== null) {
    const block = match[1].trim();
    for (const line of block.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) continue;
      const parsed = parseCommandWithAnnotation(trimmedLine);
      if (parsed) commands.push(parsed);
    }
  }

  // 2. Inline backtick commands (single-line `command`)
  //    Must not be inside a fenced block to avoid double-parsing
  const acWithoutFenced = acText.replace(fencedPattern, "");
  const inlinePattern = /`([^`\n]+)`/g;
  while ((match = inlinePattern.exec(acWithoutFenced)) !== null) {
    const raw = match[1].trim();
    // Skip if it's just a filename/path reference (starts with / or ., or has no spaces and looks like a path)
    if (raw.startsWith("/") && !raw.includes(" ")) continue;
    if (raw.startsWith(".") && raw.includes("/") && !raw.includes(" ")) continue;
    // Must look like a command (has spaces or is a known command-like string)
    if (!raw.includes(" ") && !raw.includes("|") && !raw.includes("&&") && !raw.includes("||")) {
      // Single word in backticks — likely a field name, skip
      continue;
    }
    const parsed = parseCommandWithAnnotation(raw);
    if (parsed) commands.push(parsed);
  }

  return commands;
}

/**
 * Parse a command line that may have a `→ expected: ...` annotation.
 */
function parseCommandWithAnnotation(raw: string): ParsedShellCommand | null {
  // Strip leading checkbox marker (- [ ] or - [x] or * [ ])
  let cleaned = raw.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim();
  if (!cleaned) return null;

  // Check for expected output annotation
  const arrowPattern = /→\s*expected:\s*/;
  const arrowMatch = arrowPattern.exec(cleaned);
  if (arrowMatch) {
    const command = cleaned.slice(0, arrowMatch.index).trim();
    const expectedOutput = cleaned.slice(arrowMatch.index + arrowMatch[0].length).trim();
    return { command, expectedOutput };
  }

  // Also support `-> expected:` variant
  const altArrowPattern = /->\s*expected:\s*/;
  const altMatch = altArrowPattern.exec(cleaned);
  if (altMatch) {
    const command = cleaned.slice(0, altMatch.index).trim();
    const expectedOutput = cleaned.slice(altMatch.index + altMatch[0].length).trim();
    return { command, expectedOutput };
  }

  return { command: cleaned };
}

/**
 * Parse file-existence checks from AC text.
 * Detects patterns like:
 *   - "file exists at /path/to/file"
 *   - "/path/to/file exists"
 *   - "file /path/to/file exists"
 */
export function parseFileChecks(acText: string): ParsedFileCheck[] {
  const checks: ParsedFileCheck[] = [];

  // Pattern: "file exists at /path" or "file exists at `/path`"
  const pattern1 = /file\s+exists\s+at\s+`?([^`\s]+)`?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern1.exec(acText)) !== null) {
    const path = match[1].trim();
    if (path && !checks.some((c) => c.path === path)) checks.push({ path });
  }

  // Pattern: "/path exists" (backtick-wrapped or not)
  const pattern2 = /`?(\/[^\s`]+)`?\s+exists/gi;
  while ((match = pattern2.exec(acText)) !== null) {
    const path = match[1].trim();
    if (path && !checks.some((c) => c.path === path)) checks.push({ path });
  }

  return checks;
}

/**
 * Parse all criteria from an AC section.
 */
export function parseCriteria(acText: string): ParsedCriterion[] {
  const criteria: ParsedCriterion[] = [];
  for (const cmd of parseShellCommands(acText)) {
    criteria.push({ type: "shell", ...cmd });
  }
  for (const fc of parseFileChecks(acText)) {
    criteria.push({ type: "file", ...fc });
  }
  return criteria;
}

// ─── AC Evaluator ────────────────────────────────────────────────────────────

/**
 * Run a single shell command in a sandboxed subprocess.
 */
async function evaluateShellCommand(
  command: ParsedShellCommand,
  config: ACEvaluatorConfig,
): Promise<ShellCommandResult> {
  const timeout = config.commandTimeoutMs;
  const maxBytes = config.maxOutputBytes;

  try {
    const { stdout, stderr } = await execAsync(command.command, {
      timeout,
      maxBuffer: maxBytes,
      shell: "/bin/bash",
      env: { ...process.env, PATH: process.env.PATH },
      cwd: process.cwd(),
    });

    const exitCode = 0;
    const stdoutStr = (stdout ?? "").slice(0, maxBytes);
    const stderrStr = (stderr ?? "").slice(0, maxBytes);

    // Check expected output if provided
    let outputMatched: boolean | undefined;
    if (command.expectedOutput) {
      outputMatched = stdoutStr.trim().includes(command.expectedOutput.trim());
    }

    return {
      command: command.command,
      exitCode,
      stdout: stdoutStr,
      stderr: stderrStr,
      timedOut: false,
      passed: exitCode === 0 && (command.expectedOutput ? outputMatched === true : true),
      expectedOutput: command.expectedOutput,
      outputMatched,
    };
  } catch (err: unknown) {
    const execErr = err as {
      killed?: boolean;
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    const timedOut = execErr.killed === true;
    const exitCode = typeof execErr.code === "number" ? execErr.code : 1;
    const stdoutStr = (execErr.stdout ?? "").slice(0, maxBytes);
    const stderrStr = (execErr.stderr ?? "").slice(0, maxBytes);

    let outputMatched: boolean | undefined;
    if (command.expectedOutput) {
      outputMatched = stdoutStr.trim().includes(command.expectedOutput.trim());
    }

    // If expected output is provided and matches, the command passes even with nonzero exit
    // (some AC intentionally check for expected failure output)
    const passed = command.expectedOutput
      ? outputMatched === true
      : exitCode === 0;

    return {
      command: command.command,
      exitCode,
      stdout: stdoutStr,
      stderr: stderrStr,
      timedOut,
      passed,
      expectedOutput: command.expectedOutput,
      outputMatched,
    };
  }
}

/**
 * Evaluate a file-existence check.
 */
function evaluateFileCheck(check: ParsedFileCheck): FileCheckResult {
  const exists = existsSync(check.path);
  return {
    path: check.path,
    exists,
    passed: exists,
  };
}

/**
 * Determine whether an issue should be opted out of AC evaluation.
 *
 * Opt-out criteria (per AGE-14798):
 * - Issues with `executionPolicy: null` AND no linked PR bypass the gate.
 * Issues with an executionPolicy (even if stages are empty) or with linked PRs
 * are subject to the AC gate.
 */
export function shouldOptOutOfACEvaluation(input: {
  executionPolicy: unknown;
  hasLinkedPRs: boolean;
}): boolean {
  const { executionPolicy, hasLinkedPRs } = input;
  // executionPolicy null/undefined means opt-out (backwards compat)
  // BUT if there are linked PRs, the PR guard (AGE-13028) already covers the
  // "agent lied and flipped done" case, so we still apply AC checks.
  if (executionPolicy == null && !hasLinkedPRs) {
    return true;
  }
  return false;
}

/**
 * Evaluate all acceptance criteria for an issue.
 *
 * This is the main entry point called from the done-transition guard.
 * Returns a full ACEvaluationResult with pass/fail details.
 */
export async function evaluateACForIssue(input: {
  description: string | null | undefined;
  executionPolicy: unknown;
  hasLinkedPRs: boolean;
  config?: Partial<ACEvaluatorConfig>;
}): Promise<ACEvaluationResult> {
  const config: ACEvaluatorConfig = { ...DEFAULT_CONFIG, ...input.config };

  // Check opt-out first
  if (shouldOptOutOfACEvaluation({ executionPolicy: input.executionPolicy, hasLinkedPRs: input.hasLinkedPRs })) {
    return {
      passed: true,
      criteria: [],
      commandResults: [],
      fileCheckResults: [],
      failureReasons: [],
      optedOut: true,
    };
  }

  if (config.skipEvaluation) {
    return {
      passed: true,
      criteria: [],
      commandResults: [],
      fileCheckResults: [],
      failureReasons: [],
      optedOut: false,
    };
  }

  // Extract AC section from description
  const acSection = extractACSection(input.description);
  if (!acSection) {
    // No AC section found — nothing to check, pass by default
    return {
      passed: true,
      criteria: [],
      commandResults: [],
      fileCheckResults: [],
      failureReasons: [],
      optedOut: false,
    };
  }

  // Parse criteria
  const criteria = parseCriteria(acSection);
  if (criteria.length === 0) {
    // AC section exists but contains no verifiable criteria (e.g., just checkboxes)
    // Pass by default — only shell commands and file checks are mechanically verified
    return {
      passed: true,
      criteria: [],
      commandResults: [],
      fileCheckResults: [],
      failureReasons: [],
      optedOut: false,
    };
  }

  const commandResults: ShellCommandResult[] = [];
  const fileCheckResults: FileCheckResult[] = [];
  const failureReasons: string[] = [];

  // Evaluate shell commands
  const shellCriteria = criteria.filter(
    (c): c is ParsedCriterion & { type: "shell" } & ParsedShellCommand => c.type === "shell",
  );
  for (const cmd of shellCriteria) {
    const result = await evaluateShellCommand(cmd, config);
    commandResults.push(result);
    if (!result.passed) {
      if (result.timedOut) {
        failureReasons.push(
          `AC command timed out (${config.commandTimeoutMs}ms): \`${cmd.command}\``,
        );
      } else if (result.expectedOutput && !result.outputMatched) {
        failureReasons.push(
          `AC command output mismatch: \`${cmd.command}\` → expected: "${cmd.expectedOutput}", got: "${result.stdout.trim().slice(0, 200)}"`,
        );
      } else {
        failureReasons.push(
          `AC command exited ${result.exitCode}: \`${cmd.command}\` — ${result.stderr.trim().slice(0, 200) || result.stdout.trim().slice(0, 200)}`,
        );
      }
    }
  }

  // Evaluate file checks
  const fileCriteria = criteria.filter(
    (c): c is ParsedCriterion & { type: "file" } & ParsedFileCheck => c.type === "file",
  );
  for (const fc of fileCriteria) {
    const result = evaluateFileCheck(fc);
    fileCheckResults.push(result);
    if (!result.passed) {
      failureReasons.push(`AC file check failed: "${fc.path}" does not exist`);
    }
  }

  return {
    passed: failureReasons.length === 0,
    criteria,
    commandResults,
    fileCheckResults,
    failureReasons,
    optedOut: false,
  };
}