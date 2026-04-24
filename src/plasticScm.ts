import * as vscode from 'vscode';
import * as path from 'path';
import { ChangeStatus, EMPTY_REF, PlasticChange } from './types';
import { parsePlasticUri, toPlasticUri } from './plasticUri';
import {
  getPendingChangesRaw,
  filterPhantomChanges,
  filterTrivialChanges,
  getWorkspaceInfo,
  getChangesetDiff,
  clearContentCache,
  prefetchBaseContent,
  logDiag,
  undoPendingChange,
} from './plasticCli';
import { PlasticContentProvider } from './contentProvider';

interface DiffUris {
  originalUri: vscode.Uri;
  modifiedUri: vscode.Uri;
}

interface MultiDiffRevealTarget {
  modifiedUri: vscode.Uri;
  range?: vscode.Range;
}

/** SourceControlResourceState extended with the proposed multi-diff fields. */
type MultiDiffResourceState = vscode.SourceControlResourceState & {
  multiDiffEditorOriginalUri?: vscode.Uri;
  multiFileDiffEditorModifiedUri?: vscode.Uri;
};

/**
 * Read-only Plastic SCM integration: shows pending changes in the SCM view
 * and provides Git-style diffs (single-click + multi-diff editor).
 *
 * Data source is `cm diff cs:<loaded>` (real content diffs only) — Plastic's
 * `cm status` is NOT used for the change list because it reports phantom CH
 * for byte-identical files.
 */
export class PlasticScmProvider implements vscode.Disposable, vscode.QuickDiffProvider, vscode.FileDecorationProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sourceControl: vscode.SourceControl;
  private readonly addedGroup: vscode.SourceControlResourceGroup;
  private readonly changedGroup: vscode.SourceControlResourceGroup;
  private readonly deletedGroup: vscode.SourceControlResourceGroup;
  private readonly privateGroup: vscode.SourceControlResourceGroup;
  private readonly contentProvider: PlasticContentProvider;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshInflight: Promise<void> | undefined;
  private changeByPath = new Map<string, PlasticChange>();

  private readonly _onDidChangeDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeDecorations.event;
  private readonly multiDiffSourceUri = vscode.Uri.parse('plastic-multi-diff:changes');
  private _multiDiffOpen = false;
  private lastOpenedMultiDiffFingerprint: string | undefined;

  /** Set while Stage 2 (phantom filter) is still running. viewAllChanges
   *  awaits this so Multi Diff never opens with phantom files included. */
  private phantomInflight: Promise<void> | undefined;

  /** Most recent fetch result — reused by viewAllChanges.
   *  All fields are swapped together so viewAllChanges can never read
   *  an old baseCs with new changes. `phantomFiltered` distinguishes a
   *  Stage 1 commit (raw, phantoms included) from a Stage 2 commit. */
  private lastSnapshot: {
    changes: PlasticChange[];
    baseCs: number;
    branch: string;
    time: number;
    phantomFiltered: boolean;
  } = { changes: [], baseCs: 0, branch: '', time: 0, phantomFiltered: false };

  constructor(
    private readonly workspaceRoot: string,
    private readonly context: vscode.ExtensionContext
  ) {
    this.sourceControl = vscode.scm.createSourceControl(
      'plastic',
      'Plastic SCM',
      vscode.Uri.file(workspaceRoot)
    );
    this.sourceControl.acceptInputCommand = undefined as any;
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = this;
    this.disposables.push(this.sourceControl);

    this.addedGroup = this.sourceControl.createResourceGroup('added', 'Added');
    this.addedGroup.hideWhenEmpty = true;
    this.disposables.push(this.addedGroup);

    this.changedGroup = this.sourceControl.createResourceGroup('changed', 'Changes');
    this.changedGroup.hideWhenEmpty = true;
    this.disposables.push(this.changedGroup);

    this.deletedGroup = this.sourceControl.createResourceGroup('deleted', 'Deleted');
    this.deletedGroup.hideWhenEmpty = true;
    this.disposables.push(this.deletedGroup);

    this.privateGroup = this.sourceControl.createResourceGroup('private', 'Untracked');
    this.privateGroup.hideWhenEmpty = true;
    this.disposables.push(this.privateGroup);

    this.contentProvider = new PlasticContentProvider(workspaceRoot);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider('plastic', this.contentProvider)
    );

    this.disposables.push(
      vscode.commands.registerCommand('plasticDiff.viewAllChanges', () => this.viewAllChanges()),
      vscode.commands.registerCommand('plasticDiff.viewChangesetDiff', () => this.viewChangesetDiff()),
      vscode.commands.registerCommand('plasticDiff.refresh', () => this.refresh()),
      vscode.commands.registerCommand('plasticDiff.clearCache', () => {
        clearContentCache();
        vscode.window.showInformationMessage('Plastic SCM: content cache cleared.');
      }),
      vscode.commands.registerCommand('plasticDiff.openFile', (r: MultiDiffResourceState) => {
        vscode.window.showTextDocument(r.resourceUri);
      }),
      vscode.commands.registerCommand('plasticDiff.openBaseRevision', (r: MultiDiffResourceState) => {
        if (r.multiDiffEditorOriginalUri) {
          vscode.commands.executeCommand('vscode.open', r.multiDiffEditorOriginalUri);
        }
      }),
      vscode.commands.registerCommand('plasticDiff.openActiveFile', async () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        const target = uri.scheme === 'plastic'
          ? vscode.Uri.file(parsePlasticUri(uri).path)
          : uri.scheme === 'file'
            ? uri
            : undefined;
        if (!target) return;
        await vscode.window.showTextDocument(target, { preview: false });
      }),
      vscode.commands.registerCommand('plasticDiff.openActiveBaseRevision', async () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'plastic') return;
        await vscode.commands.executeCommand('vscode.open', uri);
      }),
      vscode.commands.registerCommand('plasticDiff.openDiff', (r: MultiDiffResourceState) => {
        if (r.command) {
          vscode.commands.executeCommand(r.command.command, ...(r.command.arguments ?? []));
        }
      }),
      vscode.commands.registerCommand('plasticDiff.revertChange', (r: MultiDiffResourceState) => this.revertChange(r)),
      vscode.commands.registerCommand('plasticDiff.copyPath', (r: MultiDiffResourceState) => {
        vscode.env.clipboard.writeText(r.resourceUri.fsPath);
      }),
      vscode.commands.registerCommand('plasticDiff.filterChanges', () => this.showFilterQuickPick()),
    );

    this.disposables.push(vscode.window.registerFileDecorationProvider(this));
    this.disposables.push(this._onDidChangeDecorations);

    void this.closeRestoredMultiDiffTabs();
    this.setupAutoRefresh();
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(e => {
        for (const tab of e.closed) {
          if (tab.label?.startsWith('Plastic SCM: Changes')) {
            this._multiDiffOpen = false;
            this.lastOpenedMultiDiffFingerprint = undefined;
            break;
          }
        }
      })
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('plasticDiff.autoRefreshInterval')) {
          this.setupAutoRefresh();
        }
      })
    );

    this.refresh('startup');
  }

  private async closeRestoredMultiDiffTabs(): Promise<void> {
    const staleTabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.label?.startsWith('Plastic SCM: Changes')) {
          staleTabs.push(tab);
        }
      }
    }

    if (staleTabs.length === 0) {
      return;
    }

    await vscode.window.tabGroups.close(staleTabs, true);
    logDiag(`[activate] closed ${staleTabs.length} restored Plastic SCM multi-diff tab(s)`);
  }

  private setupAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const interval = vscode.workspace
      .getConfiguration('plasticDiff')
      .get<number>('autoRefreshInterval', 10000);
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.refresh('auto'), interval);
    }
  }

  /** Single-flight refresh — concurrent callers share the in-flight promise. */
  async refresh(trigger: 'auto' | 'manual' | 'startup' | 'config' | 'filter' = 'manual'): Promise<void> {
    if (this.refreshInflight) {
      logDiag(`[refresh] join inflight (trigger=${trigger})`);
      return this.refreshInflight;
    }
    logDiag(`[refresh] ──── begin (trigger=${trigger}) ────`);
    this.refreshInflight = vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl },
      () => this.doRefresh(trigger)
    ).then(() => {}, (e) => { logDiag(`[refresh] progress error: ${e?.message}`); }) as Promise<void>;
    this.refreshInflight = this.refreshInflight.finally(() => {
      this.refreshInflight = undefined;
    });
    return this.refreshInflight;
  }

  /**
   * Refresh stages:
   *   0. info (~2s cold)          — workspace info (cs + branch)
   *   1. status (~4s cold)         — raw parse, commit snapshot (phantoms included)
   *   2+3 parallel (~18s cold)     — phantom filter + prefetch concurrently
   *        - Phantom filter drops byte-identical entries; commit filtered snapshot.
   *        - Prefetch warms base content for every non-Added item.
   *        - Both share the same cm semaphore + `_inflight` cache, so Changed
   *          items fetched by the phantom filter are naturally shared with
   *          prefetch via in-flight coalescing (no duplicate cm cat).
   *
   * Running 2+3 in parallel reduces cold refresh from ~28s to ~20s.
   */
  private async doRefresh(trigger: 'auto' | 'manual' | 'startup' | 'config' | 'filter'): Promise<void> {
    const t0 = Date.now();
    try {
      // Stage 0: workspace info (branch + cs)
      const tInfoStart = Date.now();
      const info = await getWorkspaceInfo(this.workspaceRoot);
      logDiag(`[refresh] stage0 info: ${Date.now() - tInfoStart}ms (cs=${info?.changeset} branch=${info?.branch})`);
      const baseCs = info?.changeset ?? 0;
      const branch = info?.branch ?? '';

      // Stage 1: raw pending changes (phantoms included) — commit immediately
      // with phantomFiltered=false so viewAllChanges knows to wait.
      const tRawStart = Date.now();
      const raw = await getPendingChangesRaw(this.workspaceRoot, baseCs);
      logDiag(`[refresh] stage1 raw status: ${Date.now() - tRawStart}ms (${raw.length} items, phantoms included)`);
      // Only commit the raw (unfiltered) snapshot on the very first load —
      // refreshing an already-populated SCM panel with raw then filtered
      // produces a visible "list grows then shrinks" flicker every cycle.
      if (this.lastSnapshot.time === 0) {
        this.commitSnapshot(raw, baseCs, branch, false);
      }

      // Stage 2 + 3 in parallel:
      //   - Phantom filter: drop byte-identical Changed → recommit snapshot
      //   - Prefetch:       warm base content for all non-Added
      // Both go through the same semaphore; Changed items fetched by phantom
      // are shared with prefetch via in-flight coalescing.
      const tWarmStart = Date.now();

      // Track phantom separately so viewAllChanges can await JUST the phantom
      // stage (which determines correctness of the change list) without having
      // to also wait for prefetch (which only affects cache warmth).
      const phantomPromise = (async () => {
        const tStart = Date.now();
        let filtered = await filterPhantomChanges(this.workspaceRoot, baseCs, raw);
        logDiag(`[refresh] phantom: ${Date.now() - tStart}ms (${filtered.length} kept, ${raw.length - filtered.length} dropped)`);

        const cfg = vscode.workspace.getConfiguration('plasticDiff');
        const hideTrivial = cfg.get<boolean>('hideTrivialChanges', true);
        if (hideTrivial) {
          const tT = Date.now();
          const before = filtered.length;
          filtered = await filterTrivialChanges(this.workspaceRoot, baseCs, filtered);
          logDiag(`[refresh] trivial: ${Date.now() - tT}ms (${filtered.length} kept, ${before - filtered.length} dropped)`);
        }

        const hidePureRenames = cfg.get<boolean>('hidePureRenames', true);
        if (hidePureRenames) {
          const before = filtered.length;
          filtered = filtered.filter(c => !(c.status === ChangeStatus.Moved && !c.contentChanged));
          logDiag(`[refresh] pure-rename: ${filtered.length} kept, ${before - filtered.length} dropped`);
        }

        const hideMeta = cfg.get<boolean>('hideMetaFiles', true);
        if (hideMeta) {
          const before = filtered.length;
          filtered = filtered.filter(c => !c.path.toLowerCase().endsWith('.meta'));
          logDiag(`[refresh] meta: ${filtered.length} kept, ${before - filtered.length} dropped`);
        }

        this.commitSnapshot(filtered, baseCs, branch, true);
      })();
      this.phantomInflight = phantomPromise.finally(() => {
        this.phantomInflight = undefined;
      });

      const prefetchPromise = (async () => {
        const tStart = Date.now();
        // Pass `raw`, not filtered — phantom filter runs in parallel so the
        // filtered list isn't available yet. For Changed items, catCached will
        // hit the in-flight Promise from phantom filter (no duplicate fetch).
        await prefetchBaseContent(this.workspaceRoot, baseCs, raw);
        logDiag(`[refresh] prefetch: ${Date.now() - tStart}ms`);
      })();

      await Promise.all([phantomPromise, prefetchPromise]);
      logDiag(`[refresh] stage2+3 parallel: ${Date.now() - tWarmStart}ms`);

      if (this._multiDiffOpen) {
        const nextFingerprint = this.buildMultiDiffFingerprint(this.lastSnapshot);
        if (this.lastSnapshot.changes.length === 0) {
          logDiag(`[refresh] multi-diff open but snapshot is empty — closing stale tab (trigger=${trigger})`);
          await this.closeOpenMultiDiffTabs();
        } else if (this.lastOpenedMultiDiffFingerprint !== nextFingerprint) {
          if (this.isPlasticMultiDiffActive()) {
            logDiag(`[refresh] multi-diff active — reopening to latest snapshot (trigger=${trigger})`);
            await this.reopenActiveMultiDiffToLatest();
          } else {
            logDiag(`[refresh] multi-diff open in background — keeping existing view (trigger=${trigger})`);
          }
        } else {
          logDiag(`[refresh] multi-diff open but snapshot unchanged — skip reopen (trigger=${trigger})`);
        }
      }

      logDiag(`[refresh] ──── done in ${Date.now() - t0}ms ────`);
    } catch (err: any) {
      logDiag(`[refresh] FAIL: ${err.message}`);
      console.error('[PlasticDiff]', err.message);
    }
  }

  /** Atomic snapshot commit + SCM UI update. */
  private commitSnapshot(
    changes: PlasticChange[],
    baseCs: number,
    branch: string,
    phantomFiltered: boolean,
  ): void {
    this.lastSnapshot = { changes, baseCs, branch, time: Date.now(), phantomFiltered };
    this.addedGroup.resourceStates = changes
      .filter(c => c.status === ChangeStatus.Added)
      .map(c => this.toResourceState(c, baseCs));
    this.changedGroup.resourceStates = changes
      .filter(c => c.status === ChangeStatus.Changed || c.status === ChangeStatus.Moved)
      .map(c => this.toResourceState(c, baseCs));
    this.deletedGroup.resourceStates = changes
      .filter(c => c.status === ChangeStatus.Deleted)
      .map(c => this.toResourceState(c, baseCs));
    this.privateGroup.resourceStates = changes
      .filter(c => c.status === ChangeStatus.Private)
      .map(c => this.toResourceState(c, baseCs));
    this.sourceControl.count = changes.length;
    this.sourceControl.statusBarCommands = branch ? [
      { title: `$(git-branch) ${branch}`, command: 'plasticDiff.refresh', tooltip: 'Plastic SCM — click to refresh' },
      { title: `$(git-commit) cs:${baseCs}`, command: 'plasticDiff.viewAllChanges', tooltip: 'Click to open multi-diff' },
    ] : [
      { title: `$(git-commit) cs:${baseCs}`, command: 'plasticDiff.viewAllChanges', tooltip: 'Click to open multi-diff' },
    ];

    // Rebuild changeByPath for quickDiffProvider and FileDecorationProvider
    this.changeByPath.clear();
    for (const c of changes) {
      if (c.status === ChangeStatus.Moved) {
        this.changeByPath.set(this.absOf(c.path), c);
      } else {
        this.changeByPath.set(this.absOf(c.path), c);
      }
    }
    this._onDidChangeDecorations.fire(undefined);

    logDiag(`[refresh] committed snapshot: ${changes.length} items baseCs=${baseCs} filtered=${phantomFiltered}`);
  }

  private buildMultiDiffFingerprint(snap: typeof this.lastSnapshot): string {
    return JSON.stringify({
      baseCs: snap.baseCs,
      branch: snap.branch,
      changes: snap.changes.map(c => ({
        status: c.status,
        path: c.path,
        oldPath: c.oldPath ?? '',
        contentChanged: c.contentChanged ?? false,
      })),
    });
  }

  private async revealOpenMultiDiffTab(): Promise<boolean> {
    await this.openMultiDiffEditor(
      this.lastSnapshot.changes.map(c => this.diffUris(c, `cs:${this.lastSnapshot.baseCs}`, null)),
      `Plastic SCM: Changes (${this.lastSnapshot.branch || 'unknown'})`,
    );
    return true;
  }

  private activeMultiDiffRevealTarget(snap: typeof this.lastSnapshot): MultiDiffRevealTarget | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    const { uri } = editor.document;
    const { selection } = editor;
    const range = selection.isEmpty ? undefined : new vscode.Range(selection.start, selection.end);
    if (uri.scheme === 'file') {
      return { modifiedUri: uri, range };
    }
    if (uri.scheme !== 'plastic') {
      return undefined;
    }

    const parsed = parsePlasticUri(uri);
    const abs = this.absOf(parsed.path);
    const change = snap.changes.find(c =>
      this.absOf(c.path) === abs ||
      (c.oldPath !== undefined && this.absOf(c.oldPath) === abs)
    );
    if (!change) {
      return undefined;
    }

    return {
      modifiedUri: this.diffUris(change, `cs:${snap.baseCs}`, null).modifiedUri,
      range,
    };
  }

  private async openMultiDiffEditor(
    resources: DiffUris[],
    title: string,
    reveal?: MultiDiffRevealTarget,
  ): Promise<void> {
    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      multiDiffSourceUri: this.multiDiffSourceUri,
      title,
      resources,
      reveal: reveal ? {
        modifiedUri: reveal.modifiedUri,
        range: reveal.range,
      } : undefined,
    });
  }

  private async reopenActiveMultiDiffToLatest(): Promise<void> {
    const snap = this.lastSnapshot;
    const resources = snap.changes.map(c => this.diffUris(c, `cs:${snap.baseCs}`, null));
    const reveal = this.activeMultiDiffRevealTarget(snap);
    await this.closeOpenMultiDiffTabs();
    await this.openMultiDiffEditor(resources, `Plastic SCM: Changes (${snap.branch || 'unknown'})`, reveal);
    this._multiDiffOpen = true;
    this.lastOpenedMultiDiffFingerprint = this.buildMultiDiffFingerprint(snap);
  }

  // ---------- Path / URI helpers ----------

  private absOf(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workspaceRoot, p);
  }

  /**
   * Build (originalUri, modifiedUri) for a change.
   *
   * @param originalRef   Revision spec for the "before" side (e.g. "cs:42").
   * @param modifiedRef   Revision spec for the "after" side, or `null` to use
   *                      the live workspace file (pending-change view).
   *
   * Semantics mirror Git:
   *   Added    → EMPTY ← modified
   *   Deleted  → original ← EMPTY
   *   Changed  → original ← modified
   *   Moved    → original@oldPath ← modified@newPath
   */
  private diffUris(
    change: PlasticChange,
    originalRef: string,
    modifiedRef: string | null,
  ): DiffUris {
    const absPath = this.absOf(change.path);
    const oldAbs = change.oldPath ? this.absOf(change.oldPath) : absPath;

    const originalUri = (change.status === ChangeStatus.Added || change.status === ChangeStatus.Private)
      ? toPlasticUri(absPath, EMPTY_REF)
      : toPlasticUri(oldAbs, originalRef);

    const modifiedUri = change.status === ChangeStatus.Deleted
      ? toPlasticUri(absPath, EMPTY_REF)
      : (modifiedRef === null
          ? vscode.Uri.file(absPath)
          : toPlasticUri(absPath, modifiedRef));

    return { originalUri, modifiedUri };
  }

  private diffTitle(change: PlasticChange, absPath: string): string {
    const base = path.basename(absPath);
    switch (change.status) {
      case ChangeStatus.Added:   return `${base} (Added)`;
      case ChangeStatus.Private: return `${base} (Private — Untracked)`;
      case ChangeStatus.Deleted: return `${base} (Deleted)`;
      case ChangeStatus.Moved: {
        const oldBase = change.oldPath ? path.basename(change.oldPath) : undefined;
        const suffix = change.contentChanged ? ' [+M]' : '';
        return oldBase && oldBase !== base
          ? `${oldBase} → ${base}${suffix}`
          : `${base} (Moved${change.contentChanged ? ' + Modified' : ''})`;
      }
      default:                   return `${base} (Plastic SCM)`;
    }
  }

  // ---------- Resource state (single-click SCM list) ----------

  private toResourceState(change: PlasticChange, baseCs: number): MultiDiffResourceState {
    const absPath = this.absOf(change.path);
    const resourceUri = vscode.Uri.file(absPath);
    const { originalUri, modifiedUri } = this.diffUris(change, `cs:${baseCs}`, null);

    return {
      resourceUri,
      contextValue: `plastic:${change.status}`,
      decorations: {
        strikeThrough: change.status === ChangeStatus.Deleted,
        tooltip: this.statusLabel(change),
        iconPath: this.statusIcon(change.status),
      },
      command: {
        title: 'Open Diff',
        command: 'vscode.diff',
        arguments: [originalUri, modifiedUri, this.diffTitle(change, absPath)],
      },
      // Proposed multi-diff API — available on recent VSCode versions
      multiDiffEditorOriginalUri: originalUri,
      multiFileDiffEditorModifiedUri: modifiedUri,
    };
  }

  // ---------- Commands ----------

  private async closeOpenMultiDiffTabs(): Promise<void> {
    const victims: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.label?.startsWith('Plastic SCM: Changes')) {
          victims.push(tab);
        }
      }
    }
    if (victims.length > 0) {
      await vscode.window.tabGroups.close(victims, true);
    }
    this._multiDiffOpen = false;
    this.lastOpenedMultiDiffFingerprint = undefined;
  }

  private isPlasticMultiDiffActive(): boolean {
    return vscode.window.tabGroups.activeTabGroup.activeTab?.label?.startsWith('Plastic SCM: Changes') === true;
  }

  private async revertChange(resource: MultiDiffResourceState): Promise<void> {
    const change = this.changeByPath.get(resource.resourceUri.fsPath);
    if (!change || change.status === ChangeStatus.Private) {
      vscode.window.showErrorMessage('Plastic SCM: This change cannot be reverted from here.');
      return;
    }

    const fileName = path.basename(change.path);
    const isRestore = change.status === ChangeStatus.Deleted;
    const message = isRestore
      ? `Are you sure you want to restore '${fileName}'?`
      : change.status === ChangeStatus.Added
        ? `Are you sure you want to undo add for '${fileName}'?`
        : `Are you sure you want to discard changes in '${fileName}'?`;
    const confirm = isRestore
      ? 'Restore File'
      : change.status === ChangeStatus.Added
        ? 'Undo Add'
        : 'Discard File';

    const pick = await vscode.window.showWarningMessage(message, { modal: true }, confirm);
    if (pick !== confirm) {
      return;
    }

    try {
      const prevSnapshotTime = this.lastSnapshot.time;
      const wasActiveMultiDiff = this.isPlasticMultiDiffActive();
      await undoPendingChange(this.workspaceRoot, change);
      await this.refresh();
      if (this.lastSnapshot.time <= prevSnapshotTime) {
        vscode.window.showWarningMessage('Plastic SCM: Change was reverted, but refresh did not complete. Refresh once more.');
        return;
      }
      if (this._multiDiffOpen) {
        if (this.lastSnapshot.changes.length === 0) {
          await this.closeOpenMultiDiffTabs();
        } else if (!wasActiveMultiDiff) {
          await this.closeOpenMultiDiffTabs();
        }
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Plastic SCM: Failed to revert '${fileName}': ${err.message}`);
    }
  }

  /** Open Multi Diff Editor showing all pending changes. */
  async viewAllChanges(forceReopen = false): Promise<void> {
    const t0 = Date.now();
    logDiag(`[scm] ──── viewAllChanges begin ────`);

    // If no snapshot exists yet (first activation before any refresh finished),
    // force an initial refresh so we have something to show.
    if (this.lastSnapshot.time === 0) {
      logDiag(`[scm] no snapshot yet — forcing initial refresh`);
      await this.refresh();
    }

    // If the current snapshot is still the raw Stage 1 commit (phantoms included),
    // wait for phantom filter to finish so Multi Diff opens with correct items.
    // Prefetch is intentionally NOT awaited — in-flight coalescing handles it.
    if (!this.lastSnapshot.phantomFiltered && this.phantomInflight) {
      logDiag(`[scm] snapshot not yet phantom-filtered — awaiting phantom stage`);
      const tWait = Date.now();
      await this.phantomInflight;
      logDiag(`[scm] phantom wait: ${Date.now() - tWait}ms`);
    }

    // Snapshot read once; subsequent writes by prefetch won't affect us.
    const snap = this.lastSnapshot;
    const tRefresh = Date.now();

    if (snap.changes.length === 0) {
      logDiag(`[scm] no changes — aborting`);
      vscode.window.showInformationMessage('Plastic SCM: No changes found.');
      return;
    }

    const byStatus = { A: 0, C: 0, D: 0, M: 0, P: 0 };
    for (const c of snap.changes) byStatus[c.status]++;
    logDiag(
      `[scm] using snapshot: ${snap.changes.length} files ` +
      `(A=${byStatus.A} C=${byStatus.C} D=${byStatus.D} M=${byStatus.M} P=${byStatus.P}) baseCs=${snap.baseCs}`
    );

    const resources = snap.changes.map(c =>
      this.diffUris(c, `cs:${snap.baseCs}`, null)
    );
    const tResources = Date.now();
    logDiag(`[scm] built ${resources.length} diff URI pairs in ${tResources - tRefresh}ms`);
    const fingerprint = this.buildMultiDiffFingerprint(snap);

    const title = `Plastic SCM: Changes (${snap.branch || 'unknown'})`;
    let shouldForceReopen = forceReopen;
    if (this._multiDiffOpen && !shouldForceReopen) {
      if (this.lastOpenedMultiDiffFingerprint === fingerprint) {
        logDiag(`[scm] multi-diff already open with identical snapshot — reveal existing tab`);
        await this.revealOpenMultiDiffTab();
        return;
      }
      logDiag(`[scm] multi-diff open with changed snapshot — reopening to show latest view`);
      shouldForceReopen = true;
    }

    if (this._multiDiffOpen && shouldForceReopen) {
      await this.closeOpenMultiDiffTabs();
    }

    logDiag(`[scm] calling _workbench.openMultiDiffEditor`);
    await this.openMultiDiffEditor(resources, title);
    this._multiDiffOpen = true;
    this.lastOpenedMultiDiffFingerprint = fingerprint;
    logDiag(`[scm] ──── viewAllChanges done in ${Date.now() - t0}ms ────`);
  }

  /** View diff between two arbitrary changesets. */
  async viewChangesetDiff(): Promise<void> {
    const fromInput = await vscode.window.showInputBox({
      prompt: 'Source changeset number',
      placeHolder: 'e.g. 42',
    });
    if (!fromInput) return;

    const toInput = await vscode.window.showInputBox({
      prompt: 'Destination changeset number',
      placeHolder: 'e.g. 45',
    });
    if (!toInput) return;

    const fromCs = parseInt(fromInput, 10);
    const toCs = parseInt(toInput, 10);
    if (isNaN(fromCs) || isNaN(toCs)) {
      vscode.window.showErrorMessage('Invalid changeset number.');
      return;
    }

    const changes = await getChangesetDiff(this.workspaceRoot, fromCs, toCs);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`No differences between cs:${fromCs} and cs:${toCs}.`);
      return;
    }

    const resources = changes.map(c =>
      this.diffUris(c, `cs:${fromCs}`, `cs:${toCs}`)
    );

    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      title: `Plastic SCM: cs:${fromCs} ↔ cs:${toCs}`,
      resources,
    });
  }

  // ---------- Presentation ----------

  private statusLabel(change: PlasticChange): string {
    if (change.status === ChangeStatus.Moved) {
      const head = change.contentChanged ? 'Moved + Modified' : 'Moved';
      return change.oldPath
        ? `${head}\nFrom: ${change.oldPath}\nTo: ${change.path}`
        : head;
    }
    const labels: Record<ChangeStatus, string> = {
      [ChangeStatus.Added]: 'Added',
      [ChangeStatus.Changed]: 'Changed',
      [ChangeStatus.Moved]: 'Moved',
      [ChangeStatus.Deleted]: 'Deleted',
      [ChangeStatus.Private]: 'Private (Untracked)',
    };
    return labels[change.status] || change.status;
  }

  private statusIcon(status: ChangeStatus): vscode.ThemeIcon {
    switch (status) {
      case ChangeStatus.Added:
        return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case ChangeStatus.Private:
        return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
      case ChangeStatus.Deleted:
        return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      case ChangeStatus.Moved:
        return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
      default:
        return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    }
  }

  // ---------- QuickDiffProvider ----------

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    const abs = uri.fsPath;
    const change = this.changeByPath.get(abs);
    if (!change) return undefined;
    if (change.status === ChangeStatus.Added) return undefined;
    const basePath = change.oldPath ? this.absOf(change.oldPath) : abs;
    return toPlasticUri(basePath, `cs:${this.lastSnapshot.baseCs}`);
  }

  // ---------- FileDecorationProvider ----------

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const change = this.changeByPath.get(uri.fsPath);
    if (!change) return undefined;
    switch (change.status) {
      case ChangeStatus.Added:
        return { badge: 'A', tooltip: 'Added', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), propagate: true };
      case ChangeStatus.Private:
        return { badge: 'U', tooltip: 'Private (Untracked)', color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'), propagate: true };
      case ChangeStatus.Changed:
        return { badge: 'M', tooltip: 'Modified', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), propagate: true };
      case ChangeStatus.Moved:
        return {
          badge: change.contentChanged ? 'R*' : 'R',
          tooltip: change.contentChanged ? 'Moved/Renamed + Modified' : 'Moved/Renamed',
          color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
          propagate: true,
        };
      case ChangeStatus.Deleted:
        return { badge: 'D', tooltip: 'Deleted', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'), propagate: true };
    }
  }

  // ---------- Filter QuickPick ----------

  private async showFilterQuickPick(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('plasticDiff');
    const items: Array<vscode.QuickPickItem & { key: string }> = [
      {
        key: 'hideTrivialChanges',
        label: 'Hide Trivial Changes (.cs using/namespace/comment only)',
        picked: cfg.get<boolean>('hideTrivialChanges', true),
      },
      {
        key: 'hidePureRenames',
        label: 'Hide Pure Renames (no content change)',
        picked: cfg.get<boolean>('hidePureRenames', true),
      },
      {
        key: 'hideMetaFiles',
        label: 'Hide .meta Files',
        picked: cfg.get<boolean>('hideMetaFiles', true),
      },
    ];

    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { key: string }>();
    qp.title = 'Plastic SCM: Filter Changes';
    qp.placeholder = 'Toggle filters (checked = hidden)';
    qp.canSelectMany = true;
    qp.items = items;
    qp.selectedItems = items.filter(i => i.picked);

    qp.onDidChangeSelection(selected => {
      const selectedKeys = new Set(selected.map(r => (r as vscode.QuickPickItem & { key: string }).key));
      for (const item of items) {
        const newVal = selectedKeys.has(item.key);
        if (cfg.get<boolean>(item.key) !== newVal) {
          cfg.update(item.key, newVal, vscode.ConfigurationTarget.Workspace);
        }
      }
      this.refresh('filter');
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
