import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CoderCloudAgentProvider, parseCoderWorkspaceUrl } from "./coder-cloud-agent.js";

const ORIGIN = "https://coder.example.com";
const WORKSPACE_URL = `${ORIGIN}/@alice/agents`;
const APP = "/@alice/agents/apps/claude";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

interface FakeAgent {
  id: string;
  title: string;
  runs: Array<{ id: string; status: string; summary?: string }>;
  branch?: string;
  prUrl?: string;
}

/** Coder's workspace API and app proxy in front of an in-memory runner. */
class FakeCoder {
  token = "fake-token";
  workspaceStatus = "running";
  starts = 0;
  readonly agents = new Map<string, FakeAgent>();
  private sequence = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error("Unexpected origin");
    if (new Headers(init?.headers).get("coder-session-token") !== this.token)
      return new Response(null, { status: 303, headers: { location: "/login" } });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/v2/users/alice/workspace/agents" && method === "GET")
      return Response.json({ id: "ws-1", latest_build: { status: this.workspaceStatus } });
    if (url.pathname === "/api/v2/workspaces/ws-1/builds" && method === "POST") {
      this.starts += 1;
      this.workspaceStatus = "starting";
      return Response.json({}, { status: 201 });
    }
    if (!url.pathname.startsWith(`${APP}/`)) return Response.json({}, { status: 404 });
    if (this.workspaceStatus !== "running")
      return Response.json({ message: "Agent is not connected" }, { status: 502 });
    return this.runner(method, url.pathname.slice(APP.length).split("/").slice(1), body);
  };

  finish(id: string, summary?: string) {
    Object.assign(this.agents.get(id)!.runs.at(-1)!, { status: "finished", summary });
  }

  private runner(method: string, parts: string[], body: Record<string, unknown> | undefined) {
    const [, id, runs, runId, action] = parts;
    const agent = this.agents.get(id!);
    if (method === "PUT" && !runs) {
      if (agent) return Response.json(view(agent));
      const created: FakeAgent = {
        id: id!,
        title: String(body?.prompt).split("\n")[0]!,
        runs: [{ id: this.runId(), status: "running" }],
        ...(body?.repository ? { branch: `agent/${id!.slice(0, 12)}` } : {}),
        ...(body?.openPr ? { prUrl: "https://github.com/example/demo/pull/1" } : {}),
      };
      this.agents.set(created.id, created);
      return Response.json(view(created));
    }
    if (!agent) return Response.json({ code: "not_found" }, { status: 404 });
    if (method === "GET" && !runs) return Response.json(view(agent));
    if (method === "POST" && runs && !runId) {
      if (agent.runs.at(-1)!.status === "running")
        return Response.json({ code: "busy" }, { status: 409 });
      agent.runs.push({ id: this.runId(), status: "running" });
      return Response.json(view(agent));
    }
    const run = agent.runs.find((item) => item.id === runId);
    if (!run) return Response.json({ code: "not_found" }, { status: 404 });
    if (method === "POST" && action === "cancel" && run.status === "running")
      run.status = "cancelled";
    return Response.json(view(agent, run));
  }

  private runId() {
    this.sequence += 1;
    return `run-${this.sequence}`;
  }
}

function view(agent: FakeAgent, run = agent.runs.at(-1)!) {
  return {
    id: agent.id,
    title: agent.title,
    status: run.status,
    runId: run.id,
    ...(run.summary ? { summary: run.summary } : {}),
    ...(agent.branch ? { branch: agent.branch } : {}),
    ...(agent.prUrl ? { prUrl: agent.prUrl } : {}),
  };
}

function create() {
  const coder = new FakeCoder();
  const provider = new CoderCloudAgentProvider({
    workspaceUrl: WORKSPACE_URL,
    token: "fake-token",
    fetch: coder.fetch,
  });
  return { coder, provider };
}

describe("coder cloud agent provider (offline)", () => {
  it("starts a stopped workspace once and launches when it is running", async () => {
    const { coder, provider } = create();
    coder.workspaceStatus = "stopped";
    const request = { idempotencyKey: "agent-1", prompt: "Add a README" };
    const stopped = await provider.launch(request, ctx).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(CloudAgentRetryLater);
    expect(stopped).toMatchObject({ reason: "unavailable" });
    await expect(provider.launch(request, ctx)).rejects.toBeInstanceOf(CloudAgentRetryLater);
    expect(coder.starts).toBe(1);
    coder.workspaceStatus = "running";
    const first = await provider.launch(request, ctx);
    expect(first).toMatchObject({
      status: "running",
      title: "Add a README",
    });
    expect(first.url).toBe(`${ORIGIN}${APP}/ui/conversations/${first.id}`);
    expect((await provider.launch(request, ctx)).id).toBe(first.id);
    expect(coder.agents.size).toBe(1);
  });

  it("tracks each run through follow-ups, branches and pull requests", async () => {
    const { coder, provider } = create();
    const first = await provider.launch(
      {
        idempotencyKey: "agent-2",
        prompt: "Fix the bug",
        repository: "https://github.com/example/demo",
        openPr: true,
      },
      ctx,
    );
    await expect(provider.reply(first.id, { prompt: "Busy" }, ctx)).rejects.not.toBeInstanceOf(
      CloudAgentRequestRejected,
    );
    coder.finish(first.id, "Fixed the bug");
    const done = await provider.get(first.id, ctx);
    expect(done).toMatchObject({
      status: "finished",
      summary: "Fixed the bug",
      prUrl: "https://github.com/example/demo/pull/1",
    });
    expect(done.branch).toMatch(/^agent\//);
    const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
    expect(followup.latestRunId).not.toBe(first.latestRunId);
    expect(followup).not.toHaveProperty("summary");
    expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("finished");
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
  });

  it("maps credentials and missing agents to the shared errors", async () => {
    const { coder, provider } = create();
    await expect(provider.get("missing", ctx)).rejects.toEqual(
      new CloudAgentRequestRejected("not_found"),
    );
    coder.token = "rotated";
    const rejected = await provider.get("missing", ctx).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(CloudAgentRetryLater);
    expect(rejected).toMatchObject({ reason: "credential" });
  });
});

describe("coder cloud agent composition", () => {
  it("parses only Coder workspace URLs", () => {
    expect(parseCoderWorkspaceUrl(WORKSPACE_URL)).toEqual({
      origin: ORIGIN,
      owner: "alice",
      workspaceAndAgent: "agents",
      name: "agents",
    });
    expect(parseCoderWorkspaceUrl(`${ORIGIN}/@alice/agents.main/`)?.name).toBe("agents");
    for (const value of [
      undefined,
      "http://coder.example.com/@alice/agents",
      `${ORIGIN}/alice/agents`,
      `${ORIGIN}/@alice/agents/apps`,
      "https://user:pass@coder.example.com/@alice/agents",
    ])
      expect(parseCoderWorkspaceUrl(value)).toBeUndefined();
  });

  it("needs the workspace, a token and a Space, and survives token rotation", () => {
    const source = {
      CLOUD_AGENT_PROVIDER: "coder",
      CLOUD_AGENT_URL: WORKSPACE_URL,
      CLOUD_AGENT_API_KEY: "fake-token",
      CLOUD_AGENT_SPACE_ID: "test-space",
    };
    for (const missing of ["CLOUD_AGENT_URL", "CLOUD_AGENT_API_KEY", "CLOUD_AGENT_SPACE_ID"])
      expect(resolveCloudAgentProvider({ ...source, [missing]: "" })).toBe("none");
    expect(resolveCloudAgentProvider({ ...source, CLOUD_AGENT_URL: "not a url" })).toBe("none");
    const connection = createCloudAgentConnection(source)!;
    expect(connection.provider.describe().id).toBe("coder");
    expect(cloudAgentsEnabled(connection, "test-space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fake-token");
    const rotated = createCloudAgentConnection({ ...source, CLOUD_AGENT_API_KEY: "new-token" })!;
    expect(rotated.key).toBe(connection.key);
  });
});
