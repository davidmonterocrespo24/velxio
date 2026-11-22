import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  stringify,
  visit,
} from 'yaml';
import type { Document, Node, Pair, YAMLMap } from 'yaml';
import type { Candidate } from './codeCompletions';
import type { WorkspaceFile } from '../store/useEditorStore';

function mappingPath(path: readonly (Document | Node | Pair)[]) {
  return JSON.stringify(
    path.flatMap((part) => {
      if (isPair(part) && isScalar(part.key)) return [String(part.key.value)];
      return isSeq(part) ? [null] : [];
    }),
  );
}

const manifestKeys = [
  'version',
  'description',
  'dependencies',
  'targets',
  'license',
  'url',
  'repository',
  'documentation',
  'issues',
  'maintainers',
  'tags',
  'files',
  'examples',
];

interface Schema {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  type?: string;
  $ref?: string;
}

const schemas = new WeakMap<WorkspaceFile, Schema>();
function workspaceSchema(
  name: string,
  text: string,
  files: WorkspaceFile[],
  path: string,
): Schema | undefined {
  const ref = /^#\s*yaml-language-server:\s*\$schema=([^\s]+)\s*$/m.exec(text)?.[1];
  if (!ref || /^(?:[a-z]+:|\/\/)/i.test(ref)) return;
  try {
    const url = new URL(ref, new URL(name, 'file:///'));
    const file = files.find((f) => f.name === decodeURIComponent(url.pathname.slice(1)));
    if (!file) return;
    const root: Schema = schemas.get(file) ?? JSON.parse(file.content);
    schemas.set(file, root);
    let schema: Schema | undefined = root;
    for (const key of [...JSON.parse(path), undefined]) {
      const seen = new Set<string>();
      while (schema?.$ref?.startsWith('#/') && !seen.has(schema.$ref)) {
        seen.add(schema.$ref);
        let target: Record<string, unknown> = root as Record<string, unknown>;
        for (const field of schema.$ref.slice(2).split('/')) {
          const part = field.replaceAll('~1', '/').replaceAll('~0', '~');
          if (!target || !Object.hasOwn(target, part)) return;
          target = target[part] as Record<string, unknown>;
        }
        schema = target;
      }
      if (key === undefined || !schema) return schema;
      schema = key === null ? schema.items : schema.properties?.[key];
    }
  } catch {
    // A schema may itself be incomplete while its tab is being edited.
  }
}

export function yamlCandidates(
  name: string,
  text: string,
  offset: number,
  files: WorkspaceFile[] = [],
) {
  const prefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  const fragment = /[\w./-]*$/.exec(prefix)![0];
  const start = offset - fragment.length;
  const end = offset + /^[\w./-]*/.exec(text.slice(offset))![0].length;
  const before = prefix.slice(0, prefix.length - fragment.length);
  const alias = before.endsWith('*');
  const needsSpace = before.endsWith(':') && !fragment;
  const existingColon = /^[ \t]*:(?=\s|$)/.test(text.slice(end));
  const key = !alias && /^\s*(?:-\s+)?$/.test(before);
  const suggestions: Candidate[] = [];
  // Turn the unfinished token into a complete node so indentation, sequence
  // membership, quotes, block scalars and document boundaries come from YAML.
  const marker = 'velxio_completion_cursor';
  const cursor = start + Number(needsSpace);
  const source =
    text.slice(0, start) +
    (needsSpace ? ' ' : '') +
    marker +
    (key && !existingColon ? ': ' : '') +
    text.slice(end);
  for (const doc of parseAllDocuments(source, { logLevel: 'silent' })) {
    if (!doc.range || start < doc.range[0] || start > doc.range[2]) continue;
    let currentMap: YAMLMap | undefined;
    let context: string | undefined;
    const maps: { path: string; node: YAMLMap }[] = [];
    const values: { path: string; label: string }[] = [];
    const anchors = new Set<string>();
    visit(doc, (role, node, path) => {
      if (!isNode(node)) return;
      if ('anchor' in node && node.anchor && node.range && node.range[0] < start)
        anchors.add(node.anchor);
      if (isMap(node)) maps.push({ path: mappingPath(path), node });
      if (isAlias(node) && node.source === marker && node.range?.[0] === start - 1)
        context = mappingPath(path);
      if (!isScalar(node)) return;
      if (node.range?.[0] === cursor && node.value === marker) {
        if (role === 'key') {
          const parent = path.at(-2);
          if (isMap(parent)) {
            currentMap = parent;
            context = mappingPath(path.slice(0, -2));
          }
        } else if (!key) context = mappingPath(path);
      } else if (
        role !== 'key' &&
        node.type === 'PLAIN' &&
        node.source &&
        node.source.length < 80
      ) {
        values.push({ path: mappingPath(path), label: node.source });
      }
    });
    if (context === undefined) break;
    const schema = workspaceSchema(name, text, files, context);
    const priorValues = values.filter((v) => v.path === context).map((v) => v.label);
    const scalarItem =
      /^\s*-\s+$/.test(before) &&
      (priorValues.length > 0 || schema?.enum || (schema?.type && schema.type !== 'object'));
    if (alias) {
      for (const label of anchors)
        suggestions.push({ label, kind: 'Reference', detail: 'YAML anchor' });
    } else if (currentMap && !scalarItem) {
      const keys = new Set(Object.keys(schema?.properties ?? {}));
      for (const map of maps) {
        if (map.path === context && map.node !== currentMap) {
          for (const pair of map.node.items) {
            if (isScalar(pair.key) && pair.key.type === 'PLAIN') keys.add(String(pair.key.value));
          }
        }
      }
      if (/(^|\/)idf_component\.ya?ml$/i.test(name)) {
        if (context === '[]') manifestKeys.forEach((k) => keys.add(k));
        if (context === '["dependencies"]') keys.add('idf');
      }
      for (const pair of currentMap?.items ?? []) {
        if (isScalar(pair.key)) keys.delete(String(pair.key.value));
      }
      for (const label of keys)
        suggestions.push({
          label,
          kind: 'Property',
          insertText: stringify(label).trimEnd() + (existingColon ? '' : ': '),
        });
      if (!existingColon && !keys.size) {
        suggestions.push(
          {
            label: 'mapping',
            kind: 'Snippet',
            detail: 'YAML key and value',
            insertText: '${1:key}: ${2:value}',
          },
          {
            label: 'sequence',
            kind: 'Snippet',
            detail: 'YAML sequence',
            insertText: '${1:items}:\n  - ${2:value}',
          },
        );
      }
    } else {
      const allowed = schema?.enum ?? (schema?.const !== undefined ? [schema.const] : undefined);
      const defaults =
        schema?.type === 'boolean'
          ? ['true', 'false']
          : schema?.type === 'null'
            ? ['null']
            : schema?.type
              ? []
              : ['true', 'false', 'null'];
      const labels = new Set(
        Array.isArray(allowed)
          ? allowed
              .filter((v) => v === null || ['number', 'boolean', 'string'].includes(typeof v))
              .map((v) => stringify(v).trimEnd())
          : [...priorValues, ...defaults],
      );
      for (const label of labels)
        suggestions.push({ label, kind: 'Value', insertText: needsSpace ? ' ' + label : label });
    }
    break;
  }
  return { suggestions, start, end };
}
