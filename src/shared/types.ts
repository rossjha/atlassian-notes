export interface NoteFile {
  key: string;
  data: Record<string, unknown>;
  body: string;
  mtimeMs: number;
  parseError: string | null;
}

export interface GroomSummary {
  readiness: string | null;
  summary: string;
  groomedAt: string | null;
}

export interface GroomFile extends NoteFile {
  summary: GroomSummary;
}
