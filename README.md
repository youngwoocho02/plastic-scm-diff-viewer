# Plastic SCM Diff Viewer

[한국어 문서](./README.ko.md)

VS Code extension for viewing Plastic SCM (Unity Version Control) pending changes as Git-style diffs — individual file clicks and a scrollable **Multi Diff Editor** that shows every changed file in one view.

## Features

- **Multi Diff Editor** — every pending change in one scrollable view, like Git's "Open All Changes"
- **Single file diff** — click any file in the Source Control sidebar for a standard diff
- **Git-style Added / Deleted views** — added files show "empty → new", deleted files show "old → empty"
- **Phantom filter** — drops files that Plastic marks as Changed but are byte-identical to the base revision (common with Unity `.asset` checkout artifacts)
- **In-memory content cache** — historical revisions are immutable, so `cm cat` results are reused for the entire session
- **Changeset diff** — compare any two changesets by number
- **Auto refresh** — change list stays in sync with the workspace

## Requirements

- VS Code 1.86+
- [Plastic SCM / Unity Version Control](https://www.plasticscm.com/) CLI (`cm`) installed and in `PATH`

## Install

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/youngwoocho02/plastic-scm-diff-viewer/master/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/youngwoocho02/plastic-scm-diff-viewer/master/install.ps1 | iex
```

### Other options

Download `plastic-scm-diff-viewer.vsix` from the [Releases page](https://github.com/youngwoocho02/plastic-scm-diff-viewer/releases) and run:

```bash
code --install-extension plastic-scm-diff-viewer.vsix
```

Or build from source — see [Building](#building).

## Usage

1. Open a folder containing a Plastic SCM workspace. Parent folders also work — subdirectories are scanned for `.plastic/` markers automatically.
2. A **Plastic SCM** group appears in VS Code's Source Control sidebar listing every pending change.
3. Click the **diff-multiple** (🗂) icon in the SCM title bar to open the Multi Diff Editor, or click any individual file for a single-file diff.

### Commands

| Command | Description |
|---|---|
| `Plastic SCM: View All Changes (Multi Diff)` | Open every pending change in the Multi Diff Editor |
| `Plastic SCM: View Changeset Diff` | Compare two changesets by number |
| `Plastic SCM: Refresh` | Manually refresh the change list |
| `Plastic SCM: Clear Content Cache` | Drop the in-memory cache (troubleshooting only) |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `plasticDiff.cmPath` | `cm` | Path to the `cm` CLI executable |
| `plasticDiff.autoRefreshInterval` | `10000` | Auto-refresh interval in ms. Warm refresh takes ~6s due to Plastic `cm status` calls; intervals below ~8s cause refreshes to queue. Set to `0` to disable auto-refresh. |

## How It Works

Plastic SCM is a centralized VCS — historical content lives on a repository server, not in the workspace. Every "show me this file at cs:N" request goes over the wire via `cm cat`. That call is expensive (often 2–4 seconds per file). The extension is a thin adapter that minimizes the wire-round-trip count.

### Data flow (cold refresh)

1. **`cm wi`** — detect the workspace root.
2. **`cm status --header` + `cm gwp`** — read the loaded changeset number and branch.
3. **`cm status --noheader --all --machinereadable --iscochanged`** — list every pending change (Added / Changed / Deleted / Moved).
4. **Phantom filter** — for each `Changed` entry, run `cm cat path#cs:N` in parallel and compare bytes with the workspace file. Drop entries that are byte-identical (Plastic reports these as changed even when the content wasn't touched, usually after a checkout-only operation).
5. **Base-content prefetch** — runs in parallel with the phantom filter. Warms the cache for every non-Added item so later Multi Diff opens are instant.

### Diff rendering

- **Changed** → `plastic://path?ref=cs:N` (base) vs `file://path` (workspace)
- **Added** → empty virtual document vs `file://path`
- **Deleted** → `plastic://path?ref=cs:N` vs empty virtual document
- **Moved** → `plastic://oldPath?ref=cs:N` vs `file://newPath`

The `plastic://` URI scheme is served by a `TextDocumentContentProvider` that decodes the `ref` from the query string and calls `cm cat` (cached).

### Concurrency

`cm` holds a workspace-level lock, so the extension gates every CLI invocation through a 4-wide semaphore. The limit was chosen by measurement — `limit=4` is reliable in production, `limit=6` works on isolated benchmarks but flakes under concurrent `cm status` load.

Concurrent calls for the same `path#ref` key are coalesced into a single in-flight promise, so phantom filter and prefetch never duplicate work.

## Known Limitations

- **First cold refresh is slow (~20s)** on a remote repository. Each `cm cat` roundtrip dominates; there's no way to avoid it without either a local Plastic mirror (`cm replicate`) or `cm shell` interactive mode.
- **Moved files lose their original path** because `cm status --machinereadable` doesn't expose it for `MV`/`LM` items. Currently rendered as a self-diff.
- **Binary files** are rendered as UTF-8 decoded strings — non-text files may appear garbled.
- **Multi-root workspaces** — only the first detected Plastic root is monitored.

## Building

```bash
npm install
npm run build
```

Package as `.vsix`:

```bash
npx @vscode/vsce package --allow-missing-repository
```

## License

MIT
