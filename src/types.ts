export const enum ChangeStatus {
  Added = 'A',
  Changed = 'C',
  Moved = 'M',
  Deleted = 'D',
  /** Private — file exists in workspace but not tracked by Plastic yet (no `cm add`). */
  Private = 'P',
}

/** Special ref used to produce an empty document on the missing side of an add/delete diff. */
export const EMPTY_REF = '__empty__';

export interface PlasticChange {
  status: ChangeStatus;
  path: string;
  /** For moves/renames — the original path */
  oldPath?: string;
  /** For Moved entries — true when the move was accompanied by content changes (CH+MV, CO+CH+MV). */
  contentChanged?: boolean;
}

export interface PlasticWorkspaceInfo {
  root: string;
  branch: string;
  changeset: number;
  repository: string;
}
