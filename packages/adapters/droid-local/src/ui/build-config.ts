import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      env[key] = { type: "plain", value: record.value };
      continue;
    }
    if (record.type === "secret_ref" && typeof record.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: record.secretId,
        ...(typeof record.version === "number" || record.version === "latest"
          ? { version: record.version }
          : {}),
      };
    }
  }
  return env;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildDroidLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const adapterConfig: Record<string, unknown> = {};
  if (v.cwd) adapterConfig.cwd = v.cwd;
  if (v.instructionsFilePath) adapterConfig.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) adapterConfig.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) adapterConfig.bootstrapPromptTemplate = v.bootstrapPrompt;
  if (v.model) adapterConfig.model = v.model;
  if (v.thinkingEffort) adapterConfig.effort = v.thinkingEffort;
  adapterConfig.timeoutSec = 0;
  adapterConfig.graceSec = 15;

  const env = parseEnvBindings(v.envBindings);
  const legacyEnv = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacyEnv)) {
    if (!Object.hasOwn(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) adapterConfig.env = env;

  if (v.workspaceStrategyType === "git_worktree") {
    adapterConfig.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }

  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    adapterConfig.workspaceRuntime = runtimeServices;
  }

  if (v.command) adapterConfig.command = v.command;
  if (v.extraArgs) adapterConfig.extraArgs = parseCommaArgs(v.extraArgs);
  return adapterConfig;
}