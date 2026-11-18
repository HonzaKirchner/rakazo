import type { MessageBlock } from "@rakazo/contracts";

/**
 * A running cloud agent's spinner: a star that blooms and folds back, one glyph per tick.
 * U+FE0E keeps ✳ a text glyph instead of an emoji.
 */
const SPARK_GLYPHS = ["·", "✢", "✳︎", "✶", "✻", "✽"];
export const CLOUD_AGENT_SPARK_FRAMES = [...SPARK_GLYPHS, ...SPARK_GLYPHS.slice(1, -1).reverse()];
export const CLOUD_AGENT_SPARK_TICK_MS = 160;
/** The glyph shown in place of the animation when motion is reduced. */
export const CLOUD_AGENT_SPARK_STILL = "✻";

/** Longest final reply kept from a remote agent. */
export const CLOUD_AGENT_SUMMARY_MAX = 20_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A link safe to show: https, or plain http to this machine, where a local provider serves. */
export function cloudAgentHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const safe =
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    return safe && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

export function cloudAgentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "cloud_agent" }> {
  const status = payload.status;
  return {
    kind: "cloud_agent",
    agentId: String(payload.agentId ?? ""),
    title: String(payload.title ?? "Cloud agent"),
    status:
      status === "finished" || status === "failed" || status === "cancelled" || status === "expired"
        ? status
        : "running",
    url: cloudAgentHttpsUrl(String(payload.url ?? "")) ?? "",
    ...(payload.branch ? { branch: String(payload.branch) } : {}),
    ...(cloudAgentHttpsUrl(String(payload.prUrl ?? "")) ? { prUrl: String(payload.prUrl) } : {}),
    ...(payload.latestRunId ? { latestRunId: String(payload.latestRunId) } : {}),
    ...(typeof payload.prompt === "string" && payload.prompt ? { prompt: payload.prompt } : {}),
    ...(cloudAgentHttpsUrl(String(payload.repository ?? ""))
      ? { repository: String(payload.repository) }
      : {}),
    ...(typeof payload.openPr === "boolean" ? { openPr: payload.openPr } : {}),
    ...(typeof payload.imageCount === "number" && payload.imageCount > 0
      ? { imageCount: payload.imageCount }
      : {}),
    ...(typeof payload.summary === "string" && payload.summary
      ? { summary: payload.summary.slice(0, CLOUD_AGENT_SUMMARY_MAX) }
      : {}),
  };
}

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

/**
 * Whether the agent is still being placed: launched here, but the provider has not taken it
 * yet, so it has neither a run nor anywhere to be followed.
 */
export function cloudAgentStarting(block: CloudAgentBlock): boolean {
  return block.status === "running" && !block.latestRunId && !block.url;
}

/** The newest cloud agent still running in these messages, with its message. Its card stays in view. */
export function runningCloudAgent<M extends { blocks?: readonly MessageBlock[] }>(
  messages: readonly M[],
): { message: M; block: CloudAgentBlock } | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    const blocks = message?.blocks ?? [];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (message && block?.kind === "cloud_agent" && block.status === "running") {
        return { message, block };
      }
    }
  }
  return undefined;
}
