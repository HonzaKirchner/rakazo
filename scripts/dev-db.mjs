#!/usr/bin/env node
// `pnpm db:up`: make the Postgres in `.env`'s DATABASE_MIGRATION_URL ready for `pnpm dev`.
//
// Reuses the server when it already accepts that login. Otherwise starts a `rakazo-dev-db`
// container with the URL's user, password, and port. Then creates the URL's database if it is
// missing and applies migrations, which also provisions the runtime login from DATABASE_URL.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm } from "./pnpm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "packages/db/package.json"));
const { Client } = require("pg");
const dotenv = require("dotenv");

const CONTAINER = "rakazo-dev-db";
const IMAGE = "postgres:16";

const envFile = path.join(root, ".env");
const fileEnv = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
const setting = (name) => process.env[name] ?? fileEnv[name];
const migrationUrl = setting("DATABASE_MIGRATION_URL");
if (!migrationUrl) throw new Error("Set DATABASE_MIGRATION_URL in .env first.");

const target = new URL(migrationUrl);
const database = decodeURIComponent(target.pathname.slice(1)) || "rakazo";
const server = new URL(migrationUrl);
server.pathname = "/postgres";
const log = (message) => process.stdout.write(`[db] ${message}\n`);

async function connect(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
}

async function startContainer() {
  const exists = docker("ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}");
  if (exists) {
    log(`Starting ${CONTAINER}`);
    docker("start", CONTAINER);
  } else {
    log(`Creating ${CONTAINER} (${IMAGE}) on 127.0.0.1:${server.port || 5432}`);
    docker(
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      `POSTGRES_USER=${decodeURIComponent(server.username)}`,
      "-e",
      `POSTGRES_PASSWORD=${decodeURIComponent(server.password)}`,
      "-p",
      `127.0.0.1:${server.port || 5432}:5432`,
      "-v",
      `${CONTAINER}:/var/lib/postgresql/data`,
      IMAGE,
    );
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = await connect(server.href);
    if (client) return client;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${CONTAINER} did not accept ${server.username}@${server.host} in time.`);
}

let admin = await connect(server.href);
if (admin) log(`Using the Postgres already on ${server.host}`);
else admin = await startContainer();

try {
  const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (!found.rowCount) {
    log(`Creating database ${database}`);
    await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
  }
} finally {
  await admin.end();
}

runPnpm(["--filter", "@rakazo/db", "generate"], { cwd: root, stdio: "inherit" });
runPnpm(["db:migrate"], { cwd: root, stdio: "inherit" });
log(`Ready: ${target.username}@${target.host}/${database}`);
