import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface Config {
  jiraBaseUrl: string;
  jiraApiBase: string;
  jiraEmail: string;
  jiraApiToken: string;
  defaultProject: string;
  notesDir: string;
  refreshMinutes: number;
  port: number;
  /** Address the server listens on: loopback unless set (the Docker image sets 0.0.0.0). */
  host: string;
  openBrowser: boolean;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

const KEYS = [
  "JIRA_BASE_URL",
  "JIRA_CLOUD_ID",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT",
  "NOTES_DIR",
  "REFRESH_MINUTES",
  "PORT",
  "HOST",
  "OPEN_BROWSER",
];
const REQUIRED = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT"];

export function apiBaseFor(siteUrl: string, cloudId?: string): string {
  return cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : siteUrl;
}

export function envFilePath(env: Env, home: string): string {
  return env.ATLASSIAN_NOTES_ENV || join(home, ".config", "atlassian-notes", ".env");
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadConfig(
  env: Env,
  home: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Config {
  const path = envFilePath(env, home);
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (!REQUIRED.every((k) => env[k])) {
      throw new ConfigError(
        `Config file not found at ${path}. Run \`npm run setup\` to create it.`,
        REQUIRED.filter((k) => !env[k]),
      );
    }
  }
  const v: Record<string, string | undefined> = {};
  for (const k of KEYS) v[k] = env[k] || fileValues[k] || undefined;

  const missing = REQUIRED.filter((k) => !v[k]);
  if (missing.length) {
    throw new ConfigError(
      `Missing ${missing.join(", ")} in ${path}. Run \`npm run setup\` or edit that file.`,
      missing,
    );
  }
  const jiraBaseUrl = v.JIRA_BASE_URL!.replace(/\/+$/, "");
  const notesDir = expandHome(v.NOTES_DIR ?? "~/atlassian-notes-data", home);
  if (!isAbsolute(notesDir)) {
    throw new ConfigError(`NOTES_DIR must be an absolute path or start with ~/ (got "${notesDir}") in ${path}.`);
  }
  return {
    jiraBaseUrl,
    jiraApiBase: apiBaseFor(jiraBaseUrl, v.JIRA_CLOUD_ID),
    jiraEmail: v.JIRA_EMAIL!,
    jiraApiToken: v.JIRA_API_TOKEN!,
    defaultProject: v.JIRA_PROJECT!,
    notesDir,
    refreshMinutes: positiveInt(v.REFRESH_MINUTES, 15),
    port: positiveInt(v.PORT, 4317),
    host: v.HOST ?? "127.0.0.1",
    openBrowser: !["false", "0", "no"].includes((v.OPEN_BROWSER ?? "true").toLowerCase()),
  };
}
