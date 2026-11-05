import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  cloudAgentBlockFromPayload,
  cloudAgentHttpsUrl,
  runningCloudAgent,
  withoutCloudAgent,
} from "./cloud-agent.js";
import { projectMessages } from "./events.js";

describe("shared cloud agent projection", () => {
  it("carries launch settings and the final reply, dropping unsafe or empty values", () => {
    const block = cloudAgentBlockFromPayload({
      agentId: "agent",
      title: "Weather",
      status: "finished",
      url: "https://example.test/agent",
      prompt: "What is the weather?",
      repository: "http://example.test/repo",
      openPr: false,
      imageCount: 0,
      summary: "x".repeat(30_000),
    });
    expect(block).toMatchObject({ prompt: "What is the weather?", openPr: false });
    expect(block).not.toHaveProperty("repository");
    expect(block).not.toHaveProperty("imageCount");
    expect(block.summary).toHaveLength(20_000);
    expect(cloudAgentBlockFromPayload({ agentId: "a", summary: null })).not.toHaveProperty(
      "summary",
    );
  });

  it("updates an existing card when replaying durable events", () => {
    const base = { threadId: "thread", createdAt: "2026-01-01T00:00:00Z", botId: "bot" };
    const block = cloudAgentBlockFromPayload({
      agentId: "agent",
      title: "Task",
      status: "running",
      url: "https://example.test/agent",
    });
    const messages = projectMessages([
      {
        ...base,
        id: "first",
        seq: 1,
        type: "thread.message.created",
        payload: { messageId: "card", role: "bot", blocks: [block] },
      },
      {
        ...base,
        id: "second",
        seq: 2,
        type: "thread.cloud_agent",
        payload: {
          ...block,
          messageId: "card",
          status: "finished",
          prUrl: "https://example.test/pr",
        },
      },
    ]);
    expect(messages[0]?.blocks[0]).toMatchObject({
      status: "finished",
      prUrl: "https://example.test/pr",
    });
  });
  it("normalizes invalid statuses and excludes unsafe links on every surface", () => {
    expect(
      cloudAgentBlockFromPayload({
        status: "invalid",
        url: "javascript:alert(1)",
        prUrl: "http://example.test/pr",
      }),
    ).toMatchObject({ status: "running", url: "" });
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/fake",
      "https://user:password@example.test",
      "invalid",
    ])
      expect(cloudAgentHttpsUrl(url)).toBeUndefined();
  });
});

const agent = (agentId: string, status: "running" | "finished") =>
  ({ kind: "cloud_agent", agentId, title: agentId, status, url: "" }) satisfies MessageBlock;

describe("pinned cloud agent", () => {
  it("pins the newest agent that is still running", () => {
    expect(
      runningCloudAgent([
        { blocks: [agent("old", "running")] },
        { blocks: [agent("newer", "running"), { kind: "text", text: "hi" }] },
        { blocks: [agent("new", "finished")] },
        {},
      ])?.agentId,
    ).toBe("newer");
    expect(runningCloudAgent([{ blocks: [agent("done", "finished")] }])).toBeUndefined();
    expect(runningCloudAgent([{ blocks: [{ kind: "text", text: "hi" }] }])).toBeUndefined();
  });

  it("removes only the pinned card and the messages it leaves empty", () => {
    const messages = [
      { id: "old", blocks: [agent("old", "finished")] },
      { id: "alone", blocks: [agent("new", "running")] },
      { id: "with-text", blocks: [{ kind: "text", text: "hi" }, agent("new", "running")] },
    ] satisfies { id: string; blocks: MessageBlock[] }[];
    expect(withoutCloudAgent(messages, "new")).toEqual([
      messages[0],
      { id: "with-text", blocks: [{ kind: "text", text: "hi" }] },
    ]);
    expect(withoutCloudAgent(messages, undefined)).toBe(messages);
  });
});
