import { assertNodeVersion } from "./nodeVersion.ts";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveEvent } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { BoardService } from "./boardService.ts";
import { ViewCache } from "./cache.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { ensureDataDir, loadColumns, loadViews } from "./configFiles.ts";
import { createJiraClient, type JiraClient } from "./jira.ts";
import { NotesStore } from "./notesStore.ts";
import { Refresher } from "./refresher.ts";
import { watchNotesDir } from "./watcher.ts";

assertNodeVersion(); // first statement: a clear message instead of an obscure failure on old Node

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env, os.homedir());
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  await ensureDataDir(config.notesDir, config.defaultProject, path.join(root, "examples"));

  const makeClient = async (): Promise<JiraClient> =>
    createJiraClient({
      apiBase: config.jiraApiBase,
      siteUrl: config.jiraBaseUrl,
      email: config.jiraEmail,
      token: config.jiraApiToken,
      fields: (await loadColumns(config.notesDir)).jiraFields,
    });

  // Field mapping lives in columns.yaml, so the real client is rebuilt when that file changes.
  let inner: JiraClient;
  try {
    inner = await makeClient();
  } catch (e) {
    console.error(`${(e as Error).message}; using default Jira field mapping until it is fixed`);
    inner = createJiraClient({
      apiBase: config.jiraApiBase,
      siteUrl: config.jiraBaseUrl,
      email: config.jiraEmail,
      token: config.jiraApiToken,
      fields: { storyPoints: null, sprint: "customfield_10020", acceptanceCriteria: null },
    });
  }
  const jira: JiraClient = {
    search: (jql, limit) => inner.search(jql, limit),
    getIssueDetail: (k) => inner.getIssueDetail(k),
    getIssueBrief: (k) => inner.getIssueBrief(k),
  };

  const notes = new NotesStore(config.notesDir);
  const cache = new ViewCache(config.notesDir);
  let broadcast: (e: LiveEvent) => void = () => {};
  const board = new BoardService({
    jira,
    cache,
    notes,
    notesDir: config.notesDir,
    statePath: path.join(config.notesDir, ".cache", "board-state.json"),
    onChange: (e) => broadcast(e),
  });
  const refresher = new Refresher({
    board,
    jira,
    cache,
    notes,
    getViews: async () => loadViews(config.notesDir, await loadColumns(config.notesDir)),
    onChange: (e) => broadcast(e),
    statePath: path.join(config.notesDir, ".cache", "reconcile.json"),
  });
  const app = createApp({ config, jira, notes, cache, refresher, board, publicDir: path.join(root, "public") });
  broadcast = app.broadcast;

  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, "127.0.0.1", resolve);
  });
  const url = `http://localhost:${config.port}/`;
  console.log(`atlassian-notes running at ${url}`);

  refresher.start(config.refreshMinutes);
  refresher.refreshAll().catch((e) => console.error("initial refresh failed:", e instanceof Error ? e.message : e));

  watchNotesDir(config.notesDir, (e) => {
    if (e.type === "columns") {
      makeClient().then((c) => { inner = c; }, () => {});
    }
    app.broadcast(e);
  });

  if (config.openBrowser) openUrl(url);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
