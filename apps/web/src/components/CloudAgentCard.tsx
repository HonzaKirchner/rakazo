import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Shimmer } from "./ai/primitives";

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

function RunningDot() {
  return (
    <span aria-hidden className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-foreground" />
    </span>
  );
}

function CloudAgentLink({ href, children }: { href?: string; children: React.ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block max-w-full no-underline">
      {children}
    </a>
  ) : (
    children
  );
}

// Live updates replace the block, so remember open cards by agent id across them.
const openAgents = new Set<string>();

/**
 * A cloud agent's card. Folded, it shows the title, status and where the work landed. The
 * header opens it to the agent's final reply and what it was launched with.
 */
export function CloudAgentCard({ block }: { block: CloudAgentBlock }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(() => openAgents.has(block.agentId));
  const prHref = cloudAgentHttpsUrl(block.prUrl);
  const href = prHref ?? cloudAgentHttpsUrl(block.url);
  const running = block.status === "running";
  return (
    <Card
      size="sm"
      className={cn(
        "w-96 max-w-full transition-shadow",
        running && "shadow-md ring-2 ring-foreground/25",
      )}
      data-testid="cloud-agent-card"
    >
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          if (next) openAgents.add(block.agentId);
          else openAgents.delete(block.agentId);
          setOpen(next);
        }}
      >
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-start justify-between gap-3 rounded-md text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className={cn("min-w-0 font-medium", running && "text-base")} dir="auto">
                {block.title}
              </span>
              <span className="flex shrink-0 items-center gap-2 pt-0.5">
                {running ? (
                  <span className="flex items-center gap-2 text-[13px]">
                    <RunningDot />
                    <Shimmer>
                      <Trans>running</Trans>
                    </Shimmer>
                  </span>
                ) : (
                  <Badge
                    variant="secondary"
                    className={
                      block.status === "failed"
                        ? "text-destructive"
                        : block.status === "finished"
                          ? "text-success"
                          : "text-muted-foreground"
                    }
                  >
                    {block.status === "finished" ? (
                      <Trans>finished</Trans>
                    ) : block.status === "cancelled" ? (
                      <Trans>cancelled</Trans>
                    ) : block.status === "expired" ? (
                      <Trans>expired</Trans>
                    ) : (
                      <Trans>failed</Trans>
                    )}
                  </Badge>
                )}
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
                    open && "rotate-180",
                  )}
                />
              </span>
            </CollapsibleTrigger>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={prHref ? t`Open pull request` : t`Open cloud agent`}
                className="shrink-0 rounded-md p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ExternalLink aria-hidden className="size-4" />
              </a>
            ) : null}
          </div>
          {prHref ? (
            <span className="text-muted-foreground">
              <Trans>Pull request</Trans>
            </span>
          ) : block.branch ? (
            <span className="font-mono text-[12px] text-muted-foreground" dir="auto">
              {block.branch}
            </span>
          ) : null}
          <CollapsibleContent className="flex flex-col gap-3 pt-1">
            {block.summary ? (
              <div data-testid="cloud-agent-summary" className="text-[14.5px] leading-[1.5]">
                <ChatMarkdown>{block.summary}</ChatMarkdown>
              </div>
            ) : null}
            <dl className="grid gap-2 text-[13px]">
              {block.prompt ? (
                <div>
                  <dt className="text-muted-foreground">
                    <Trans>Prompt</Trans>
                  </dt>
                  <dd className="whitespace-pre-wrap break-words" dir="auto">
                    {block.prompt}
                  </dd>
                </div>
              ) : null}
              {block.repository ? (
                <div>
                  <dt className="text-muted-foreground">
                    <Trans>Repository</Trans>
                  </dt>
                  <dd className="font-mono text-[12px] break-all">{block.repository}</dd>
                </div>
              ) : null}
              {block.openPr ? (
                <div>
                  <dt className="text-muted-foreground">
                    <Trans>Opens a pull request</Trans>
                  </dt>
                </div>
              ) : null}
              {block.imageCount ? (
                <div>
                  <dt className="text-muted-foreground">
                    <Trans>Images</Trans>
                  </dt>
                  <dd>{block.imageCount}</dd>
                </div>
              ) : null}
            </dl>
          </CollapsibleContent>
        </CardContent>
      </Collapsible>
    </Card>
  );
}

/** The running cloud agent, kept above the composer while the transcript scrolls. */
export function PinnedCloudAgent({ block }: { block: CloudAgentBlock }) {
  const href = cloudAgentHttpsUrl(block.url);
  return (
    <div className="pointer-events-auto px-3 pb-2 md:px-[max(1.5rem,calc((100%_-_60rem)/2))]">
      <CloudAgentLink href={href}>
        <div
          role="status"
          data-testid="pinned-cloud-agent"
          className="flex min-w-0 items-center gap-3 rounded-full bg-card px-4 py-2.5 text-sm text-card-foreground shadow-md ring-2 ring-foreground/25 transition-shadow hover:ring-foreground/40"
        >
          <RunningDot />
          <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
            {block.title}
          </span>
          {block.branch ? (
            <span
              dir="auto"
              className="hidden max-w-48 truncate font-mono text-[12px] text-muted-foreground sm:inline"
            >
              {block.branch}
            </span>
          ) : null}
          <span className="shrink-0 text-[13px]">
            <Shimmer>
              <Trans>running</Trans>
            </Shimmer>
          </span>
        </div>
      </CloudAgentLink>
    </div>
  );
}
