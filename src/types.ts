import * as vscode from 'vscode';

export const enum ChangeStatus {
  Added = 'A',
  Changed = 'C',
  Moved = 'M',
  Deleted = 'D',
}

/** Special ref used to produce an empty document on the missing side of an add/delete diff. */
export const EMPTY_REF = '__empty__';

export interface PlasticChange {
  status: ChangeStatus;
  path: string;
  /** For moves/renames — the original path */
  oldPath?: string;
}

export interface PlasticWorkspaceInfo {
  root: string;
  branch: string;
  changeset: number;
  repository: string;
}

/**
 * Encode Plastic revision info into a URI.
 *   path → the URI's own path component (as filesystem path)
 *   ref  → single query param `ref=<spec>`
 *
 * No base64, no JSON — VSCode's Uri serialization round-trips these
 * cleanly without any edge cases around `=`, `+`, or `/`.
 */
export function toPlasticUri(
  filePath: string,
  ref: string,
  scheme = 'plastic'
): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme,
    query: `ref=${encodeURIComponent(ref)}`,
  });
}

export function parsePlasticUri(uri: vscode.Uri): { path: string; ref: string } {
  const match = uri.query.match(/(?:^|&)ref=([^&]*)/);
  const ref = match ? decodeURIComponent(match[1]) : '';
  // Use uri.path (raw path component) not fsPath — the latter does
  // platform-specific munging that can corrupt non-file schemes.
  return { path: uri.path, ref };
}
