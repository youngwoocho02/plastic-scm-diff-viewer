#!/usr/bin/env node
/**
 * Headless self-check for the SCM parser.
 *
 * Runs `cm status` against the given workspace, feeds the raw output through
 * the same `parseStatusOutput` the extension uses, and prints both the parsed
 * result and invariant checks — so regressions can be caught without opening
 * VSCode.
 *
 * Usage: npx tsx scripts/inspect-pending.ts <workspace-path> [--json]
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseStatusOutput } from '../src/statusParser';
import { ChangeStatus } from '../src/types';

const execFileP = promisify(execFile);

async function main(): Promise<void> {
  const cwd = process.argv[2];
  const jsonOut = process.argv.includes('--json');
  if (!cwd) {
    console.error('usage: inspect-pending <workspace-path> [--json]');
    process.exit(2);
  }

  const { stdout } = await execFileP(
    'cm',
    ['status', '--noheader', '--all', '--machinereadable', '--iscochanged', '--fieldseparator=\t'],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );

  const { changes, stats } = parseStatusOutput(stdout);

  const rawCodes = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const code = t.split('\t')[0].trim().toUpperCase();
    rawCodes.set(code, (rawCodes.get(code) ?? 0) + 1);
  }

  const fails: string[] = [];
  const pctPath = changes.filter(c => /^\d+(\.\d+)?%$/.test(c.path) || /^\d+(\.\d+)?%$/.test(c.oldPath ?? ''));
  if (pctPath.length) fails.push(`${pctPath.length} entries have a "%" literal as path (parser column shift)`);

  const movedNoOld = changes.filter(c => c.status === ChangeStatus.Moved && !c.oldPath);
  if (movedNoOld.length) fails.push(`${movedNoOld.length} Moved entries missing oldPath`);

  const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const relPath = changes.filter(c => !isAbs(c.path) || (c.oldPath !== undefined && !isAbs(c.oldPath)));
  if (relPath.length) fails.push(`${relPath.length} entries have non-absolute path/oldPath`);

  if (jsonOut) {
    console.log(JSON.stringify({ stats, rawCodes: Object.fromEntries(rawCodes), changes, fails }, null, 2));
    process.exit(fails.length ? 1 : 0);
  }

  console.log(`raw codes: ${Array.from(rawCodes.entries()).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    `parsed: total=${stats.totalLines} kept=${stats.kept} ` +
    `A=${stats.byStatus[ChangeStatus.Added]} C=${stats.byStatus[ChangeStatus.Changed]} ` +
    `D=${stats.byStatus[ChangeStatus.Deleted]} M=${stats.byStatus[ChangeStatus.Moved]} ` +
    `skipDir=${stats.skippedDir} skipNoise=${stats.skippedNoStatus}`,
  );

  const sample = changes.filter(c => c.status === ChangeStatus.Moved).slice(0, 5);
  if (sample.length) {
    console.log('\nMoved sample:');
    for (const c of sample) console.log(`  ${c.oldPath}\n    → ${c.path}${c.contentChanged ? '  [+M]' : ''}`);
  }

  if (fails.length) {
    console.error('\nFAIL:');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nOK — invariants hold.');
}

main().catch(e => { console.error(e); process.exit(2); });
