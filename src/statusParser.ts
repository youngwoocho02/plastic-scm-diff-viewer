import { ChangeStatus, PlasticChange } from './types';

export function parseStatusCode(s: string): ChangeStatus | undefined {
  const upper = s.toUpperCase();
  const tokens = upper.split('+');
  if (tokens.includes('MV') || tokens.includes('LM')) return ChangeStatus.Moved;
  if (tokens.includes('DE') || tokens.includes('LD')) return ChangeStatus.Deleted;
  if (tokens.includes('AD') || tokens.includes('CP')) return ChangeStatus.Added;
  if (tokens.includes('CH') || tokens.includes('RP')) return ChangeStatus.Changed;
  if (tokens.includes('PR')) return ChangeStatus.Private;
  return undefined;
}

export interface ParseStats {
  totalLines: number;
  kept: number;
  skippedDir: number;
  skippedNoStatus: number;
  byStatus: Record<ChangeStatus, number>;
}

export function parseStatusOutput(raw: string): { changes: PlasticChange[]; stats: ParseStats } {
  const changes: PlasticChange[] = [];
  const stats: ParseStats = {
    totalLines: 0,
    kept: 0,
    skippedDir: 0,
    skippedNoStatus: 0,
    byStatus: {
      [ChangeStatus.Added]: 0,
      [ChangeStatus.Changed]: 0,
      [ChangeStatus.Deleted]: 0,
      [ChangeStatus.Moved]: 0,
      [ChangeStatus.Private]: 0,
    },
  };

  // Pass 1 — collect directory-move prefixes so we can remap child CH files
  // to their base path. Plastic reports e.g. `/a/b` MV'd to `/x/y`, then lists
  // child `/x/y/c.cs` as plain CH with no oldPath — base `cm cat` fails
  // unless we remap to `/a/b/c.cs`.
  const dirMoves: Array<{ oldP: string; newP: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const rawCode = parts[0].trim().toUpperCase();
    const tokens = rawCode.split('+');
    if (!(tokens.includes('MV') || tokens.includes('LM'))) continue;
    if (parts.length < 5) continue;
    if (parts[4].trim().toLowerCase() !== 'true') continue;  // dir only
    const oldP = parts[2].trim();
    const newP = parts[3].trim();
    if (oldP && newP && oldP !== newP) dirMoves.push({ oldP, newP });
  }
  // Longer prefixes first so nested moves resolve correctly.
  dirMoves.sort((a, b) => b.newP.length - a.newP.length);

  function remapToOld(abs: string): string | undefined {
    for (const m of dirMoves) {
      if (abs === m.newP) return m.oldP;
      const prefix = m.newP.endsWith('/') ? m.newP : m.newP + '/';
      if (abs.startsWith(prefix)) return m.oldP + abs.slice(m.newP.length);
    }
    return undefined;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    stats.totalLines++;
    const parts = trimmed.split('\t');

    const rawCode = parts[0].trim().toUpperCase();
    const codeTokens = rawCode.split('+');
    const isMoved = codeTokens.includes('LM') || codeTokens.includes('MV');

    if (isMoved) {
      if (parts.length < 5) continue;
      const isDir = parts[4].trim().toLowerCase() === 'true';
      if (isDir) { stats.skippedDir++; continue; }
      const status = parseStatusCode(rawCode);
      if (!status) { stats.skippedNoStatus++; continue; }
      const oldAbs = parts[2].trim();
      const newAbs = parts[3].trim();
      if (!newAbs) continue;
      stats.byStatus[status]++;
      stats.kept++;
      const contentChanged = codeTokens.includes('CH') || codeTokens.includes('RP');
      changes.push({
        status,
        path: newAbs,
        oldPath: oldAbs || undefined,
        contentChanged: contentChanged || undefined,
      });
    } else {
      if (parts.length < 3) continue;
      const isDir = parts[2].trim().toLowerCase() === 'true';
      if (isDir) { stats.skippedDir++; continue; }
      const status = parseStatusCode(rawCode);
      if (!status) { stats.skippedNoStatus++; continue; }
      const abs = parts[1].trim();
      if (!abs) continue;
      stats.byStatus[status]++;
      stats.kept++;
      const change: PlasticChange = { status, path: abs };
      // Parent dir was moved — record base path so cm cat hits the right revision.
      if (status === ChangeStatus.Changed || status === ChangeStatus.Deleted) {
        const oldAbs = remapToOld(abs);
        if (oldAbs) change.oldPath = oldAbs;
      }
      changes.push(change);
    }
  }

  return { changes, stats };
}
