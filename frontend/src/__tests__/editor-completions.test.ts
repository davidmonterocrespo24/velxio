import { describe, expect, it } from 'vitest';
import { codeCandidates } from '../lib/codeCompletions';
import { yamlCandidates } from '../lib/yamlCompletions';

function complete(
  name: string,
  source: string,
  siblings: Record<string, string> = {},
  micro = false,
) {
  const offset = source.indexOf('|');
  const file = { id: name, name, content: source.replace('|', ''), modified: true };
  const files = [
    file,
    ...Object.entries(siblings).map(([name, content]) => ({
      name,
      content,
      id: name,
      modified: false,
    })),
  ];
  const prefix = source.slice(0, offset).split('\n').at(-1)!;
  return codeCandidates(file, files, offset, prefix, micro).map((item) => item.label);
}

describe('local C++ completions', () => {
  const headers = { 'sensor.hxx': 'struct Sensor { int level; void read(); };' };
  it('offers methods and fields from an unsaved header after pointer access', () => {
    expect(complete('main.ino', 'Sensor *sensor; void loop() { sensor->| }', headers)).toEqual([
      'level',
      'read',
    ]);
  });
  it('respects block scope and resolves namespace members', () => {
    const source = 'namespace io { int port; } void first() { int hidden; } void next(int pin) { ';
    expect(complete('main.cpp', source + 'io::| }')).toEqual(['port']);
    const visible = complete('main.cpp', source + '| }');
    expect(visible).toContain('pin');
    expect(visible).not.toContain('hidden');
  });
  it('uses included standard headers and the declared container type', () => {
    const start = '#include <vector>\nstd::vector<int> samples;\nvoid loop() { ';
    expect(complete('main.cxx', start + 'std::| }')).toContain('vector');
    expect(complete('main.cxx', start + 'samples.| }')).toContain('push_back');
  });
});

describe('local Python completions', () => {
  it('offers built-ins while an identifier is still being typed in an expression', () => {
    const matches = complete('script.py', 'answer = pr|').filter((name) => name.startsWith('pr'));
    expect(matches).toEqual(expect.arrayContaining(['print', 'property']));
    expect(complete('script.py', 'answer = enu|')).toContain('enumerate');
  });
  it('indexes imported standard modules and built-in types', () => {
    expect(complete('script.py', 'import statistics as stats\nstats.med|')).toContain('median');
    expect(complete('script.py', 'data = {}\ndata.setd|')).toContain('setdefault');
    expect(complete('script.py', 'value = "hello".upp|')).toContain('upper');
    expect(complete('script.py', 'def fetch() -> str: return "text"\nfetch().low|')).toContain(
      'lower',
    );
  });
  it('resolves imported user classes and aliased MicroPython constructors', () => {
    expect(
      complete('main.py', 'from sensor import Reader as R\nr = R()\nr.|', {
        'sensor.py': 'class Reader:\n    def sample(self):\n        pass',
      }),
    ).toContain('sample');
    expect(
      complete('main.py', 'from machine import Pin as P\nled = P(2)\nled.|', {}, true),
    ).toContain('value');
  });
  it('suggests the active module, parameters and built-ins without leaking other function locals', () => {
    const names = complete('main.py', 'def first():\n    hidden = 1\ndef read(pin):\n    |');
    expect(names).toEqual(expect.arrayContaining(['first', 'pin', 'print']));
    expect(names).not.toContain('hidden');
  });
  it('offers the contents of a local module in from-import statements', () => {
    expect(
      complete('main.py', 'from helper import |', { 'helper.py': 'def blink(): pass' }),
    ).toEqual(['blink']);
  });
});

function yaml(source: string, name = 'config.yaml') {
  const offset = source.indexOf('|');
  return yamlCandidates(name, source.replace('|', ''), offset).suggestions;
}

describe('YAML completions', () => {
  it('uses keys from the same sequence structure and omits keys already present', () => {
    expect(
      yaml(
        'unrelated:\n  other: 2\nsensors:\n  - pin: 1\n    name: first\n  - name: second\n    p|',
      ),
    ).toEqual([{ label: 'pin', insertText: 'pin: ', kind: 'Property' }]);
    expect(yaml('sensors:\n  - pin: 1\n  - p|: 2')[0].insertText).toBe('pin');
  });
  it('suggests previous anchors only in the current YAML document', () => {
    const names = yaml('x: &old 1\n---\ny: &current 2\nref: *cu|\nz: &later 3').map((x) => x.label);
    expect(names).toEqual(['current']);
  });
  it('completes scalar values and ESP-IDF manifest fields', () => {
    expect(yaml('enabled: tr|').map((x) => x.label)).toContain('true');
    expect(yaml('dependencies:\n  i|', 'main/idf_component.yml').map((x) => x.label)).toEqual([
      'idf',
    ]);
    expect(yaml('# enabled: tr|')).toEqual([]);
    expect(yaml('enabled:|').find((x) => x.label === 'true')?.insertText).toBe(' true');
    expect(yaml('modes:\n  - output\n  - ou|').map((x) => x.label)).toContain('output');
  });
  it('reads nested properties and enum values from a workspace schema', () => {
    const schema = {
      properties: { sensors: { type: 'array', items: { $ref: '#/$defs/sensor' } } },
      $defs: { sensor: { properties: { mode: { enum: ['input', 'output'] } } } },
    };
    const file = {
      name: 'schemas/config.json',
      id: 'schema',
      modified: true,
      content: JSON.stringify(schema),
    };
    const start = '# yaml-language-server: $schema=../schemas/config.json\nsensors:\n  - ';
    const labels = (suffix: string) =>
      yamlCandidates('src/config.yml', start + suffix, start.length + suffix.length, [
        file,
      ]).suggestions.map((item) => item.label);
    expect(labels('mo')).toEqual(['mode']);
    expect(labels('mode: ')).toEqual(['input', 'output']);
  });
});
