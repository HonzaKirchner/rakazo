import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

/** The workspace app that serves the Claude Code runner (claude-relay). */
const APP_SLUG = "claude";
/** A workspace start takes a minute or two; there is no point asking much sooner. */
const START_RETRY_MS = 15_000;
const STARTABLE = new Set(["stopped", "failed", "canceled"]);

const agentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(["running", "finished", "failed", "cancelled"]),
  runId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  summary: z.string().optional(),
});
const workspaceSchema = z.object({
  id: z.string().min(1),
  latest_build: z.object({ status: z.string() }),
});

export interface CoderWorkspace {
  origin: string;
  owner: string;
  /** `workspace` or `workspace.agent`, as Coder's app paths take it. */
  workspaceAndAgent: string;
  name: string;
}

/** Accepts the workspace's dashboard URL, such as https://coder.example.com/@alice/agents. */
export function parseCoderWorkspaceUrl(value: string | undefined): CoderWorkspace | undefined {
  if (!value || !URL.canParse(value.trim())) return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search) return undefined;
  const match = /^\/@([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return undefined;
  const owner = decodeURIComponent(match[1]!);
  const workspaceAndAgent = decodeURIComponent(match[2]!);
  const name = workspaceAndAgent.split(".")[0]!;
  if (!owner || !name) return undefined;
  return { origin: url.origin, owner, workspaceAndAgent, name };
}

export interface CoderCloudAgentOptions {
  workspaceUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Runs agents through the Claude Code runner in one Coder workspace. Coder's wire
 * formats, workspace lifecycle and credential stay inside this adapter.
 */
export class CoderCloudAgentProvider implements CloudAgentProvider {
  private readonly workspace: CoderWorkspace;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CoderCloudAgentOptions) {
    const workspace = parseCoderWorkspaceUrl(options.workspaceUrl);
    if (!workspace) throw new Error("CLOUD_AGENT_URL must be a Coder workspace URL");
    this.workspace = workspace;
    this.token = options.token.trim();
    if (!this.token) throw new Error("CLOUD_AGENT_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "coder",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // The runner returns the existing agent for a repeated id, so a lost response is safe to resend.
    const id = coderAgentId(request.idempotencyKey);
    return this.snapshot(
      await this.app(
        "PUT",
        `/agents/${id}`,
        {
          prompt: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
          ...(request.repository ? { repository: request.repository } : {}),
          ...(request.openPr !== undefined ? { openPr: request.openPr } : {}),
        },
        request.signal ?? context.signal,
      ),
    );
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const path = runId
      ? `/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`
      : `/agents/${encodeURIComponent(id)}`;
    return this.snapshot(await this.app("GET", path, undefined, context.signal));
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const signal = request.signal ?? context.signal;
    // Read first: a failure here means nothing was sent, so the caller can safely resend.
    await this.get(id, context).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    const response = await this.app(
      "POST",
      `/agents/${encodeURIComponent(id)}/runs`,
      {
        prompt: request.prompt,
        ...(request.images?.length ? { images: request.images } : {}),
      },
      signal,
    );
    // Follow-ups have no idempotency key. A busy agent may already be running an
    // earlier attempt of this one, so the caller must observe the run, not resend.
    if (response === BUSY) throw new Error("Cloud agent is busy with another run");
    return this.snapshot(response);
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const snapshot = await this.get(id, context, runId);
    if (snapshot.status !== "running") return snapshot;
    // The runner answers once the run has stopped, so this is the observed outcome.
    return this.snapshot(
      await this.app(
        "POST",
        `/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(snapshot.latestRunId!)}/cancel`,
        {},
        context.signal,
      ),
    );
  }

  private snapshot(value: unknown): CloudAgentSnapshot {
    const parsed = agentSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    const agent = parsed.data;
    return {
      id: agent.id,
      title: agent.title || "Cloud agent",
      status: agent.status,
      // The runner's page for this agent, behind the same Coder login as its API.
      url: `${this.workspace.origin}${this.appPath(`/ui/conversations/${encodeURIComponent(agent.id)}`)}`,
      latestRunId: agent.runId,
      ...(agent.branch ? { branch: agent.branch } : {}),
      ...(agent.prUrl ? { prUrl: agent.prUrl } : {}),
      ...(agent.summary ? { summary: agent.summary } : {}),
    };
  }

  /** A call to the runner. Anything that never reached it wakes the workspace and retries later. */
  private async app(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { status, json } = await this.request(method, this.appPath(path), body, signal);
    if (status >= 200 && status < 300) return json;
    const code = json && typeof json === "object" && "code" in json ? json.code : undefined;
    if (code === "not_found") throw new CloudAgentRequestRejected("not_found");
    if (code === "invalid") throw new CloudAgentRequestRejected();
    if (code === "busy") return BUSY;
    if (typeof code === "string") throw new Error(`Cloud agent request failed (${status})`);
    // Coder answered for an app it could not reach: the workspace is stopped or still starting.
    return this.wake(signal);
  }

  private appPath(path: string) {
    const { owner, workspaceAndAgent } = this.workspace;
    return `/@${encodeURIComponent(owner)}/${encodeURIComponent(workspaceAndAgent)}/apps/${APP_SLUG}${path}`;
  }

  private async wake(signal: AbortSignal): Promise<never> {
    const { owner, name } = this.workspace;
    const found = await this.request(
      "GET",
      `/api/v2/users/${encodeURIComponent(owner)}/workspace/${encodeURIComponent(name)}`,
      undefined,
      signal,
    );
    if (found.status === 404) throw new CloudAgentRequestRejected("not_found");
    const workspace = workspaceSchema.safeParse(found.json);
    if (found.status !== 200 || !workspace.success)
      throw new Error(`Coder workspace lookup failed (${found.status})`);
    if (!STARTABLE.has(workspace.data.latest_build.status))
      throw new CloudAgentRetryLater("unavailable", START_RETRY_MS);
    const started = await this.request(
      "POST",
      `/api/v2/workspaces/${encodeURIComponent(workspace.data.id)}/builds`,
      { transition: "start" },
      signal,
    );
    // 409: another instance already started it.
    if (started.status !== 201 && started.status !== 409)
      throw new Error(`Coder workspace start failed (${started.status})`);
    throw new CloudAgentRetryLater("unavailable", START_RETRY_MS);
  }

  private async request(method: string, path: string, body: unknown, signal: AbortSignal) {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(`${this.workspace.origin}${path}`, {
      method,
      // Coder redirects an unauthenticated app request to its login page.
      redirect: "manual",
      signal: boundedSignal,
      headers: {
        "Coder-Session-Token": this.token,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new CloudAgentRetryLater("credential");
    }
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      throw new CloudAgentRetryLater("rate_limited");
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = undefined;
    }
    if (response.ok && json === undefined) throw new Error("Invalid cloud agent response");
    return { status: response.status, json };
  }
}

const BUSY = Symbol("busy");

export function coderAgentId(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
