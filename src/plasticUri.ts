import * as vscode from 'vscode';

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
  // uri.path returns URI-style path: /c:/foo/bar on Windows.
  // cm cat needs a native filesystem path, so strip the leading slash
  // before a drive letter. (Don't use uri.fsPath — unreliable for
  // non-file schemes.)
  let p = uri.path;
  if (p.length >= 3 && p[0] === '/' && /^[a-zA-Z]$/.test(p[1]) && p[2] === ':') {
    p = p.slice(1);
  }
  return { path: p, ref };
}
