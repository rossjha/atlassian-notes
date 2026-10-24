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

export function normalizeSiteUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function renderEnvFile(v: SetupValues): string {
  const lines = [
    "# Written by `npm run setup`. Keep this file private (mode 600).",
    `JIRA_BASE_URL=${v.baseUrl}`,
  ];
  if (v.cloudId) lines.push(`JIRA_CLOUD_ID=${v.cloudId}`);
  lines.push(
    `JIRA_EMAIL=${v.email}`,
    `JIRA_API_TOKEN=${v.token}`,
    `JIRA_PROJECT=${v.project}`,
    `NOTES_DIR=${v.notesDir}`,
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
  const res = await fetch(`${siteUrl}/_edge/tenant_info`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${siteUrl}/_edge/tenant_info`);
  const body = (await res.json()) as { cloudId?: string };
  if (!body.cloudId) throw new Error("No cloudId in the response");
  return body.cloudId;
}

async function main(): Promise<void> {
  const target = envFilePath(process.env, os.homedir());
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
  async function askHidden(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await rl.question("");
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  }
  try {
    if (existsSync(target)) {
      const a = (await rl.question(`${target} already exists. Overwrite? [y/N] `)).trim().toLowerCase();
      if (a !== "y" && a !== "yes") {
        console.log("Left the existing file untouched.");
        return;
      }
    }
    const baseUrl = normalizeSiteUrl(await rl.question("Jira site URL (e.g. https://acme.atlassian.net): "));
    if (!baseUrl) throw new Error("A site URL is required.");
    const email = (await rl.question("Atlassian account email: ")).trim();
    const token = (await askHidden("API token (input hidden): ")).trim();
    const scoped = /^y/i.test((await rl.question("Is this a scoped API token? [y/N] ")).trim());
    let cloudId: string | undefined;
    if (scoped) {
      cloudId = await fetchCloudId(baseUrl);
      console.log(`Found cloud id ${cloudId}`);
    }
    const project = (await rl.question("Default project key (e.g. PAY): ")).trim().toUpperCase();
    const notesDir =
      (await rl.question("Notes folder [~/atlassian-notes-data]: ")).trim() || "~/atlassian-notes-data";
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
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
