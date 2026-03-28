import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface ParsedDroidOutput {
  sessionId: string | null;
  model: string | null;
  finalText: string | null;
  lastAssistantText: string | null;
  errorMessage: string | null;
  finalEvent: Record<string, unknown> | null;
  usage: UsageSummary | null;
  costUsd: number | null;
  isError: boolean;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  return (
    asString(record.message) ??
    asString(record.error) ??
    asString(record.code) ??
    null
  );
}

function readSessionId(record: Record<string, unknown>): string | null {
  return asString(record.session_id) ?? asString(record.sessionId) ?? asString(record.session);
}

function readUsage(record: Record<string, unknown>): UsageSummary | null {
  const usageRecord = asRecord(record.usage);
  const inputTokens =
    asNumber(record.inputTokens) ??
    asNumber(record.input_tokens) ??
    asNumber(usageRecord?.inputTokens) ??
    asNumber(usageRecord?.input_tokens);
  const outputTokens =
    asNumber(record.outputTokens) ??
    asNumber(record.output_tokens) ??
    asNumber(usageRecord?.outputTokens) ??
    asNumber(usageRecord?.output_tokens);
  const cachedInputTokens =
    asNumber(record.cachedInputTokens) ??
    asNumber(record.cached_input_tokens) ??
    asNumber(record.cachedTokens) ??
    asNumber(usageRecord?.cachedInputTokens) ??
    asNumber(usageRecord?.cached_input_tokens) ??
    asNumber(usageRecord?.cachedTokens);
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

function readCostUsd(record: Record<string, unknown>): number | null {
  return (
    asNumber(record.costUsd) ??
    asNumber(record.cost_usd) ??
    asNumber(record.totalCostUsd) ??
    asNumber(record.total_cost_usd)
  );
}

export function parseDroidOutput(output: string): ParsedDroidOutput {
  const fullRecord = asRecord(safeJsonParse(output.trim()));
  const records = fullRecord
    ? [fullRecord]
    : output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => asRecord(safeJsonParse(line)))
        .filter((record): record is Record<string, unknown> => Boolean(record));

  const state: ParsedDroidOutput = {
    sessionId: null,
    model: null,
    finalText: null,
    lastAssistantText: null,
    errorMessage: null,
    finalEvent: null,
    usage: null,
    costUsd: null,
    isError: false,
  };

  for (const record of records) {
    const type = asString(record.type) ?? "";

    if (type === "system") {
      if ((asString(record.subtype) ?? "") === "init") {
        state.sessionId = readSessionId(record) ?? state.sessionId;
        state.model = asString(record.model) ?? state.model;
      }
      continue;
    }

    if (type === "message") {
      if ((asString(record.role) ?? "") === "assistant") {
        state.lastAssistantText = asString(record.text) ?? state.lastAssistantText;
      }
      state.sessionId = readSessionId(record) ?? state.sessionId;
      continue;
    }

    if (type === "completion") {
      state.finalEvent = record;
      state.sessionId = readSessionId(record) ?? state.sessionId;
      state.finalText = asString(record.finalText) ?? asString(record.text) ?? state.finalText;
      state.usage = readUsage(record) ?? state.usage;
      state.costUsd = readCostUsd(record) ?? state.costUsd;
      state.isError = record.isError === true || record.is_error === true;
      continue;
    }

    if (type === "result") {
      state.finalEvent = record;
      state.sessionId = readSessionId(record) ?? state.sessionId;
      state.finalText = asString(record.result) ?? state.finalText;
      state.usage = readUsage(record) ?? state.usage;
      state.costUsd = readCostUsd(record) ?? state.costUsd;
      state.isError = record.isError === true || record.is_error === true;
      if (state.isError && !state.errorMessage) {
        state.errorMessage =
          errorText(record.error) ??
          asString(record.result) ??
          asString(record.subtype);
      }
      continue;
    }

    if (type === "error") {
      state.finalEvent = state.finalEvent ?? record;
      state.isError = true;
      state.errorMessage = errorText(record.error) ?? errorText(record.message) ?? state.errorMessage;
      continue;
    }
  }

  return state;
}

export function isDroidUnknownSessionError(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`;
  return /unknown\s+session|session\s+.*not\s+found|invalid\s+session(?:[_\s-]?id)?|unable\s+to\s+resume\s+session/i.test(text);
}

export function isDroidAuthRequiredError(text: string): boolean {
  return /factory[_\s-]?api[_\s-]?key|authentication\s+required|api[_\s-]?key\s+required|invalid\s+api[_\s-]?key|unauthorized|forbidden|login\s+required|not\s+logged\s+in/i.test(text);
}