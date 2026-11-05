import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanCloudAgentTitle, cloudAgentTitle } from "./cloud-agent-title.js";
import type { RunContext } from "./run-context.js";

vi.mock("./model-selection.js", () => ({ findConnectedModelCredential: vi.fn(async () => null) }));
vi.mock("./run-model.js", () => ({
  resolveModelKey: vi.fn(async () => ({ apiKey: "test-key" })),
  resolvedModelRunFields: (resolved: { apiKey?: string }) => ({ apiKey: resolved.apiKey }),
}));
vi.mock("@rakazo/db", () => ({ recordUsage: vi.fn(async () => undefined) }));

const prompt = "Fix the login redirect\nIt loops after sign-in on Safari.";

function context(input: {
  primary?: { provider: string; modelId: string } | null;
  reply?: string;
  fail?: boolean;
}) {
  const requests: AgentRunRequest[] = [];
  const ctx = {
    deps: {
      prisma: {},
      secretStore: {},
      runtime: {
        async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
          requests.push(request);
          if (input.fail) throw new Error("offline");
          yield { type: "done", text: input.reply ?? "" } as AgentRuntimeEvent;
        },
      },
    },
    run: { userId: "user", spaceId: "space" },
    runId: "run",
    bot: { id: "bot" },
    thread: { id: "thread" },
    context: { signal: new AbortController().signal },
    secrets: [],
    trust: {
      loadApprovalModel: async () => ({
        primary: input.primary === undefined ? { provider: "local", modelId: "small" } : input.primary,
        backups: [],
        primarySource: "member",
      }),
    },
  } as unknown as RunContext;
  return { ctx, requests };
}

describe("cloud agent title", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the approval model's short title", async () => {
    const { ctx, requests } = context({ reply: '"Fix Safari login redirect loop."' });
    await expect(cloudAgentTitle(ctx, prompt)).resolves.toBe("Fix Safari login redirect loop");
    expect(requests[0]).toMatchObject({
      tools: [],
      history: [],
      model: { provider: "local", id: "small", thinkingLevel: null },
    });
    expect(requests[0]!.prompt).toContain("It loops after sign-in on Safari.");
  });

  it("falls back to the prompt's first line", async () => {
    const firstLine = "Fix the login redirect";
    await expect(cloudAgentTitle(context({ primary: null }).ctx, prompt)).resolves.toBe(firstLine);
    await expect(
      cloudAgentTitle(context({ primary: { provider: "jev", modelId: "jev-latest" } }).ctx, prompt),
    ).resolves.toBe(firstLine);
    await expect(cloudAgentTitle(context({ fail: true }).ctx, prompt)).resolves.toBe(firstLine);
    await expect(cloudAgentTitle(context({ reply: "" }).ctx, prompt)).resolves.toBe(firstLine);
    await expect(
      cloudAgentTitle(context({ reply: "I hit a problem: rate limited" }).ctx, prompt),
    ).resolves.toBe(firstLine);
  });

  it("keeps one plain line", () => {
    expect(cleanCloudAgentTitle("\n## Title: **Add dark mode**\nExtra")).toBe("Add dark mode");
    expect(cleanCloudAgentTitle("x".repeat(200))).toHaveLength(80);
    expect(cleanCloudAgentTitle("  \n ")).toBeUndefined();
  });
});
