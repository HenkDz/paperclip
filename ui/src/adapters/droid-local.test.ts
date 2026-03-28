import { describe, expect, it } from "vitest";
import { parseDroidStdoutLine } from "@paperclipai/adapter-droid-local/ui";

describe("parseDroidStdoutLine", () => {
  it("parses stream-json completion events into result entries", () => {
    const ts = "2026-03-28T12:00:00.000Z";
    const entries = parseDroidStdoutLine(
      JSON.stringify({
        type: "completion",
        finalText: "Completed the task successfully.",
        session_id: "session-123",
      }),
      ts,
    );

    expect(entries).toEqual([
      {
        kind: "result",
        ts,
        text: "Completed the task successfully.",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });
});