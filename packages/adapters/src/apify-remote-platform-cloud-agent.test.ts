import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  ApifyRemotePlatformCloudAgentProvider,
  apifyRemotePlatformAgentId,
  NO_REPOSITORY,
  parseApifyRemotePlatformUrl,
  parseCoderWorkspaceUrl,
} from "./apify-remote-platform-cloud-agent.js";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";

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

/** Coder's app proxy in front of an in-memory runner. */
class FakeCoder {
  token = "fake-token";
  workspaceStatus = "running";
  /** Requests that went anywhere but the runner. */
  outside = 0;
  readonly agents = new Map<string, FakeAgent>();
  /** The branch the checkout sits on with changes no run made, while it is dirty. */
  dirty?: string;
  /** An older runner, whose `busy` says no more than that. */
  legacyBusy = false;
  /** The repository each launch named, in order. */
  readonly repositories: unknown[] = [];
  private sequence = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error("Unexpected origin");
    if (new Headers(init?.headers).get("coder-session-token") !== this.token)
      return new Response(null, { status: 303, headers: { location: "/login" } });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (!url.pathname.startsWith(`${APP}/`)) {
      this.outside += 1;
      return Response.json({}, { status: 404 });
    }
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
      const refused = this.refuse();
      if (refused) return refused;
      this.repositories.push(body?.repository);
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
      const refused = this.refuse(agent);
      if (refused) return refused;
      agent.runs.push({ id: this.runId(), status: "running" });
      return Response.json(view(agent));
    }
    const run = agent.runs.find((item) => item.id === runId);
    if (!run) return Response.json({ code: "not_found" }, { status: 404 });
    if (method === "POST" && action === "cancel" && run.status === "running")
      run.status = "cancelled";
    return Response.json(view(agent, run));
  }

  /** One checkout, one run at a time: busy while any run is going or the checkout is dirty. */
  private refuse(own?: FakeAgent) {
    const running = [...this.agents.values()].find(
      (item) => item.runs.at(-1)!.status === "running",
    );
    const body = running
      ? { code: "busy", reason: "locked", conversation: running.id }
      : this.dirty && this.dirty !== own?.branch
        ? { code: "busy", reason: "dirty", branch: this.dirty }
        : undefined;
    if (!body) return undefined;
    return Response.json(this.legacyBusy ? { code: "busy" } : body, { status: 409 });
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
  const provider = new ApifyRemotePlatformCloudAgentProvider({
    workspaceUrl: WORKSPACE_URL,
    token: "fake-token",
    fetch: coder.fetch,
  });
  return { coder, provider };
}

describe("apify-remote-platform cloud agent provider, on one Coder workspace (offline)", () => {
  it("waits for a stopped workspace without starting it and launches once it runs", async () => {
    const { coder, provider } = create();
    coder.workspaceStatus = "stopped";
    const request = { idempotencyKey: "agent-1", prompt: "Add a README" };
    const stopped = await provider.launch(request, ctx).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(CloudAgentRetryLater);
    expect(stopped).toMatchObject({ reason: "unavailable" });
    expect(coder.outside).toBe(0);
    coder.workspaceStatus = "running";
    const first = await provider.launch(request, ctx);
    expect(first).toMatchObject({
      status: "running",
      title: "Add a README",
    });
    expect(first.url).toBe(`${ORIGIN}/@alice/agents`);
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

  it("names a placeholder repository for a launch that has none", async () => {
    const { coder, provider } = create();
    await provider.launch({ idempotencyKey: "agent-none", prompt: "How are you?" }, ctx);
    coder.finish(apifyRemotePlatformAgentId("agent-none"));
    await provider.launch(
      {
        idempotencyKey: "agent-named",
        prompt: "Fix it",
        repository: "https://github.com/example/demo",
      },
      ctx,
    );
    expect(coder.repositories).toEqual([NO_REPOSITORY, "https://github.com/example/demo"]);
  });

  it("waits for the one checkout instead of failing a refused launch or follow-up", async () => {
    const { coder, provider } = create();
    const first = await provider.launch({ idempotencyKey: "agent-3", prompt: "First" }, ctx);
    const second = { idempotencyKey: "agent-4", prompt: "Second" };
    const refused = await provider.launch(second, ctx).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CloudAgentRetryLater);
    expect(refused).toMatchObject({ reason: "unavailable" });
    expect(coder.agents.size).toBe(1);
    // Its own run is going: observe it, since it may be an earlier attempt of this follow-up.
    const own = await provider.reply(first.id, { prompt: "Still" }, ctx).catch((e: unknown) => e);
    expect(own).toBeInstanceOf(Error);
    expect(own).not.toBeInstanceOf(CloudAgentRetryLater);
    coder.finish(first.id);
    const other = await provider.launch(second, ctx);
    // Idle itself, but the other agent's run holds the checkout: nothing was accepted.
    const held = await provider.reply(first.id, { prompt: "Again" }, ctx).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(CloudAgentRetryLater);
    expect(held).toMatchObject({ reason: "unavailable" });
    coder.finish(other.id);
    coder.dirty = "feature/by-hand";
    const dirty = await provider.reply(first.id, { prompt: "Again" }, ctx).catch((e: unknown) => e);
    expect(dirty).toBeInstanceOf(CloudAgentRetryLater);
    expect((dirty as CloudAgentRetryLater).retryAfterMs).toBeGreaterThan(
      (held as CloudAgentRetryLater).retryAfterMs!,
    );
    await expect(
      provider.launch({ idempotencyKey: "agent-5", prompt: "Third" }, ctx),
    ).rejects.toBeInstanceOf(CloudAgentRetryLater);
    coder.dirty = undefined;
    expect((await provider.reply(first.id, { prompt: "Again" }, ctx)).status).toBe("running");
  });

  it("observes a bare busy from an older runner", async () => {
    const { coder, provider } = create();
    coder.legacyBusy = true;
    const first = await provider.launch({ idempotencyKey: "agent-6", prompt: "First" }, ctx);
    const refused = await provider
      .reply(first.id, { prompt: "Again" }, ctx)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(CloudAgentRetryLater);
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

describe("apify-remote-platform cloud agent composition", () => {
  it("parses only Coder workspace URLs", () => {
    expect(parseCoderWorkspaceUrl(WORKSPACE_URL)).toEqual({
      origin: ORIGIN,
      owner: "alice",
      workspaceAndAgent: "agents",
    });
    expect(parseCoderWorkspaceUrl(`${ORIGIN}/@alice/agents.main/`)?.workspaceAndAgent).toBe(
      "agents.main",
    );
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
      CLOUD_AGENT_PROVIDER: "apify-remote-platform",
      CLOUD_AGENT_URL: WORKSPACE_URL,
      CLOUD_AGENT_API_KEY: "fake-token",
      CLOUD_AGENT_SPACE_ID: "test-space",
    };
    for (const missing of ["CLOUD_AGENT_URL", "CLOUD_AGENT_API_KEY", "CLOUD_AGENT_SPACE_ID"])
      expect(resolveCloudAgentProvider({ ...source, [missing]: "" })).toBe("none");
    expect(resolveCloudAgentProvider({ ...source, CLOUD_AGENT_URL: "not a url" })).toBe("none");
    const connection = createCloudAgentConnection(source)!;
    expect(connection.provider.describe().id).toBe("apify-remote-platform");
    expect(cloudAgentsEnabled(connection, "test-space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fake-token");
    const rotated = createCloudAgentConnection({ ...source, CLOUD_AGENT_API_KEY: "new-token" })!;
    expect(rotated.key).toBe(connection.key);
  });
});

describe("apify-remote-platform cloud agent provider (offline)", () => {
  const SERVICE = "https://platform.example.com/api/tasks";

  /** A platform that takes two launches to have a workspace ready, then answers as the runner does. */
  function service() {
    const requests: string[] = [];
    let attempts = 0;
    const agent = { id: "", title: "Fix", status: "running", runId: "run-1" };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      if (new Headers(init?.headers).get("authorization") !== "Bearer service-token")
        return Response.json({ code: "unauthorized" }, { status: 401 });
      if (new Headers(init?.headers).has("coder-session-token"))
        throw new Error("Coder token sent");
      const [id, runs, runId, action] = url.pathname.slice("/api/tasks/".length).split("/");
      if (method === "PUT") {
        attempts += 1;
        if (attempts < 3)
          return Response.json({ code: "preparing", reason: "starting" }, { status: 503 });
        agent.id = id!;
      }
      if (id !== agent.id) return Response.json({ code: "not_found" }, { status: 404 });
      if (method === "POST" && runs && !runId) agent.runId = "run-2";
      if (action === "cancel") agent.status = "cancelled";
      return Response.json({
        ...agent,
        ...(runId ? { runId } : {}),
        url: `https://platform.example.com/#desk/${agent.id}`,
      });
    };
    return { requests, fetchImpl };
  }

  it("asks again while a workspace is prepared, then follows the agent through the platform", async () => {
    const { requests, fetchImpl } = service();
    const provider = new ApifyRemotePlatformCloudAgentProvider({
      workspaceUrl: `${SERVICE}/`,
      token: "service-token",
      fetch: fetchImpl,
    });
    const launch = () => provider.launch({ prompt: "Fix", idempotencyKey: "key" }, ctx);

    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(launch()).rejects.toMatchObject({
        constructor: CloudAgentRetryLater,
        reason: "unavailable",
      });
    const handle = await launch();
    expect(handle).toMatchObject({
      status: "running",
      latestRunId: "run-1",
      url: `https://platform.example.com/#desk/${handle.id}`,
    });

    expect((await provider.get(handle.id, ctx, "run-1")).latestRunId).toBe("run-1");
    expect((await provider.reply(handle.id, { prompt: "More" }, ctx)).latestRunId).toBe("run-2");
    expect((await provider.cancel(handle.id, ctx)).status).toBe("cancelled");
    await expect(provider.get("missing", ctx)).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    expect(new Set(requests)).toEqual(
      new Set([
        `PUT /api/tasks/${handle.id}`,
        `GET /api/tasks/${handle.id}`,
        `GET /api/tasks/${handle.id}/runs/run-1`,
        `POST /api/tasks/${handle.id}/runs`,
        `POST /api/tasks/${handle.id}/runs/run-2/cancel`,
        "GET /api/tasks/missing",
      ]),
    );

    const stranger = new ApifyRemotePlatformCloudAgentProvider({
      workspaceUrl: SERVICE,
      token: "other",
      fetch: fetchImpl,
    });
    await expect(stranger.get(handle.id, ctx)).rejects.toMatchObject({ reason: "credential" });
  });

  it("takes a task API URL where a workspace URL is not given", () => {
    expect(parseApifyRemotePlatformUrl(`${SERVICE}/`)).toEqual({
      origin: "https://platform.example.com",
      path: "/api/tasks",
    });
    expect(parseApifyRemotePlatformUrl("http://127.0.0.1:4120/api/tasks")?.path).toBe("/api/tasks");
    for (const value of [
      undefined,
      "not a url",
      "http://platform.example.com/api/tasks",
      "https://platform.example.com",
      "https://platform.example.com/api/tasks?x=1",
      "https://user:pass@platform.example.com/api/tasks",
      WORKSPACE_URL,
    ])
      expect(parseApifyRemotePlatformUrl(value)).toBeUndefined();
    const source = {
      CLOUD_AGENT_PROVIDER: "apify-remote-platform",
      CLOUD_AGENT_URL: SERVICE,
      CLOUD_AGENT_API_KEY: "service-token",
      CLOUD_AGENT_SPACE_ID: "test-space",
    };
    expect(resolveCloudAgentProvider(source)).toBe("apify-remote-platform");
    expect(createCloudAgentConnection(source)!.provider.describe().id).toBe(
      "apify-remote-platform",
    );
  });
});
