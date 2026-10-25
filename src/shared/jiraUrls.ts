/** Jira's issue search page for a JQL query, on the given site (no trailing slash). */
export function jiraSearchUrl(siteUrl: string, jql: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/issues/?jql=${encodeURIComponent(jql)}`;
}
