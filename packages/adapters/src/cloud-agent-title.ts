import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { escapePromptData } from "@rakazo/core";
import { recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { JEV_AUTO_REVIEW_PROVIDER, SCRIPTED_AUTO_REVIEW_PROVIDER } from "./auto-review.js";
import { promptTitle } from "./cloud-agent-service.js";
import { decisionModel } from "./decision-models.js";
import { findConnectedModelCredential } from "./model-selection.js";
import type { RunContext } from "./run-context.js";
import { resolvedModelRunFields, resolveModelKey } from "./run-model.js";

const MAX_TITLE_CHARS = 80;
const MAX_PROMPT_CHARS = 4_000;
const TIMEOUT_MS = 8_000;

/** One plain line from a model's reply, without quotes, markdown or a trailing period. */
export function cleanCloudAgentTitle(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  const title = line
    ?.replace(/^(?:#+\s*|[-*]\s+)?(?:title:\s*)?/i, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/\.$/, "")
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return title || undefined;
}

/**
 * A short title for a cloud agent's prompt, written by the space's approval model, the cheap
 * one picked for quick checks. Falls back to the prompt's first line when none can run.
 */
export async function cloudAgentTitle(ctx: RunContext, prompt: string): Promise<string> {
  const fallback = promptTitle(prompt);
  try {
    const role = await ctx.trust.loadApprovalModel();
    const choice = [
      ...(role.primary ? [role.primary] : []),
      ...role.backups,
    ].find(
      (row) =>
        row.provider !== JEV_AUTO_REVIEW_PROVIDER &&
        row.provider !== SCRIPTED_AUTO_REVIEW_PROVIDER &&
        !decisionModel(row.provider, row.modelId),
    );
    if (!choice) return fallback;
    return (await writeTitle(ctx, choice, prompt)) ?? fallback;
  } catch (error) {
    getLogger().warn("cloud agent title fell back to the prompt", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return fallback;
  }
}

async function writeTitle(
  ctx: RunContext,
  choice: { provider: string; modelId: string; credentialId?: string; thinkingLevel?: unknown },
  prompt: string,
): Promise<string | undefined> {
  const { deps, run, runId, bot, thread } = ctx;
  const scope = { userId: run.userId, spaceId: run.spaceId };
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    scope,
    choice.provider,
    choice.modelId,
    { credentialId: choice.credentialId },
  );
  const resolved = await resolveModelKey(
    deps,
    run.userId,
    run.spaceId,
    credential,
    choice.provider,
    choice.modelId,
    (values) => ctx.secrets.push(...values),
  );
  const operationId = `cloud-agent-title:${runId}`;
  const signal = AbortSignal.any([ctx.context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      ...scope,
      botId: bot.id,
      parentRunId: runId,
      runId,
      operationId,
      operationKind: "setup",
    });
  let text = "";
  for await (const event of deps.runtime.run(
    {
      botId: bot.id,
      threadId: thread.id,
      runId: `${runId}:cloud-agent-title`,
      usageOperationKind: "setup",
      onUsage: async (event) => {
        await onUsage(event);
      },
      prompt: `<task>${escapePromptData(prompt.slice(0, MAX_PROMPT_CHARS))}</task>`,
      instructions: [
        "Name the goal of the coding task in <task> for a card title.",
        "Leave out details such as the repository, files, branches and steps.",
        "Reply with the title only: at most 5 words, plain text, no quotes, no period.",
        "Write it in the task's language.",
      ].join(" "),
      history: [],
      tools: [],
      model: {
        provider: choice.provider,
        id: choice.modelId,
        ...resolvedModelRunFields(resolved),
        thinkingLevel: null,
      },
    },
    { operationId, traceId: operationId, spaceId: run.spaceId, userId: run.userId, signal },
  )) {
    if (event.type === "usage" && !event.accounted) await onUsage(event);
    if (event.type === "done" && event.text) text = event.text;
  }
  // The runtime reports a failed call as reply text; never show that as a title.
  if (/^(?:I hit a problem:|Unknown model )/i.test(text.trim())) return undefined;
  return cleanCloudAgentTitle(text);
}
