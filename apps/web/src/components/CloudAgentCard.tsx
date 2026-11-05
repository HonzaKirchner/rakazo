import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ArrowUpRight, Ban, Check, Clock, GitPullRequest, LoaderCircle, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Shimmer } from "./ai/primitives";

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

const STATUS_STYLE = {
  running: { icon: LoaderCircle, tile: "bg-foreground text-background", bar: "" },
  finished: { icon: Check, tile: "bg-success/15 text-success", bar: "bg-success" },
  failed: { icon: X, tile: "bg-destructive/15 text-destructive", bar: "bg-destructive" },
  cancelled: { icon: Ban, tile: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/40" },
  expired: { icon: Clock, tile: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/40" },
} as const;

// The share of the line that fades at its end while the title overflows (mask from 85%).
const EDGE_FADE = 0.15;

/** One line of text that scrolls to show its hidden end while the card is hovered. */
function MarqueeLine({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const box = outer.current;
    const text = inner.current;
    if (!box || !text) return;
    const measure = () => {
      const overflow = text.scrollWidth - box.clientWidth;
      // Scroll the end clear of the edge's fade, so the last word is seen whole.
      const distance = overflow > 0 ? overflow + box.clientWidth * EDGE_FADE : 0;
      setShift(getComputedStyle(text).direction === "rtl" ? distance : -distance);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);
  return (
    <span
      ref={outer}
      className={cn(
        "block min-w-0 overflow-hidden whitespace-nowrap",
        shift !== 0 && "mask-r-from-85% rtl:mask-l-from-85%",
        className,
      )}
    >
      <span
        ref={inner}
        dir="auto"
        className={cn("inline-block", shift !== 0 && "rk-marquee")}
        style={
          shift !== 0
            ? ({
                "--rk-marquee-shift": `${shift}px`,
                "--rk-marquee-duration": `${Math.max(3, Math.abs(shift) / 30)}s`,
              } as CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </span>
  );
}

// Live updates replace the block, so remember open cards by agent id across them.
const openAgents = new Set<string>();

// The reply and the launch details unfold together, at one pace.
const EXPAND_MOTION = "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]";
// Two lines of the preview's text (14.5px at 1.5 line height) while the card is folded.
const PREVIEW_HEIGHT = 2 * 14.5 * 1.5;

/**
 * The agent's final reply, or its prompt until there is one. Folded, its first two lines fade
 * out and a click opens the card; opening grows it to its full height.
 */
function CardPreview({
  open,
  onOpen,
  testId,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  testId: string;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [fullHeight, setFullHeight] = useState<number>();
  // Only changes after the first measurement animate, so a card never folds itself on mount.
  const [animate, setAnimate] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setFullHeight(element.offsetHeight);
    measure();
    const frame = requestAnimationFrame(() => setAnimate(true));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const overflows = (fullHeight ?? 0) > PREVIEW_HEIGHT;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the title button opens the card for keyboard and screen readers.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above.
    <div
      data-testid={testId}
      onClick={open ? undefined : onOpen}
      className={cn(
        "relative mx-4 mb-4 overflow-hidden",
        animate && ["transition-[height] motion-reduce:transition-none", EXPAND_MOTION],
        !open && "cursor-pointer",
      )}
      style={{
        height: open ? fullHeight : Math.min(fullHeight ?? PREVIEW_HEIGHT, PREVIEW_HEIGHT),
      }}
    >
      <div
        ref={content}
        className={cn("text-[14.5px] leading-[1.5]", !open && "pointer-events-none")}
      >
        {children}
      </div>
      {overflows ? (
        // Rides the bottom edge as the reply grows, dissolving before the reply settles.
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-card from-10% via-card/70 via-45% to-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none",
            open ? "opacity-0" : "opacity-100",
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * A cloud agent's card. Folded, it shows the title, status, where the work landed and the start
 * of the agent's final reply. Opened, it shows the whole reply and what it was launched with.
 */
export function CloudAgentCard({ block }: { block: CloudAgentBlock }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(() => openAgents.has(block.agentId));
  const toggle = (next: boolean) => {
    if (next) openAgents.add(block.agentId);
    else openAgents.delete(block.agentId);
    setOpen(next);
  };
  const prHref = cloudAgentHttpsUrl(block.prUrl);
  const agentHref = cloudAgentHttpsUrl(block.url);
  const running = block.status === "running";
  // The prompt shows as the preview until there is a reply, so it only repeats beside one.
  const hasDetails = Boolean(
    (block.prompt && block.summary) || block.repository || block.openPr || block.imageCount,
  );
  const status = STATUS_STYLE[block.status];
  const StatusIcon = status.icon;
  const statusLabel =
    block.status === "running" ? (
      <Shimmer>
        <Trans>running</Trans>
      </Shimmer>
    ) : block.status === "finished" ? (
      <span className="text-success">
        <Trans>finished</Trans>
      </span>
    ) : block.status === "failed" ? (
      <span className="text-destructive">
        <Trans>failed</Trans>
      </span>
    ) : block.status === "cancelled" ? (
      <Trans>cancelled</Trans>
    ) : (
      <Trans>expired</Trans>
    );
  return (
    <div
      className={cn(
        "rk-marquee-host group/agent relative w-xl max-w-full overflow-hidden rounded-2xl bg-card text-sm text-card-foreground ring-1",
        running
          ? "shadow-xl shadow-foreground/10 ring-foreground/20"
          : "shadow-lg shadow-foreground/5 ring-foreground/10",
      )}
      data-testid="cloud-agent-card"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
        {running ? (
          <span className="rk-indeterminate absolute inset-y-0 w-2/5 bg-foreground" />
        ) : (
          <span className={cn("absolute inset-0", status.bar)} />
        )}
      </span>
      <Collapsible open={open} onOpenChange={toggle}>
        {/* The title's button covers the whole header; the links sit above it. */}
        <div className="relative flex items-center gap-3 px-4 pt-4 pb-3">
          <span
            aria-hidden
            className={cn("grid size-10 shrink-0 place-items-center rounded-xl", status.tile)}
          >
            <StatusIcon
              className={cn("size-5", running && "animate-spin motion-reduce:animate-none")}
              strokeWidth={2.25}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <CollapsibleTrigger className="min-w-0 cursor-pointer rounded-md text-start outline-none after:absolute after:inset-0 focus-visible:ring-3 focus-visible:ring-ring/50">
              <MarqueeLine className="text-[15px] font-semibold tracking-tight">
                {block.title}
              </MarqueeLine>
            </CollapsibleTrigger>
            <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <span className="shrink-0 font-medium">{statusLabel}</span>
              {prHref || block.branch ? (
                <>
                  <span aria-hidden>·</span>
                  {prHref ? (
                    <a
                      href={prHref}
                      target="_blank"
                      rel="noreferrer"
                      className="relative z-10 flex min-w-0 items-center gap-1 rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <GitPullRequest aria-hidden className="size-3.5 shrink-0" />
                      <Trans>Pull request</Trans>
                    </a>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[12px]" dir="auto">
                      {block.branch}
                    </span>
                  )}
                </>
              ) : null}
            </span>
          </span>
          {agentHref ? (
            <a
              href={agentHref}
              target="_blank"
              rel="noreferrer"
              aria-label={t`Open cloud agent`}
              className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ArrowUpRight aria-hidden className="size-4" />
            </a>
          ) : null}
        </div>
        {block.summary ? (
          <CardPreview open={open} onOpen={() => toggle(true)} testId="cloud-agent-summary">
            <ChatMarkdown>{block.summary}</ChatMarkdown>
          </CardPreview>
        ) : block.prompt ? (
          // Until the agent replies, its prompt says what it is working on.
          <CardPreview open={open} onOpen={() => toggle(true)} testId="cloud-agent-prompt">
            <p className="whitespace-pre-wrap break-words text-foreground/80" dir="auto">
              {block.prompt}
            </p>
          </CardPreview>
        ) : null}
        {hasDetails ? (
          <CollapsibleContent className={EXPAND_MOTION}>
            {/* Padding lives inside the panel so it folds all the way to nothing. */}
            <div className="flex flex-col gap-3 border-t border-border px-4 pt-3 pb-4">
              <dl className="grid gap-2 text-[13px]">
                {block.prompt && block.summary ? (
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
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </div>
  );
}
