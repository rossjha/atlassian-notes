const MIN: [number, number] = [22, 18];

/** Null when `version` (e.g. process.version) is new enough to run .ts files directly; otherwise a readable message. */
export function nodeVersionProblem(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major > MIN[0] || (major === MIN[0] && minor >= MIN[1])) return null;
  return `atlassian-notes needs Node ${MIN.join(".")} or newer (you have ${version}). Install a current Node LTS and try again.`;
}

/** Import this first: exits with a clear message on an old Node before anything else runs. */
export function assertNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
