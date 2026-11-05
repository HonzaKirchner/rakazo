import type { MessageBlock } from "@rakazo/contracts";

/** Longest final reply kept from a remote agent. */
export const CLOUD_AGENT_SUMMARY_MAX = 20_000;

export function cloudAgentHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
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

/** The newest cloud agent still running in these messages. It is pinned above the composer. */
export function runningCloudAgent(
  messages: readonly { blocks?: readonly MessageBlock[] }[],
): CloudAgentBlock | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const blocks = messages[m]?.blocks ?? [];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block?.kind === "cloud_agent" && block.status === "running") return block;
    }
  }
  return undefined;
}

/** The messages without the pinned agent's card, dropping any message it leaves empty. */
export function withoutCloudAgent<M extends { blocks: readonly MessageBlock[] }>(
  messages: M[],
  agentId: string | undefined,
): M[] {
  if (agentId === undefined) return messages;
  const isPinned = (block: MessageBlock) =>
    block.kind === "cloud_agent" && block.agentId === agentId;
  if (!messages.some((message) => message.blocks.some(isPinned))) return messages;
  return messages.flatMap((message) => {
    if (!message.blocks.some(isPinned)) return [message];
    const blocks = message.blocks.filter((block) => !isPinned(block));
    return blocks.length ? [{ ...message, blocks }] : [];
  });
}
