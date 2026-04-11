import * as vscode from 'vscode';
import * as path from 'path';
import { configure, isPlasticWorkspace, setCmPath, logDiag } from './plasticCli';
import { PlasticScmProvider } from './plasticScm';

let provider: PlasticScmProvider | undefined;

function readCmPath(): string {
  return vscode.workspace.getConfiguration('plasticDiff').get<string>('cmPath', 'cm');
}

/**
 * Find Plastic SCM workspace roots. Checks each workspace folder itself,
 * then scans immediate subdirectories for `.plastic`.
 */
async function findPlasticRoots(folders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
  const roots: string[] = [];

  for (const folder of folders) {
    const root = folder.uri.fsPath;

    if (await isPlasticWorkspace(root)) {
      roots.push(root);
      continue;
    }

    try {
      const pattern = new vscode.RelativePattern(folder, '*/.plastic');
      const hits = await vscode.workspace.findFiles(pattern, null, 20);
      for (const hit of hits) {
        const plasticRoot = path.dirname(hit.fsPath);
        if (await isPlasticWorkspace(plasticRoot)) {
          roots.push(plasticRoot);
        }
      }
    } catch {
      // findFiles can fail on restricted folders — skip
    }
  }

  return roots;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tStart = Date.now();
  const channel = vscode.window.createOutputChannel('Plastic SCM Diff');
  context.subscriptions.push(channel);
  configure(channel, readCmPath());
  logDiag(`[activate] begin (cmPath=${readCmPath()})`);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('plasticDiff.cmPath')) {
        logDiag(`[activate] cmPath changed → ${readCmPath()}`);
        setCmPath(readCmPath());
      }
    })
  );

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    logDiag(`[activate] no workspace folders — skip`);
    return;
  }

  const tScan = Date.now();
  const roots = await findPlasticRoots(folders);
  logDiag(`[activate] plastic root scan: ${roots.length} found in ${Date.now() - tScan}ms`);
  if (roots.length === 0) return;

  const root = roots[0];
  logDiag(`[activate] using root: ${root}`);

  provider = new PlasticScmProvider(root, context);
  context.subscriptions.push(provider);
  logDiag(`[activate] done in ${Date.now() - tStart}ms`);
}

export function deactivate(): void {
  provider = undefined;
}
