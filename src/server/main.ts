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
import { ensureDataDir, loadAnalysis, loadColumns, loadReadingConfig, loadViews } from "./configFiles.ts";
import { createJiraClient, type JiraClient } from "./jira.ts";
import { NotesStore } from "./notesStore.ts";
import { ReadingStore } from "./readingStore.ts";
import { Refresher } from "./refresher.ts";
import { createTicketFileSyncer, syncTicketFiles } from "./ticketFiles.ts";
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

  // analysis.yaml's extra fields and flag field join every Jira search. A broken file keeps the last good
  // values, so a typo doesn't empty field-based charts or the flag rule on the next refresh.
  let analysisFetch: { fields: string[]; flagField: string | null } = { fields: [], flagField: null };
  const reloadAnalysisFetch = async (): Promise<void> => {
    try {
      const a = await loadAnalysis(config.notesDir);
      analysisFetch = { fields: a?.settings.fields ?? [], flagField: a?.settings.blocked.flagField ?? null };
    } catch (e) {
      console.warn(`${(e as Error).message}; keeping the last good analysis fields`);
    }
  };
  await reloadAnalysisFetch();
  const analysisFields = { extraFields: () => analysisFetch.fields, flagField: () => analysisFetch.flagField };

  const makeClient = async (): Promise<JiraClient> =>
    createJiraClient({
      apiBase: config.jiraApiBase,
      siteUrl: config.jiraBaseUrl,
      email: config.jiraEmail,
      token: config.jiraApiToken,
      fields: (await loadColumns(config.notesDir)).jiraFields,
      ...analysisFields,
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
      ...analysisFields,
    });
  }
  const jira: JiraClient = {
    search: (jql, limit) => inner.search(jql, limit),
    getIssueDetail: (k) => inner.getIssueDetail(k),
    getIssueBrief: (k) => inner.getIssueBrief(k),
  };

  const notes = new NotesStore(config.notesDir);
  const reading = new ReadingStore(config.notesDir);
  const cache = new ViewCache(config.notesDir);
  let broadcast: (e: LiveEvent) => void = () => {};
  // A ticket moved project: reading items that link the old key follow it (front matter only).
  const onTicketRenamed = async (oldKey: string, newKey: string): Promise<void> => {
    for (const id of await reading.renameTicketKey(oldKey, newKey)) broadcast({ type: "reading", id });
  };
  const board = new BoardService({
    jira,
    cache,
    notes,
    notesDir: config.notesDir,
    statePath: path.join(config.notesDir, ".cache", "board-state.json"),
    onTicketRenamed,
    onChange: (e) => broadcast(e),
    reading: {
      summary: async (id) => {
        const item = await reading.read(id);
        return item && { id: item.id, title: item.title, status: item.status, url: item.url, source: item.source };
      },
      // Kanban archive: reading items on the archived column become done (doneStatus in reading.yaml).
      markDone: async (ids) => {
        const { doneStatus } = await loadReadingConfig(config.notesDir);
        for (const id of ids) {
          const item = await reading.read(id);
          if (!item || item.parseError || item.status === doneStatus) continue;
          const r = await reading.setFields(id, { status: doneStatus });
          if (r.ok) broadcast({ type: "reading", id });
        }
      },
    },
  });
  const ticketFiles = createTicketFileSyncer(() =>
    syncTicketFiles({
      notesDir: config.notesDir,
      cache,
      notes,
      getCustom: async () => (await loadColumns(config.notesDir)).custom,
      getReadingIndex: () => reading.ticketIndex(),
      getViewIds: async () =>
        (await loadViews(config.notesDir, await loadColumns(config.notesDir))).map((v) => v.id),
    }),
  );
  const refresher = new Refresher({
    board,
    ticketFiles,
    jira,
    cache,
    notes,
    getViews: async () => loadViews(config.notesDir, await loadColumns(config.notesDir)),
    onChange: (e) => broadcast(e),
    statePath: path.join(config.notesDir, ".cache", "reconcile.json"),
    onTicketRenamed,
  });
  const app = createApp({ config, jira, notes, cache, refresher, board, reading, publicDir: path.join(root, "public") });
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
    if (e.type === "analysis") void reloadAnalysisFetch();
    if (e.type === "columns") {
      makeClient().then((c) => { inner = c; }, () => {});
    }
    if (e.type === "note" || e.type === "groom" || e.type === "columns" || e.type === "reading") ticketFiles.schedule();
    app.broadcast(e);
  });

  if (config.openBrowser) openUrl(url);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
