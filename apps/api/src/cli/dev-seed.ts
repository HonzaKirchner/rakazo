// `pnpm db:seed`: with `pnpm dev` running, fill a dev account with Spaces, bots, and chats whose
// cloud agent cards cover every state, for working on the UI.
//
// The account, Spaces, and bots go through the running app's API, so they get the same defaults
// and validation as the UI. Messages and cloud agents are written to the database directly: the
// agents use a provider key no connection has, so the worker never polls them and each card
// keeps the state it is seeded with. Safe to run again; existing pieces are kept.
//
// Reads SEED_EMAIL, SEED_PASSWORD, SEED_NAME, and SEED_URL (default BETTER_AUTH_URL) from `.env`.
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, createThreadMessage, databaseUrls } from "@rakazo/db";

loadRootEnv();

const SEED_PROVIDER_KEY = "dev-seed";
const REPOSITORY = "https://git.example.com/acme/storefront";

type AgentStatus = "running" | "finished" | "failed" | "cancelled" | "expired";

interface AgentSeed {
  key: string;
  ask: string;
  title: string;
  prompt: string;
  status: AgentStatus;
  repository?: string;
  openPr?: boolean;
  branch?: string;
  pr?: number;
  imageCount?: number;
  summary?: string;
  /** The bot's reply after the card, when the run has settled. */
  after?: string;
}

interface ChatSeed {
  key: string;
  messages: { role: "user" | "bot"; text: string }[];
}

interface BotSeed {
  name: string;
  title: string;
  description: string;
  chats?: ChatSeed[];
  agents?: AgentSeed[];
}

interface SpaceSeed {
  /** Null is the account's default Space. */
  name: string | null;
  bots: BotSeed[];
}

const SPACES: SpaceSeed[] = [
  {
    name: null,
    bots: [
      {
        name: "Chief",
        title: "Chief of staff",
        description: "Keeps track of what is going on and hands work to the right bot.",
        chats: [
          {
            key: "welcome",
            messages: [
              { role: "user", text: "What's on my plate this week?" },
              {
                role: "bot",
                text: "Three things:\n\n1. **Checkout redesign**: Coder has a pull request open for review.\n2. **Pricing page copy**: Writer is waiting on the final numbers.\n3. **Customer interviews**: Researcher has notes from four of six calls.",
              },
            ],
          },
        ],
        agents: [
          {
            key: "typo",
            ask: "Can you fix the typo in the footer? It says 'Copyrigth'.",
            title: "Fix the footer copyright typo",
            prompt: "Fix the typo 'Copyrigth' in the site footer and open a pull request.",
            status: "finished",
            repository: REPOSITORY,
            openPr: true,
            branch: "fix/footer-typo",
            pr: 118,
            summary: "Fixed the spelling in `Footer.tsx` and updated the snapshot test.",
            after: "Done. The pull request fixes the footer and its snapshot test.",
          },
        ],
      },
    ],
  },
  {
    name: "Engineering",
    bots: [
      {
        name: "Coder",
        title: "Software engineer",
        description: "Ships code changes through cloud coding agents.",
        agents: [
          {
            key: "checkout",
            ask: "Redesign the checkout summary so totals line up and discounts show per line.",
            title: "Redesign the checkout summary",
            prompt: [
              "Redesign the checkout order summary:",
              "",
              "- Right-align every amount so the totals line up.",
              "- Show each discount on the line it applies to, not only in the total.",
              "- Keep the existing tests passing and add one for per-line discounts.",
            ].join("\n"),
            status: "finished",
            repository: REPOSITORY,
            openPr: true,
            branch: "feat/checkout-summary",
            pr: 214,
            summary: [
              "Reworked the order summary in `CheckoutSummary.tsx`.",
              "",
              "- Amounts use tabular numbers and are right-aligned in a two-column grid.",
              "- Discounts render under the line they apply to, with the original price struck through.",
              "- Added `checkout-summary.test.tsx` covering per-line and order-wide discounts.",
              "",
              "All 312 tests pass.",
            ].join("\n"),
            after:
              "The pull request is ready for review. Totals line up and discounts show per line.",
          },
          {
            key: "flaky",
            ask: "The search tests fail about one run in ten. Find out why.",
            title: "Find the flaky search test",
            prompt: "Find why the search tests fail intermittently and fix the root cause.",
            status: "failed",
            repository: REPOSITORY,
            openPr: false,
            summary:
              "I could not reproduce the failure in 50 runs. The test environment has no network access, so I could not install the pinned browser either.",
            after:
              "That one didn't work out: the agent couldn't reproduce the failure. Want me to try with more logging?",
          },
          {
            key: "rename",
            ask: "Rename `userId` to `accountId` across the billing module.",
            title: "Rename userId to accountId in billing",
            prompt: "Rename `userId` to `accountId` across the billing module and its tests.",
            status: "cancelled",
            repository: REPOSITORY,
            openPr: true,
          },
          {
            key: "dark-mode",
            ask: "Add dark mode to the storefront. Here are the two mockups.",
            title: "Add dark mode to the storefront",
            prompt: [
              "Add a dark theme to the storefront that follows the system setting.",
              "",
              "Use the attached mockups for colors. Keep contrast at WCAG AA.",
            ].join("\n"),
            status: "running",
            repository: REPOSITORY,
            openPr: true,
            imageCount: 2,
          },
        ],
      },
      {
        name: "Reviewer",
        title: "Code reviewer",
        description: "Reviews changes and follows up on the findings.",
        agents: [
          {
            key: "audit",
            ask: "Audit the dependencies for anything unmaintained.",
            title: "Audit unmaintained dependencies",
            prompt: "List dependencies with no release in two years and suggest replacements.",
            status: "expired",
            repository: REPOSITORY,
          },
          {
            key: "perf",
            ask: "Why is the product page slow on first load?",
            title: "Profile the product page first load",
            prompt:
              "Profile the product page's first load and push fixes to a branch. No pull request.",
            status: "finished",
            repository: REPOSITORY,
            openPr: false,
            branch: "perf/product-page",
            summary: [
              "## What was slow",
              "",
              "The hero image was 2.4 MB and blocked the largest paint. The reviews widget also loaded its full bundle up front.",
              "",
              "## What I changed",
              "",
              "1. Serve the hero as responsive AVIF with a `srcset`.",
              "2. Lazy-load the reviews widget when it scrolls into view:",
              "",
              "```tsx",
              'const Reviews = lazy(() => import("./Reviews"));',
              "```",
              "",
              "Largest paint dropped from 3.8 s to 1.6 s on a throttled connection.",
            ].join("\n"),
            after: "The fixes are on `perf/product-page`. First load is more than twice as fast.",
          },
        ],
      },
    ],
  },
  {
    name: "Product",
    bots: [
      {
        name: "Researcher",
        title: "User researcher",
        description: "Runs and summarizes customer interviews.",
        chats: [
          {
            key: "interviews",
            messages: [
              { role: "user", text: "Summarize the customer interviews so far." },
              {
                role: "bot",
                text: "Four interviews in. The common thread: people abandon checkout when shipping costs appear late. Two asked for saved carts.",
              },
            ],
          },
        ],
      },
      {
        name: "Writer",
        title: "Copywriter",
        description: "Drafts product and marketing copy.",
        chats: [
          {
            key: "pricing",
            messages: [
              { role: "user", text: "Draft a headline for the pricing page." },
              { role: "bot", text: "**Pay for what you ship.** Plans that grow with your store." },
            ],
          },
        ],
      },
    ],
  },
];

const env = process.env;
const base = new URL(env.SEED_URL || env.BETTER_AUTH_URL || "http://127.0.0.1:5173");
const email = env.SEED_EMAIL;
const password = env.SEED_PASSWORD;
if (!email || !password) throw new Error("Set SEED_EMAIL and SEED_PASSWORD in .env first.");
const log = (message: string) => process.stdout.write(`[seed] ${message}\n`);

let cookie = "";
async function post(route: string, body: unknown, spaceId?: string) {
  const response = await fetch(new URL(route, base), {
    method: "POST",
    // Better Auth checks the origin of credential requests.
    headers: {
      "content-type": "application/json",
      origin: base.origin,
      cookie,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify(body),
  }).catch((error: Error) => {
    throw new Error(`Could not reach ${base.origin}. Is \`pnpm dev\` running? (${error.message})`);
  });
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  if (cookies.length) cookie = cookies.join("; ");
  return {
    response,
    body: (await response.json().catch(() => null)) as Record<string, any> | null,
  };
}

async function rpc<T>(procedure: string, input?: unknown, spaceId?: string): Promise<T> {
  const { response, body } = await post(`/rpc/${procedure}`, { json: input }, spaceId);
  if (!response.ok || body?.error) {
    throw new Error(`${procedure} ${response.status}: ${body?.error?.message ?? "failed"}`);
  }
  return body?.json as T;
}

async function signIn() {
  const signup = await post("/api/auth/sign-up/email", {
    email,
    password,
    name: env.SEED_NAME || "Dev",
  });
  if (signup.response.ok) return log(`Created ${email}`);
  const signin = await post("/api/auth/sign-in/email", { email, password });
  if (!signin.response.ok) {
    throw new Error(
      `Sign-up ${signup.response.status} and sign-in ${signin.response.status}: ${
        signin.body?.message ?? signup.body?.message ?? "failed"
      }`,
    );
  }
  log(`Signed in as existing ${email}`);
}

interface SpaceRow {
  id: string;
  name: string;
  isDefault: boolean;
}

interface BotRow {
  id: string;
  name: string;
  threadId: string;
}

await signIn();
if (!cookie) throw new Error("The auth API returned no session. Email verification may be on.");

const { prisma } = createDb(databaseUrls(env).migrationUrl, { applicationName: "dev-seed" });
const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

try {
  const { spaces } = await rpc<{ spaces: SpaceRow[] }>("spaces/list");
  for (const seed of SPACES) {
    const space =
      spaces.find((row) => (seed.name ? row.name === seed.name : row.isDefault)) ??
      (await rpc<SpaceRow>("spaces/create", { name: seed.name }));
    const bots = await rpc<BotRow[]>("bots/list", undefined, space.id);
    for (const botSeed of seed.bots) {
      const bot =
        bots.find((row) => row.name === botSeed.name) ??
        (await rpc<BotRow>(
          "bots/create",
          {
            name: botSeed.name,
            title: botSeed.title,
            description: botSeed.description,
            instructions: botSeed.description,
            notifyOnFinish: true,
            computerMode: "team",
          },
          space.id,
        ));
      for (const chat of botSeed.chats ?? []) await seedChat(bot, chat);
      for (const agent of botSeed.agents ?? []) {
        await seedAgent({ spaceId: space.id, userId: user.id, bot }, agent);
      }
      log(`${space.name} / ${bot.name}`);
    }
  }
} finally {
  await prisma.$disconnect();
}
log(`Open ${base.origin} and sign in as ${email}`);

async function say(bot: BotRow, role: "user" | "bot", blocks: MessageBlock[]) {
  return createThreadMessage(prisma, {
    threadId: bot.threadId,
    role,
    ...(role === "bot" ? { botId: bot.id } : {}),
    blocks,
  });
}

/** A chat is seeded once: skipped when its first message is already in the thread. */
async function seedChat(bot: BotRow, chat: ChatSeed) {
  const first = JSON.stringify(chat.messages[0]?.text ?? "");
  const existing = await prisma.message.findMany({
    where: { threadId: bot.threadId },
    select: { blocks: true },
  });
  if (existing.some((message) => JSON.stringify(message.blocks).includes(first))) return;
  for (const message of chat.messages) {
    await say(bot, message.role, [{ kind: "text", text: message.text }]);
  }
}

async function seedAgent(scope: { spaceId: string; userId: string; bot: BotRow }, seed: AgentSeed) {
  const { bot } = scope;
  const operationKey = `${SEED_PROVIDER_KEY}:${bot.id}:${seed.key}`;
  if (await prisma.cloudAgent.count({ where: { operationKey } })) return;
  await say(bot, "user", [{ kind: "text", text: seed.ask }]);
  const remoteId = `bc-${seed.key}`;
  const prUrl = seed.pr && seed.repository ? `${seed.repository}/pull/${seed.pr}` : undefined;
  const agent = await prisma.cloudAgent.create({
    data: {
      operationKey,
      providerKey: SEED_PROVIDER_KEY,
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: bot.id,
      threadId: bot.threadId,
      remoteId,
      title: seed.title,
      status: seed.status,
      url: `https://agents.example.com/${remoteId}`,
      branch: seed.branch,
      prUrl,
      summary: seed.summary,
      launchRequest: {
        prompt: seed.prompt,
        ...(seed.repository ? { repository: seed.repository } : {}),
        ...(seed.openPr !== undefined ? { openPr: seed.openPr } : {}),
      },
      launchDispatched: true,
      // Never due: no connection polls the seed key, and this keeps the reconciler off it too.
      nextPollAt: null,
    },
  });
  const card = cloudAgentBlockFromPayload({
    ...agent,
    agentId: agent.id,
    prompt: seed.prompt,
    repository: seed.repository,
    openPr: seed.openPr,
    imageCount: seed.imageCount,
  });
  const message = await say(bot, "bot", [card]);
  await prisma.cloudAgent.update({ where: { id: agent.id }, data: { messageId: message.id } });
  if (seed.after) await say(bot, "bot", [{ kind: "text", text: seed.after }]);
}
