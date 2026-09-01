import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { parseObject } from "../adapters/utils.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer wake context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-context-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  async function waitForRunsToSettle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if ((active[0]?.count ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for heartbeat timer runs to settle");
  }

  afterEach(async () => {
    for (const agentId of seededAgentIds) {
      await heartbeat.cancelActiveForAgent(agentId);
    }
    try {
      await waitForRunsToSettle(1_000);
    } catch {
      // Best-effort cleanup is enough here; timer runs can outlive the assertion.
    }
    seededAgentIds.clear();
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("activity_log_run_id_heartbeat_runs_id_fk") || attempt === 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seeds timer wakes with the assignee issue context instead of a stale task session", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    seededAgentIds.add(agentId);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date("2026-05-21T00:00:00.000Z"),
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Internal Ops",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "paperclip",
      cwd: process.cwd(),
      repoUrl: "https://github.com/HenkDz/paperclip.git",
      repoRef: "master",
      isPrimary: true,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      title: "CTO scheduler lane",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const tickAt = new Date("2026-05-21T02:00:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .then((rows) => rows[0] ?? null);
    expect(run).not.toBeNull();

    const context = parseObject(run?.contextSnapshot);
    expect(context).toMatchObject({
      issueId,
      taskId: issueId,
      taskKey: issueId,
      projectId,
      projectWorkspaceId: workspaceId,
      repoUrl: "https://github.com/HenkDz/paperclip.git",
      repoRef: "master",
      wakeReason: "heartbeat_timer",
      wakeSource: "timer",
      wakeTriggerDetail: "system",
      source: "scheduler",
      reason: "interval_elapsed",
    });
  });
});
