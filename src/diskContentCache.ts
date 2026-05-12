import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const CACHE_VERSION = 'v1';
const MAX_CHANGESET_DIRS = 10;

let cacheRoot: string | undefined;
let maintenance = Promise.resolve();

interface IndexEntry {
  path: string;
  ref: string;
  size: number;
  lastAccess: number;
}

interface CacheIndex {
  entries: Record<string, IndexEntry>;
}

function hash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizePath(filePath: string): string {
  let s = filePath.replace(/\\/g, '/');
  if (s.length >= 2 && /^[A-Z]$/.test(s[0]) && s[1] === ':') {
    s = s[0].toLowerCase() + s.slice(1);
  }
  return s;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return (cleaned || 'file').slice(0, 120);
}

function changesetNumber(ref: string): string | undefined {
  const match = /^cs:(\d+)$/.exec(ref);
  return match?.[1];
}

function entryPath(ref: string, filePath: string): { csDir: string; filesDir: string; fileName: string; fullPath: string } | undefined {
  if (!cacheRoot) return undefined;
  const cs = changesetNumber(ref);
  if (!cs) return undefined;

  const normalized = normalizePath(filePath);
  const baseName = sanitizeFileName(path.basename(normalized));
  const fileName = `${hash(`${ref}\0${normalized}`).slice(0, 16)}__${baseName}`;
  const csDir = path.join(cacheRoot, `cs-${cs}`);
  const filesDir = path.join(csDir, 'files');
  return { csDir, filesDir, fileName, fullPath: path.join(filesDir, fileName) };
}

async function touchDir(dir: string): Promise<void> {
  const now = new Date();
  try {
    await fs.utimes(dir, now, now);
  } catch {
    // Best-effort metadata only.
  }
}

async function atomicWrite(filePath: string, data: Buffer | string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, filePath);
}

async function readIndex(indexPath: string): Promise<CacheIndex> {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as CacheIndex;
    return parsed && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function enqueueMaintenance(task: () => Promise<void>): void {
  maintenance = maintenance.then(task, task).catch(() => {});
}

async function updateIndex(csDir: string, fileName: string, ref: string, filePath: string, size: number): Promise<void> {
  const indexPath = path.join(csDir, 'index.json');
  const index = await readIndex(indexPath);
  index.entries[fileName] = {
    path: normalizePath(filePath),
    ref,
    size,
    lastAccess: Date.now(),
  };
  await atomicWrite(indexPath, JSON.stringify(index, null, 2));
}

export function configureDiskContentCache(globalStorageUri: vscode.Uri, workspaceRoot: string): void {
  const workspaceHash = hash(normalizePath(workspaceRoot)).slice(0, 16);
  cacheRoot = path.join(globalStorageUri.fsPath, 'plastic-diff-cache', CACHE_VERSION, workspaceHash);
  enqueueMaintenance(async () => {
    await fs.mkdir(cacheRoot!, { recursive: true });
    await pruneDiskContentCache();
  });
}

export async function readDiskContent(ref: string, filePath: string): Promise<Buffer | undefined> {
  const entry = entryPath(ref, filePath);
  if (!entry) return undefined;

  try {
    const buf = await fs.readFile(entry.fullPath);
    await touchDir(entry.csDir);
    enqueueMaintenance(() => updateIndex(entry.csDir, entry.fileName, ref, filePath, buf.length));
    return buf;
  } catch {
    return undefined;
  }
}

export async function writeDiskContent(ref: string, filePath: string, content: Buffer): Promise<void> {
  const entry = entryPath(ref, filePath);
  if (!entry) return;

  await fs.mkdir(entry.filesDir, { recursive: true });
  await atomicWrite(entry.fullPath, content);
  await touchDir(entry.csDir);
  enqueueMaintenance(async () => {
    await updateIndex(entry.csDir, entry.fileName, ref, filePath, content.length);
    await pruneDiskContentCache();
  });
}

export async function clearDiskContentCache(): Promise<void> {
  if (!cacheRoot) return;
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(cacheRoot, { recursive: true });
}

export async function pruneDiskContentCache(): Promise<void> {
  if (!cacheRoot) return;

  let entries: Array<{ name: string; fullPath: string; mtimeMs: number }>;
  try {
    const names = await fs.readdir(cacheRoot);
    entries = [];
    for (const name of names) {
      if (!/^cs-\d+$/.test(name)) continue;
      const fullPath = path.join(cacheRoot, name);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        entries.push({ name, fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  } catch {
    return;
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(MAX_CHANGESET_DIRS)) {
    await fs.rm(entry.fullPath, { recursive: true, force: true });
  }
}
