import pc from "picocolors";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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

export function printDroidStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);
  if (type === "system" && asString(parsed.subtype) === "init") {
    const sessionId = asString(parsed.session_id, asString(parsed.sessionId));
    const model = asString(parsed.model);
    const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""]
      .filter(Boolean)
      .join(", ");
    console.log(pc.blue(`Droid session initialized${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "message") {
    const role = asString(parsed.role, "assistant");
    const text = asString(parsed.text);
    if (text) {
      console.log((role === "assistant" ? pc.green : pc.gray)(`${role}: ${text}`));
    }
    return;
  }

  if (type === "tool_call") {
    const name = asString(parsed.toolName, asString(parsed.toolId, "tool_call"));
    console.log(pc.yellow(`tool_call: ${name}`));
    if (parsed.parameters !== undefined) {
      console.log(pc.gray(stringifyUnknown(parsed.parameters)));
    }
    return;
  }

  if (type === "tool_result") {
    const isError = parsed.isError === true || parsed.is_error === true;
    const text = stringifyUnknown(parsed.value ?? parsed.output ?? parsed.result);
    console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
    if (text) console.log((isError ? pc.red : pc.gray)(text));
    return;
  }

  if (type === "completion" || type === "result") {
    const isError = parsed.isError === true || parsed.is_error === true;
    const text =
      type === "completion"
        ? asString(parsed.finalText, asString(parsed.text, ""))
        : asString(parsed.result, "");
    console.log((isError ? pc.red : pc.green)(`${type}: ${text || "(no text)"}`));
    return;
  }

  if (type === "error") {
    console.log(pc.red(`error: ${stringifyUnknown(parsed.error ?? parsed.message ?? parsed)}`));
    return;
  }

  console.log(line);
}