/**
 * Sync test — `PERMISSION_CATALOG` must agree with `docs/PLUGIN_PERMISSIONS.md`.
 *
 * The markdown table is the human-readable reference; the TS constant
 * is the runtime source of truth. Drift between them = drift between
 * what the user sees in the docs and what the consent dialog renders.
 *
 * The parser is deliberately minimal — it only understands the catalog
 * table (the line that starts with `| Permission`). Adding a new column
 * to the table without updating this parser is a CI fail.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PERMISSION_CATALOG, type PermissionRisk } from '../src/permissions-catalog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(__dirname, '../../../docs/PLUGIN_PERMISSIONS.md');

interface ParsedRow {
  readonly permission: string;
  readonly risk: PermissionRisk;
  readonly allows: string;
  readonly denies: string;
}

function stripBackticks(s: string): string {
  return s.replace(/`/g, '').trim();
}

function parseMarkdownCatalog(md: string): ReadonlyArray<ParsedRow> {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) =>
    /^\|\s*Permission\s*\|\s*Risk\s*\|/i.test(l),
  );
  if (headerIdx === -1) {
    throw new Error('Could not find catalog table header in PLUGIN_PERMISSIONS.md');
  }
  // Skip header (headerIdx) + separator (headerIdx+1).
  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || !line.startsWith('|')) break;
    // Split on `|` and discard the leading/trailing empty cells.
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const [permRaw, riskRaw, allows, denies] = cells;
    const permission = stripBackticks(permRaw);
    const risk = riskRaw.trim().toLowerCase() as PermissionRisk;
    if (risk !== 'low' && risk !== 'medium' && risk !== 'high') {
      throw new Error(`Unknown risk class "${riskRaw}" for "${permission}"`);
    }
    rows.push({ permission, risk, allows: allows.trim(), denies: denies.trim() });
  }
  return rows;
}

describe('PERMISSION_CATALOG ↔ PLUGIN_PERMISSIONS.md sync', () => {
  const md = readFileSync(DOC_PATH, 'utf8');
  const parsedRows = parseMarkdownCatalog(md);

  it('parses the markdown catalog table without error', () => {
    expect(parsedRows.length).toBeGreaterThan(0);
  });

  it('every PERMISSION_CATALOG entry has a row in the markdown table with the same risk class', () => {
    const docByPerm = new Map(parsedRows.map((r) => [r.permission, r] as const));
    const missingFromDoc: string[] = [];
    const riskMismatches: Array<{ perm: string; doc: PermissionRisk; code: PermissionRisk }> = [];
    for (const entry of PERMISSION_CATALOG) {
      const docRow = docByPerm.get(entry.permission);
      if (docRow === undefined) {
        missingFromDoc.push(entry.permission);
        continue;
      }
      if (docRow.risk !== entry.risk) {
        riskMismatches.push({
          perm: entry.permission,
          doc: docRow.risk,
          code: entry.risk,
        });
      }
    }
    expect(missingFromDoc).toEqual([]);
    expect(riskMismatches).toEqual([]);
  });

  it('every markdown row has a PERMISSION_CATALOG entry', () => {
    const codeByPerm = new Set(PERMISSION_CATALOG.map((e) => e.permission));
    const missingFromCode: string[] = [];
    for (const row of parsedRows) {
      if (!codeByPerm.has(row.permission as never)) {
        missingFromCode.push(row.permission);
      }
    }
    expect(missingFromCode).toEqual([]);
  });
});
