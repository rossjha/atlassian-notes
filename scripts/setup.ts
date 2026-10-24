import { assertNodeVersion } from "../src/server/nodeVersion.ts";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { apiBaseFor, envFilePath } from "../src/server/config.ts";

export { apiBaseFor };

export interface SetupValues {
  baseUrl: string;
  cloudId?: string;
  email: string;
  token: string;
  project: string;
  notesDir: string;
}

export interface SiteUrl {
  origin: string;
  atlassianHost: boolean;
}

/** Parses what the user typed into an https origin; throws on anything unsafe. */
export function parseSiteUrl(input: string): SiteUrl {
  let raw = input.trim();
  if (!raw) throw new Error("A site URL is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${input.trim()}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error("The site URL must use https:// (your email and token are sent to it).");
  }
  return { origin: url.origin, atlassianHost: url.hostname.toLowerCase().endsWith(".atlassian.net") };
}

export function isValidCloudId(id: string): boolean {
  return /^[0-9a-f-]+$/i.test(id);
}

function quoteValue(value: string): string {
  if (!/^\s|\s$|[\s#"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error("Values containing both single and double quotes are not supported.");
}

export function renderEnvFile(v: SetupValues): string {
  const lines = [
    "# Written by `npm run setup`. Keep this file private (mode 600).",
    `JIRA_BASE_URL=${quoteValue(v.baseUrl)}`,
  ];
  if (v.cloudId) lines.push(`JIRA_CLOUD_ID=${quoteValue(v.cloudId)}`);
  lines.push(
    `JIRA_EMAIL=${quoteValue(v.email)}`,
    `JIRA_API_TOKEN=${quoteValue(v.token)}`,
    `JIRA_PROJECT=${quoteValue(v.project)}`,
    `NOTES_DIR=${quoteValue(v.notesDir)}`,
    "# REFRESH_MINUTES=15",
    "# PORT=4317",
    "# OPEN_BROWSER=true",
    "",
  );
  return lines.join("\n");
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

async function fetchCloudId(siteUrl: string): Promise<string> {
  const res = await fetch(`${siteUrl}/_edge/tenant_info`, { redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${siteUrl}/_edge/tenant_info`);
  const body = (await res.json()) as { cloudId?: string };
  if (!body.cloudId || !isValidCloudId(body.cloudId)) throw new Error("Unexpected cloudId in the response");
  return body.cloudId;
}

async function main(): Promise<void> {
  assertNodeVersion();
  const target = envFilePath(process.env, os.homedir());
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
  let finished = false;
  const cancelled = new Promise<never>((_, reject) => {
    rl.on("close", () => {
      if (!finished) reject(new Error("CANCELLED"));
    });
  });
  cancelled.catch(() => {});
  rl.on("SIGINT", () => rl.close());
  const ask = (prompt: string): Promise<string> => Promise.race([rl.question(prompt), cancelled]);
  async function askHidden(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await ask("");
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  }
  try {
    if (existsSync(target)) {
      const a = (await ask(`${target} already exists. Overwrite? [y/N] `)).trim().toLowerCase();
      if (a !== "y" && a !== "yes") {
        console.log("Left the existing file untouched.");
        return;
      }
    }
    const site = parseSiteUrl(await ask("Jira site URL (e.g. https://acme.atlassian.net): "));
    const baseUrl = site.origin;
    if (!site.atlassianHost) {
      console.log(`Warning: ${site.origin} is not an *.atlassian.net address. Your email and token will be sent there.`);
      const go = (await ask("Continue anyway? [y/N] ")).trim().toLowerCase();
      if (go !== "y" && go !== "yes") throw new Error("Setup cancelled.");
    }
    const email = (await ask("Atlassian account email: ")).trim();
    const token = (await askHidden("API token (input hidden): ")).trim();
    const scoped = /^y/i.test((await ask("Is this a scoped API token? [y/N] ")).trim());
    let cloudId: string | undefined;
    if (scoped) {
      cloudId = await fetchCloudId(baseUrl);
      console.log(`Found cloud id ${cloudId}`);
    }
    const project = (await ask("Default project key (e.g. PAY): ")).trim().toUpperCase();
    const notesDir =
      (await ask("Notes folder [~/atlassian-notes-data]: ")).trim() || "~/atlassian-notes-data";
    if (!email || !token || !project) throw new Error("Email, token and project key are required.");

    const dir = dirname(target);
    const dirExisted = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirExisted) chmodSync(dir, 0o700);
    writeFileSync(target, renderEnvFile({ baseUrl, cloudId, email, token, project, notesDir }), { mode: 0o600 });
    chmodSync(target, 0o600);
    console.log(`Wrote ${target}`);

    const res = await fetch(`${apiBaseFor(baseUrl, cloudId)}/rest/api/3/myself`, {
      headers: { Authorization: basicAuth(email, token), Accept: "application/json" },
      redirect: "error",
    });
    if (res.ok) {
      const me = (await res.json()) as { displayName?: string };
      console.log(`Connected as ${me.displayName ?? "(unknown)"}`);
    } else {
      const text = (await res.text()).slice(0, 300);
      console.error(`Jira said HTTP ${res.status}: ${text}`);
      process.exitCode = 1;
    }
  } catch (e) {
    if ((e as Error).message === "CANCELLED") {
      muted = false;
      console.error("\nSetup cancelled.");
      process.exitCode = 130;
    } else {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
  } finally {
    finished = true;
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
