export type ResolvedTurnSnapshot = {
  text: string;
  assistantText: string;
  planText: string;
  changedFiles: number;
  cwd: string | null;
  branch: string | null;
};
