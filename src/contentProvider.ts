import * as vscode from 'vscode';
import { EMPTY_REF } from './types';
import { parsePlasticUri } from './plasticUri';
import { getFileContent, logDiag } from './plasticCli';

/**
 * Resolves `plastic://` URIs to file content.
 *
 * The Multi Diff Editor and vscode.diff invoke this provider for the
 * "before" side of a change. The URI query encodes `{ path, ref }`:
 *   - ref = "cs:N" → fetched via `cm cat path#cs:N`
 *   - ref = EMPTY_REF → empty document (Git-style added/deleted diff)
 */
export class PlasticContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly workspaceRoot: string) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { path, ref } = parsePlasticUri(uri);
    if (ref === EMPTY_REF) {
      logDiag(`[provider] EMPTY ${path}`);
      return '';
    }
    const t0 = Date.now();
    const content = await getFileContent(this.workspaceRoot, path, ref);
    const dt = Date.now() - t0;
    logDiag(`[provider] ${path}#${ref} → ${content.length}B in ${dt}ms`);
    return content;
  }
}
