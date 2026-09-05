import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDossierCache,
  loadDossierProfiles,
  loadDossierProfilesWithDiagnostics,
} from '../dossier/load-dossier-profiles.js';
import type { DossierParseDiagnostic } from '../dossier/parse-dossier-profiles.js';
import * as parser from '../dossier/parse-dossier-profiles.js';

const good = ['```yaml', '# structured-profile: cat:good', 'entityId: "cat:good"', '```'].join('\n');
const missingIdentity = ['```yaml', '# structured-profile: cat:bad', 'oneLiner: "Incomplete record"', '```'].join('\n');
const roots: string[] = [];

afterEach(() => {
  _resetDossierCache();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical dossier parse diagnostics', () => {
  it.each([
    ['missing', '', 'invalid_identity'],
    ['malformed', 'entityId: "unterminated', 'invalid_identity'],
    ['nested', 'identity:\n  entityId: "cat:bad"', 'invalid_identity'],
    ['wrong member', 'entityId: "cat:good"', 'identity_mismatch'],
  ])('reports a %s identity with its marker line while retaining a valid peer', (_label, identity, code) => {
    const markdown = `${good}\n\n\`\`\`yaml\n# structured-profile: cat:bad\n${identity}\n\`\`\``;
    const diagnostics: DossierParseDiagnostic[] = [];
    const profiles = parser.parseDossierProfiles(markdown, (diagnostic) => diagnostics.push(diagnostic));
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([{ catId: 'bad', code, line: 7 }]);
    expect([...parser.parseDossierProfiles(markdown).keys()]).toEqual(['good']);
  });

  it('reports an unterminated marked block from the same traversal', () => {
    const diagnostics: DossierParseDiagnostic[] = [];
    const markdown = `${good}\n\n\`\`\`yaml\n# structured-profile: cat:bad\nentityId: "cat:bad"`;
    expect([...parser.parseDossierProfiles(markdown, (issue) => diagnostics.push(issue)).keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([{ catId: 'bad', code: 'unterminated_block', line: 7 }]);
  });

  it.each([true, false])('never resurrects a malformed member from another block (valid first: %s)', (validFirst) => {
    const validBad = good.replaceAll('good', 'bad');
    const blocks = validFirst ? [validBad, missingIdentity] : [missingIdentity, validBad];
    const diagnostics: DossierParseDiagnostic[] = [];
    const profiles = parser.parseDossierProfiles([good, ...blocks].join('\n\n'), (issue) => diagnostics.push(issue));
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].catId).toBe('bad');
  });

  it('ignores ordinary unmarked YAML and accepts valid CRLF profiles without diagnostics', () => {
    const diagnostics: DossierParseDiagnostic[] = [];
    const markdown = `\`\`\`yaml\nunrelated: "unterminated\n\`\`\`\n${good}`.replaceAll('\n', '\r\n');
    expect([...parser.parseDossierProfiles(markdown, (issue) => diagnostics.push(issue)).keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([]);
  });

  it('caches diagnostics with the canonical profiles and clears them when the file is repaired', () => {
    const root = mkdtempSync(join(tmpdir(), 'dossier-diagnostics-'));
    roots.push(root);
    const directory = join(root, 'docs', 'team');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'cat-dossier.md');
    writeFileSync(path, `${good}\n\n${missingIdentity}`);
    const parse = vi.spyOn(parser, 'parseDossierProfiles');
    const first = loadDossierProfilesWithDiagnostics(root);
    const cached = loadDossierProfilesWithDiagnostics(root);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cached.profiles).toBe(first.profiles);
    expect(cached.diagnostics).toEqual([{ catId: 'bad', code: 'invalid_identity', line: 7 }]);
    expect(loadDossierProfiles(root)).toBe(first.profiles);
    expect(parse).toHaveBeenCalledTimes(1);
    writeFileSync(path, `${good}\n\n${good.replaceAll('good', 'bad')}`);
    const repaired = loadDossierProfilesWithDiagnostics(root);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(repaired.available).toBe(true);
    expect(repaired.profiles.has('bad')).toBe(true);
    expect(repaired.diagnostics).toEqual([]);
  });
});
