import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { isManagedProjectWorkspaceCwd, isUnsafeSessionWorkspaceCwd } from "./session-workspace-cwd.js";

describe("isUnsafeSessionWorkspaceCwd", () => {
  it("rejects system roots that can poison remote sandbox session resumes", () => {
    expect(isUnsafeSessionWorkspaceCwd("/")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/private/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/run")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/proc")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/sys")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/dev")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/run")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/.")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/..")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/./run")).toBe(true);
  });

  it("allows concrete workspace descendants", () => {
    expect(isUnsafeSessionWorkspaceCwd("/tmp/paperclip-workspace")).toBe(false);
    expect(isUnsafeSessionWorkspaceCwd("/Users/dotta/paperclip")).toBe(false);
    expect(isUnsafeSessionWorkspaceCwd(null)).toBe(false);
  });
});

describe("isManagedProjectWorkspaceCwd", () => {
  it("recognizes Paperclip-managed project workspaces", () => {
    const cwd = path.join(
      resolvePaperclipInstanceRoot(),
      "projects",
      "company-1",
      "project-1",
      "_default",
    );
    expect(isManagedProjectWorkspaceCwd(cwd)).toBe(true);
  });

  it("does not classify agent homes or arbitrary repo paths as managed project workspaces", () => {
    const agentHome = path.join(resolvePaperclipInstanceRoot(), "workspaces", "agent-1");
    expect(isManagedProjectWorkspaceCwd(agentHome)).toBe(false);
    expect(isManagedProjectWorkspaceCwd("/Users/dotta/paperclip")).toBe(false);
    expect(isManagedProjectWorkspaceCwd(null)).toBe(false);
  });
});
