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
    ['flow sequence', 'routingSignals:\n  peakCapabilities: ["reasoning"'],
    ['flow mapping', 'provenance: { version: "1"'],
    ['quoted scalar', 'oneLiner: "unterminated'],
    ['duplicate key', 'oneLiner: "first"\noneLiner: "second"'],
    ['unquoted Chinese colon', 'oneLiner: 深度推理: 系统设计'],
    ['tab indentation', 'routingSignals:\n\tpeakCapabilities: ["reasoning"]'],
    ['bare @ handle', 'handle: @bad'],
  ])('diagnoses invalid YAML %s while retaining a valid identity projection', (_label, fields) => {
    const markdown = `${good}\n\n\`\`\`yaml\n# structured-profile: cat:bad\nentityId: "cat:bad"\nl0RoutingNote: "Review with evidence"\n${fields}\n\`\`\``;
    const diagnostics: DossierParseDiagnostic[] = [];
    const profiles = parser.parseDossierProfiles(markdown, (diagnostic) => diagnostics.push(diagnostic));
    expect([...profiles.keys()]).toEqual(['good', 'bad']);
    expect(profiles.get('bad')).toMatchObject({ entityId: 'cat:bad', l0RoutingNote: 'Review with evidence' });
    expect(diagnostics).toEqual([{ catId: 'bad', code: 'invalid_yaml', line: 7 }]);
    expect(parser.parseDossierProfiles(markdown)).toEqual(profiles);
  });

  it.each([true, false])('keeps a repeated usable member with syntax diagnostics (valid first: %s)', (validFirst) => {
    const tolerant = good.replace('entityId: "cat:good"', 'entityId: "cat:good"\nhandle: @good');
    const blocks = validFirst ? [good, tolerant] : [tolerant, good];
    const diagnostics: DossierParseDiagnostic[] = [];
    const profiles = parser.parseDossierProfiles(blocks.join('\n\n'), (issue) => diagnostics.push(issue));
    expect([...profiles.keys()]).toEqual(['good']);
    expect(profiles.get('good')?.entityId).toBe('cat:good');
    expect(diagnostics).toEqual([{ catId: 'good', code: 'invalid_yaml', line: validFirst ? 7 : 2 }]);
  });

  it.each([
    true,
    false,
  ])('does not recover an invalid identity through a tolerant block (invalid first: %s)', (invalidFirst) => {
    const tolerant = good.replaceAll('good', 'bad').replace('entityId: "cat:bad"', 'entityId: "cat:bad"\nhandle: @bad');
    const blocks = invalidFirst ? [missingIdentity, tolerant] : [tolerant, missingIdentity];
    const diagnostics: DossierParseDiagnostic[] = [];
    const profiles = parser.parseDossierProfiles([good, ...blocks].join('\n\n'), (issue) => diagnostics.push(issue));
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics.map((issue) => issue.code).sort()).toEqual(['invalid_identity', 'invalid_yaml']);
  });

  it('accepts literal brackets and backticks in valid quoted and block scalars', () => {
    const markdown = good.replace(
      'entityId: "cat:good"',
      'entityId: "cat:good"\noneLiner: "Literal [ and { and ```"\nnotes: |\n  An unmatched [ is plain text here.\n  ```',
    );
    for (const indent of ['', '  ']) {
      const diagnostics: DossierParseDiagnostic[] = [];
      const indented = markdown
        .split('\n')
        .map((line) => indent + line)
        .join('\n');
      const profiles = parser.parseDossierProfiles(indented, (diagnostic) => diagnostics.push(diagnostic));
      expect(profiles.get('good')?.oneLiner).toBe('Literal [ and { and ```');
      expect(diagnostics).toEqual([]);
    }
  });

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

  it.each([
    ['invalid identity', missingIdentity, 'invalid_identity', false],
    [
      'tolerated syntax',
      good.replaceAll('good', 'bad').replace('entityId: "cat:bad"', 'entityId: "cat:bad"\nhandle: @bad'),
      'invalid_yaml',
      true,
    ],
  ])('caches %s diagnostics with the projected profiles and clears them on repair', (_label, block, code, usable) => {
    const root = mkdtempSync(join(tmpdir(), 'dossier-diagnostics-'));
    roots.push(root);
    const directory = join(root, 'docs', 'team');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'cat-dossier.md');
    writeFileSync(path, `${good}\n\n${block}`);
    const parse = vi.spyOn(parser, 'parseDossierProfiles');
    const first = loadDossierProfilesWithDiagnostics(root);
    const cached = loadDossierProfilesWithDiagnostics(root);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cached.profiles).toBe(first.profiles);
    expect(cached.diagnostics).toEqual([{ catId: 'bad', code, line: 7 }]);
    expect(cached.profiles.has('bad')).toBe(usable);
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
