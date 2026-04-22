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
  // Use uri.path (raw path component) not fsPath — the latter does
  // platform-specific munging that can corrupt non-file schemes.
  return { path: uri.path, ref };
}
