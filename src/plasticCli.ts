import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeStatus, PlasticChange, PlasticWorkspaceInfo } from './types';

// ---------- Module configuration (injected once at activation) ----------

let _output: vscode.OutputChannel | undefined;
let _cmPath = 'cm';

export function configure(output: vscode.OutputChannel, cmPath: string): void {
  _output = output;
  _cmPath = cmPath;
}

export function setCmPath(cmPath: string): void {
  _cmPath = cmPath;
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function log(msg: string): void {
  _output?.appendLine(`${timestamp()} ${msg}`);
}

/** Exposed diagnostic logger — used by contentProvider. */
export function logDiag(msg: string): void {
  _output?.appendLine(`${timestamp()} ${msg}`);
}

// ---------- Base content cache ----------
//
// Cache `cm cat path#cs:N` results keyed by `ref\0path`. Historical
// revisions are immutable in Plastic — once committed, cs:N's content
// never changes — so entries are never invalidated. New commits/branches
// generate new keys naturally; old keys just sit unused.
//
// Lives only in memory (cleared on VSCode reload). Typical working set
// is a few MB; no cap needed in practice.

const _contentCache = new Map<string, Buffer>();

/** In-flight `cm cat` Promises keyed the same way as _contentCache.
 *  If a second request arrives for a key that's already being fetched,
 *  it shares the existing Promise instead of starting another cm cat. */
const _inflight = new Map<string, Promise<Buffer>>();

function cacheKey(filePath: string, ref: string): string {
  return `${ref}\x00${filePath}`;
}

/** Clear cache — exposed as a user command for troubleshooting.
 *  NOTE: in-flight promises are intentionally NOT cleared. If a fetch is
 *  currently running, its result will land in a freshly-empty cache and
 *  stay valid. Cancelling them would race against the execFile callbacks. */
export function clearContentCache(): void {
  _contentCache.clear();
  log('content cache cleared');
}

/**
 * Warm the cache for every change that has a base revision so the Multi Diff
 * Editor opens instantly. Added has no base → skipped. Changed is typically
 * already cached by the phantom filter but we re-call `catCached` (it's a
 * cache hit — no cost) to keep the logic uniform.
 */
export async function prefetchBaseContent(
  cwd: string,
  baseCs: number,
  changes: PlasticChange[],
): Promise<void> {
  const t0 = Date.now();
  const ref = `cs:${baseCs}`;
  const eligible = changes.filter(c => c.status !== ChangeStatus.Added);
  log(`[prefetch] start: ${eligible.length} non-Added items`);
  let ok = 0, fail = 0;
  await Promise.all(eligible.map(async c => {
    try {
      await catCached(cwd, c.path, ref);
      ok++;
    } catch (e: any) {
      fail++;
      log(`[prefetch] fail ${c.path}: ${e.message}`);
    }
  }));
  log(`[prefetch] done: ${ok} ok, ${fail} fail in ${Date.now() - t0}ms`);
}

/**
 * Fetch base content at a specific revision, with caching.
 * All `cm cat` calls in the extension should go through this.
 */
async function catCached(cwd: string, filePath: string, ref: string): Promise<Buffer> {
  const key = cacheKey(filePath, ref);
  const hit = _contentCache.get(key);
  if (hit) {
    log(`[cache] HIT  ${ref} ${filePath} (${hit.length}B)`);
    return hit;
  }

  // Coalesce concurrent misses for the same key — don't spawn a second
  // cm cat while the first one is still in flight.
  const pending = _inflight.get(key);
  if (pending) {
    log(`[cache] WAIT ${ref} ${filePath} (joining in-flight)`);
    return pending;
  }

  log(`[cache] MISS ${ref} ${filePath}`);
  const promise = (async () => {
    try {
      const buf = await execBuffer(['cat', `${filePath}#${ref}`], cwd);
      _contentCache.set(key, buf);
      log(`[cache] STORE ${ref} ${filePath} (${buf.length}B, size=${_contentCache.size})`);
      return buf;
    } finally {
      // Clear in-flight whether fetch succeeded or failed; failure cases
      // should retry on the next call rather than serve a cached error.
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
}

// ---------- cm process execution ----------
//
// Plastic's `cm` takes a workspace-level lock. Standalone bench of 13
// cm cat calls showed limit=6 was 100% reliable. But in production,
// Stage 2+3 parallel runs ~24 cm cats IMMEDIATELY after `cm status --all`
// releases its lock — the combined load crosses the contention threshold
// and fails with "The workspace is busy. Try later".
//
// Observed (real cold refresh, limit=6):
//   stage1 raw status      : 6.6s  (usually 2-4s, slowed by competing load)
//   phantom/prefetch fail  : 1 file hit "workspace busy"
//
// Bench numbers (standalone, 13 cm cat only):
//   limit=1  → 38s,   100% ok
//   limit=4  → 9s,    100% ok   ← chosen (safe under real load)
//   limit=6  → 7s,    100% ok   (standalone only — flakes in production)
//   limit=8  → 5s,    ~80% ok
// Real-world limit is lower than bench; 4 is the safe ceiling.

const CM_CONCURRENCY = 4;
let _cmActive = 0;
const _cmWaiters: Array<() => void> = [];

async function acquireCmSlot(): Promise<void> {
  if (_cmActive < CM_CONCURRENCY) { _cmActive++; return; }
  await new Promise<void>(resolve => _cmWaiters.push(resolve));
  _cmActive++;
}

function releaseCmSlot(): void {
  _cmActive--;
  const next = _cmWaiters.shift();
  if (next) next();
}

async function enqueueCm<T>(task: () => Promise<T>): Promise<T> {
  await acquireCmSlot();
  try {
    return await task();
  } finally {
    releaseCmSlot();
  }
}

function execRaw(args: string[], cwd: string, encoding: 'utf8' | 'buffer'): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      _cmPath,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: encoding as BufferEncoding },
      (err, stdout, stderr) => {
        if (err) {
          const msg = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr || '');
          reject(new Error(`cm ${args[0]} failed: ${msg || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function exec(args: string[], cwd: string): Promise<string> {
  return enqueueCm(async () => {
    const tAcquired = Date.now();
    log(`[cm] start: ${args.join(' ')}`);
    try {
      const out = (await execRaw(args, cwd, 'utf8')) as string;
      log(`[cm]   done: ${args[0]} in ${Date.now() - tAcquired}ms (${out.length}B)`);
      return out;
    } catch (e: any) {
      log(`[cm]   FAIL: ${args[0]} in ${Date.now() - tAcquired}ms — ${e.message.slice(0, 120)}`);
      throw e;
    }
  });
}

/** Raw stdout Buffer — for binary-safe comparison. */
function execBuffer(args: string[], cwd: string): Promise<Buffer> {
  return enqueueCm(async () => {
    const tAcquired = Date.now();
    log(`[cm] start: ${args.join(' ')}`);
    try {
      const out = (await execRaw(args, cwd, 'buffer')) as Buffer;
      log(`[cm]   done: ${args[0]} in ${Date.now() - tAcquired}ms (${out.length}B)`);
      return out;
    } catch (e: any) {
      log(`[cm]   FAIL: ${args[0]} in ${Date.now() - tAcquired}ms — ${e.message.slice(0, 120)}`);
      throw e;
    }
  });
}

// ---------- Pending changes (cm status) ----------

/**
 * Get pending workspace changes via `cm status`.
 *
 * `cm status` is the ONLY way Plastic exposes workspace-vs-base diffs
 * (`cm diff cs:N` is parent→cs:N history). Status over-reports though —
 * byte-identical files are sometimes marked `CH` (phantom), so we run a
 * content comparison afterwards to drop them.
 *
 * Output format with `--iscochanged --fieldseparator=\t`:
 *   STATUS TAB ABS_PATH TAB ISDIR TAB MERGEINFO
 */
/** Stage 1 of pending-change fetch: raw `cm status` + parse, no phantom filter.
 *  Use `filterPhantomChanges` separately to drop byte-identical entries. */
export async function getPendingChangesRaw(cwd: string, baseCs: number): Promise<PlasticChange[]> {
  if (baseCs <= 0) {
    log(`[status] skipped — baseCs=${baseCs}`);
    return [];
  }
  const tStart = Date.now();
  let raw: string;
  try {
    raw = await exec([
      'status', '--noheader', '--all', '--machinereadable',
      '--iscochanged', '--fieldseparator=\t',
    ], cwd);
  } catch (e: any) {
    log(`[status] failed: ${e.message}`);
    return [];
  }

  const parsed: PlasticChange[] = [];
  let totalLines = 0, skippedDir = 0, skippedNoStatus = 0;
  const byStatus: Record<string, number> = { AD: 0, CH: 0, DE: 0, MV: 0 };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;
    const parts = trimmed.split('\t');

    const rawCode = parts[0].trim().toUpperCase();
    const isMoved = rawCode === 'LM' || rawCode === 'MV';

    // LM/MV: STATUS \t SIMILARITY% \t OLD_PATH \t NEW_PATH \t ISDIR \t ...
    // Other: STATUS \t PATH \t ISDIR \t ...
    if (isMoved) {
      if (parts.length < 5) continue;
      const isDir = parts[4].trim().toLowerCase() === 'true';
      if (isDir) { skippedDir++; continue; }
      const status = parseStatusCode(rawCode);
      if (!status) { skippedNoStatus++; continue; }
      const oldAbs = parts[2].trim();
      const newAbs = parts[3].trim();
      if (!newAbs) continue;
      byStatus[status] = (byStatus[status] || 0) + 1;
      parsed.push({ status, path: newAbs, oldPath: oldAbs || undefined });
    } else {
      if (parts.length < 3) continue;
      const isDir = parts[2].trim().toLowerCase() === 'true';
      if (isDir) { skippedDir++; continue; }
      const status = parseStatusCode(rawCode);
      if (!status) { skippedNoStatus++; continue; }
      const abs = parts[1].trim();
      if (!abs) continue;
      byStatus[status] = (byStatus[status] || 0) + 1;
      parsed.push({ status, path: abs });
    }
  }
  log(
    `[status] parsed: ${totalLines} lines, ` +
    `kept=${parsed.length} (A=${byStatus[ChangeStatus.Added] || 0} C=${byStatus[ChangeStatus.Changed] || 0} D=${byStatus[ChangeStatus.Deleted] || 0} M=${byStatus[ChangeStatus.Moved] || 0}) ` +
    `skip: dir=${skippedDir} noise=${skippedNoStatus} ` +
    `in ${Date.now() - tStart}ms`
  );

  return parsed;
}


/**
 * Map `cm status --machinereadable` status codes to ChangeStatus.
 * Noise codes (PR private, IG ignored, pure CO) return undefined.
 */
function parseStatusCode(s: string): ChangeStatus | undefined {
  const upper = s.toUpperCase();
  // CO+CH: checked out AND content changed → Changed
  const tokens = upper.split('+');
  if (tokens.includes('CH') && tokens.includes('CO')) return ChangeStatus.Changed;
  // Pure CO: checked out without content change — skip
  if (upper === 'CO') return undefined;

  switch (upper) {
    case 'AD':
    case 'CP':  return ChangeStatus.Added;
    case 'CH':
    case 'RP':  return ChangeStatus.Changed;
    case 'MV':
    case 'LM':  return ChangeStatus.Moved;
    case 'DE':
    case 'LD':  return ChangeStatus.Deleted;
    default:    return undefined;
  }
}

/**
 * Drop phantom Changed entries — files reported as `C` but byte-identical
 * to the base revision. Plastic does this for config files whose metadata
 * was touched by checkout without real content edits.
 */
export async function filterPhantomChanges(
  cwd: string,
  baseCs: number,
  changes: PlasticChange[],
): Promise<PlasticChange[]> {
  const t0 = Date.now();
  const ref = `cs:${baseCs}`;
  const changedCount = changes.filter(c => c.status === ChangeStatus.Changed).length;
  log(`[phantom] start: ${changedCount} Changed to verify`);
  let dropped = 0;
  const keep = await Promise.all(changes.map(async c => {
    if (c.status !== ChangeStatus.Changed) return true;
    const abs = path.isAbsolute(c.path) ? c.path : path.join(cwd, c.path);
    try {
      const [baseBuf, workBuf] = await Promise.all([
        catCached(cwd, c.path, ref),
        fs.readFile(abs),
      ]);
      const identical = baseBuf.equals(workBuf);
      if (identical) {
        dropped++;
        log(`[phantom] drop ${c.path} (${baseBuf.length}B identical)`);
      }
      return !identical;
    } catch (e: any) {
      log(`[phantom] fail ${c.path}: ${e.message}`);
      return true;
    }
  }));
  const result = changes.filter((_, i) => keep[i]);
  log(`[phantom] done: dropped ${dropped}/${changedCount} in ${Date.now() - t0}ms`);
  return result;
}

// ---------- Changeset diff (cm diff cs:X cs:Y) ----------

const FIELD_SEP = '\x1f';
const LINE_SEP = '\x1e';
const DIFF_FORMAT = `${LINE_SEP}{status}${FIELD_SEP}{path}${FIELD_SEP}{srccmpath}${FIELD_SEP}{type}`;

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseDiffStatus(s: string): ChangeStatus | undefined {
  switch (s.toUpperCase()) {
    case 'A': return ChangeStatus.Added;
    case 'C': return ChangeStatus.Changed;
    case 'D': return ChangeStatus.Deleted;
    case 'M': return ChangeStatus.Moved;
    default:  return undefined;
  }
}

/** Get diff between two changesets. */
export async function getChangesetDiff(
  cwd: string,
  fromCs: number,
  toCs: number,
): Promise<PlasticChange[]> {
  let raw: string;
  try {
    raw = await exec(['diff', `cs:${fromCs}`, `cs:${toCs}`, `--format=${DIFF_FORMAT}`], cwd);
  } catch (e: any) {
    log(`getChangesetDiff failed: ${e.message}`);
    return [];
  }

  const changes: PlasticChange[] = [];
  for (const record of raw.split(LINE_SEP)) {
    const line = record.trim();
    if (!line) continue;
    const parts = line.split(FIELD_SEP);
    if (parts.length < 4) continue;

    const status = parseDiffStatus(parts[0].trim());
    if (!status) continue;

    const p = unquote(parts[1]);
    const srcPath = unquote(parts[2]);
    const type = parts[3].trim();
    if (type === 'D' || !p) continue;

    const change: PlasticChange = { status, path: p };
    if (status === ChangeStatus.Moved && srcPath) change.oldPath = srcPath;
    changes.push(change);
  }
  return changes;
}

// ---------- File content ----------

/** Get file content at a specific revision (cached). */
export async function getFileContent(cwd: string, filePath: string, ref: string): Promise<string> {
  try {
    const buf = await catCached(cwd, filePath, ref);
    return buf.toString('utf8');
  } catch (e: any) {
    log(`cat ${filePath}#${ref} failed: ${e.message}`);
    return '';
  }
}

// ---------- Workspace metadata ----------

export async function getWorkspaceInfo(cwd: string): Promise<PlasticWorkspaceInfo | undefined> {
  try {
    const headerRaw = await exec(['status', '--header'], cwd);
    const csMatch = headerRaw.match(/cs:(\d+)/);
    const brMatch = headerRaw.match(/br:([^\s]+)/);
    const repMatch = headerRaw.match(/rep:([^@\s]+)/);

    const rootRaw = await exec(['gwp', '.', '--format={wkpath}'], cwd);
    const root = rootRaw.trim();
    if (!root) return undefined;

    return {
      root,
      branch: brMatch?.[1] || 'unknown',
      changeset: csMatch ? parseInt(csMatch[1], 10) : 0,
      repository: repMatch?.[1] || 'default',
    };
  } catch (e: any) {
    log(`getWorkspaceInfo failed: ${e.message}`);
    return undefined;
  }
}

/** Check if a directory is inside a Plastic SCM workspace. */
export async function isPlasticWorkspace(cwd: string): Promise<boolean> {
  try {
    await exec(['wi'], cwd);
    return true;
  } catch {
    return false;
  }
}
