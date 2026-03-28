import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseDroidOutput, isDroidAuthRequiredError } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function resolveEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "droid").trim();
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "droid_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "droid_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    const resolved = resolveEnvValue(value);
    if (resolved !== null) env[key] = resolved;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "droid_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "droid_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  if (
    (typeof env.FACTORY_API_KEY === "string" && env.FACTORY_API_KEY.trim().length > 0) ||
    (typeof process.env.FACTORY_API_KEY === "string" && process.env.FACTORY_API_KEY.trim().length > 0)
  ) {
    checks.push({
      code: "droid_factory_api_key_present",
      level: "info",
      message: "FACTORY_API_KEY is set for Droid authentication.",
    });
  } else {
    checks.push({
      code: "droid_factory_api_key_missing",
      level: "warn",
      message: "FACTORY_API_KEY is not set. Droid runs may fail until authentication is configured.",
      hint: "Set FACTORY_API_KEY in adapter env or shell environment, then retry the probe.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "droid_cwd_invalid" && check.code !== "droid_command_unresolvable");

  if (canRunProbe) {
    const model = asString(config.model, "").trim();
    const effort = asString(config.effort, asString(config.reasoningEffort, "")).trim();
    const args = ["exec"];
    if (model) args.push("--model", model);
    if (effort) args.push("--reasoning-effort", effort);
    args.push("--cwd", cwd, "--output-format", "json");

    const probe = await runChildProcess(
      `droid-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      args,
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 45,
        graceSec: 5,
        stdin: "Respond with hello.",
        onLog: async () => {},
      },
    );
    const parsed = parseDroidOutput(probe.stdout);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
    const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

    if (probe.timedOut) {
      checks.push({
        code: "droid_hello_probe_timed_out",
        level: "warn",
        message: "Droid hello probe timed out.",
        hint: "Retry the probe. If this persists, run `droid exec --output-format json` manually in this working directory.",
      });
    } else if ((probe.exitCode ?? 1) === 0 && !parsed.isError) {
      const summary = (parsed.finalText ?? parsed.lastAssistantText ?? "").trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "droid_hello_probe_passed" : "droid_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Droid hello probe succeeded."
          : "Droid probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        ...(hasHello
          ? {}
          : {
              hint: "Run `droid exec --output-format json` manually and prompt `Respond with hello` to inspect the full response.",
            }),
      });
    } else if (isDroidAuthRequiredError(authEvidence)) {
      checks.push({
        code: "droid_hello_probe_auth_required",
        level: "warn",
        message: "Droid CLI is installed, but authentication is not ready.",
        ...(detail ? { detail } : {}),
        hint: "Set FACTORY_API_KEY in adapter env or shell environment, then retry the probe.",
      });
    } else {
      checks.push({
        code: "droid_hello_probe_failed",
        level: "error",
        message: "Droid hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Run `droid exec --output-format json` manually in this working directory to debug the failure.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}