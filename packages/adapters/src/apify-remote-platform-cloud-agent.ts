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
/** The runner is unreachable while its workspace is stopped or starting, which is managed elsewhere. */
const UNREACHABLE_RETRY_MS = 15_000;
/** A refused launch or follow-up is resent once the run holding the checkout is likely over. */
const LOCKED_RETRY_MS = 30_000;
/** A dirty checkout waits for a person to deal with it, so asking often buys nothing. */
const DIRTY_RETRY_MS = 5 * 60_000;
/** Sent as the repository of a launch that names none, so the receiving side always gets one. */
export const NO_REPOSITORY = "no_repo";

const agentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(["running", "finished", "failed", "cancelled"]),
  runId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  summary: z.string().optional(),
  url: z.string().url().optional(),
});

export interface CoderWorkspace {
  origin: string;
  owner: string;
  /** `workspace` or `workspace.agent`, as Coder's app paths take it. */
  workspaceAndAgent: string;
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
  if (!owner || !workspaceAndAgent.split(".")[0]) return undefined;
  return { origin: url.origin, owner, workspaceAndAgent };
}

export interface ApifyRemotePlatformApi {
  origin: string;
  /** Where its task API starts, without a trailing slash. */
  path: string;
}

/**
 * Accepts the task API of an apify-remote-platform, which manages the workspaces itself, such
 * as https://platform.example.com/api/tasks: anything that is not a workspace's own URL.
 * Plain http only on this machine.
 */
export function parseApifyRemotePlatformUrl(
  value: string | undefined,
): ApifyRemotePlatformApi | undefined {
  if (!value || !URL.canParse(value.trim())) return undefined;
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path.startsWith("/@")) return undefined;
  return { origin: url.origin, path };
}

export interface ApifyRemotePlatformCloudAgentOptions {
  /** The platform's task API, or one Coder workspace's URL to go without the platform. */
  workspaceUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Runs agents through apify-remote-platform, which puts each agent in a Coder workspace of
 * its choosing, starting or creating one when none is free, and passes everything on to the
 * Claude Code runner (claude-relay) there. The platform speaks the runner's own API, so the
 * provider can also be pointed at the runner in one Coder workspace, through Coder, without
 * the platform; starting that workspace is then left to whatever manages it.
 */
export class ApifyRemotePlatformCloudAgentProvider implements CloudAgentProvider {
  private readonly workspace: CoderWorkspace | undefined;
  private readonly service: ApifyRemotePlatformApi | undefined;
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApifyRemotePlatformCloudAgentOptions) {
    const workspace = parseCoderWorkspaceUrl(options.workspaceUrl);
    const service = workspace ? undefined : parseApifyRemotePlatformUrl(options.workspaceUrl);
    const origin = workspace?.origin ?? service?.origin;
    if (!origin)
      throw new Error(
        "CLOUD_AGENT_URL must be the platform's task API URL or a Coder workspace URL",
      );
    this.workspace = workspace;
    this.service = service;
    this.origin = origin;
    this.token = options.token.trim();
    if (!this.token) throw new Error("CLOUD_AGENT_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "apify-remote-platform",
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
    const id = apifyRemotePlatformAgentId(request.idempotencyKey);
    const response = await this.app(
      "PUT",
      `/agents/${id}`,
      {
        prompt: request.prompt,
        ...(request.images?.length ? { images: request.images } : {}),
        repository: request.repository || NO_REPOSITORY,
        ...(request.openPr !== undefined ? { openPr: request.openPr } : {}),
      },
      request.signal ?? context.signal,
    );
    // A refused launch creates nothing: the checkout is taken by another agent's run, or
    // has changes a person must deal with. Either clears without the caller doing anything.
    if (response instanceof Busy) throw response.retryLater();
    return this.snapshot(response);
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
    if (response instanceof Busy) {
      // Another agent's run holds the checkout, or it is dirty: nothing was accepted.
      if (response.dirty || (response.holder !== undefined && response.holder !== id))
        throw response.retryLater();
      // This agent's own run is going. Follow-ups have no idempotency key, so it may be
      // an earlier attempt of this one: the caller must observe the run, not resend.
      throw new Error("Cloud agent is busy with another run");
    }
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
      // The runner has no pages: an agent sent straight to a workspace is followed on the
      // workspace's own page in Coder. The platform says itself where its agents can be.
      url: this.workspace
        ? `${this.origin}/@${encodeURIComponent(this.workspace.owner)}/${encodeURIComponent(this.workspace.workspaceAndAgent)}`
        : (agent.url ?? `${this.origin}${this.service!.path}`),
      latestRunId: agent.runId,
      ...(agent.branch ? { branch: agent.branch } : {}),
      ...(agent.prUrl ? { prUrl: agent.prUrl } : {}),
      ...(agent.summary ? { summary: agent.summary } : {}),
    };
  }

  /** A call to the runner. Anything that never reached it is retried later. */
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
    if (code === "busy") return Busy.from(json as Record<string, unknown>);
    // The platform is still getting a workspace ready for the agent: the same request, later.
    if (code === "preparing") throw new CloudAgentRetryLater("unavailable", UNREACHABLE_RETRY_MS);
    if (typeof code === "string") throw new Error(`Cloud agent request failed (${status})`);
    // Coder answered for an app it could not reach: the workspace is stopped or still starting.
    throw new CloudAgentRetryLater("unavailable", UNREACHABLE_RETRY_MS);
  }

  private appPath(path: string) {
    // The platform has no workspace in its paths, and calls an agent a task: `<api>/<id>/...`.
    if (!this.workspace) return `${this.service!.path}${path.replace(/^\/agents/, "")}`;
    const { owner, workspaceAndAgent } = this.workspace;
    return `/@${encodeURIComponent(owner)}/${encodeURIComponent(workspaceAndAgent)}/apps/${APP_SLUG}${path}`;
  }

  private async request(method: string, path: string, body: unknown, signal: AbortSignal) {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      // Coder redirects an unauthenticated app request to its login page.
      redirect: "manual",
      signal: boundedSignal,
      headers: {
        ...(this.workspace
          ? { "Coder-Session-Token": this.token }
          : { Authorization: `Bearer ${this.token}` }),
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

/** The runner refused to start a run: it has one checkout, so one run goes at a time. */
class Busy {
  private constructor(
    /** The agent whose run holds the checkout. Absent when it is dirty, or from an older runner. */
    readonly holder: string | undefined,
    /** The checkout has uncommitted changes that no run of this agent made. */
    readonly dirty: boolean,
  ) {}

  static from(body: Record<string, unknown>) {
    return new Busy(
      typeof body.conversation === "string" ? body.conversation : undefined,
      body.reason === "dirty",
    );
  }

  retryLater() {
    return new CloudAgentRetryLater("unavailable", this.dirty ? DIRTY_RETRY_MS : LOCKED_RETRY_MS);
  }
}

export function apifyRemotePlatformAgentId(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
