import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readSessionId(record: Record<string, unknown>): string {
  return asString(record.session_id, asString(record.sessionId, asString(record.session, "")));
}

function readUsage(record: Record<string, unknown>) {
  const usage = asRecord(record.usage);
  return {
    inputTokens:
      asNumber(record.inputTokens, NaN) ||
      asNumber(record.input_tokens, NaN) ||
      asNumber(usage?.inputTokens, asNumber(usage?.input_tokens, 0)),
    outputTokens:
      asNumber(record.outputTokens, NaN) ||
      asNumber(record.output_tokens, NaN) ||
      asNumber(usage?.outputTokens, asNumber(usage?.output_tokens, 0)),
    cachedTokens:
      asNumber(record.cachedInputTokens, NaN) ||
      asNumber(record.cached_input_tokens, NaN) ||
      asNumber(record.cachedTokens, NaN) ||
      asNumber(usage?.cachedInputTokens, asNumber(usage?.cached_input_tokens, asNumber(usage?.cachedTokens, 0))),
    costUsd:
      asNumber(record.costUsd, NaN) ||
      asNumber(record.cost_usd, NaN) ||
      asNumber(record.totalCostUsd, NaN) ||
      asNumber(record.total_cost_usd, 0),
  };
}

export function parseDroidStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === "system" && asString(parsed.subtype) === "init") {
    const sessionId = readSessionId(parsed);
    return sessionId
      ? [{ kind: "init", ts, model: asString(parsed.model, "droid"), sessionId }]
      : [{ kind: "system", ts, text: "Droid session initialized" }];
  }

  if (type === "message") {
    const role = asString(parsed.role);
    const text = asString(parsed.text);
    if (!text) return [];
    if (role === "assistant") return [{ kind: "assistant", ts, text }];
    if (role === "user") return [{ kind: "user", ts, text }];
    return [{ kind: "system", ts, text }];
  }

  if (type === "tool_call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.toolName, asString(parsed.toolId, "tool_call")),
      toolUseId: asString(parsed.id),
      input: parsed.parameters ?? {},
    }];
  }

  if (type === "tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.id),
      content: stringifyUnknown(parsed.value ?? parsed.output ?? parsed.result),
      isError: parsed.isError === true || parsed.is_error === true,
    }];
  }

  if (type === "completion" || type === "result") {
    const usage = readUsage(parsed);
    const text =
      type === "completion"
        ? asString(parsed.finalText, asString(parsed.text, ""))
        : asString(parsed.result, "");
    const isError = parsed.isError === true || parsed.is_error === true;
    const errors = isError
      ? [stringifyUnknown(parsed.error ?? parsed.message ?? parsed.result)].filter(Boolean)
      : [];
    return [{
      kind: "result",
      ts,
      text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: usage.costUsd,
      subtype: asString(parsed.subtype, isError ? "error" : "success"),
      isError,
      errors,
    }];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: stringifyUnknown(parsed.error ?? parsed.message ?? parsed) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}