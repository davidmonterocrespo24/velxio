import type { SyntaxNode } from '@lezer/common';
import { parser as cpp } from '@lezer/cpp';
import { parser as python } from '@lezer/python';
import type { WorkspaceFile } from '../store/useEditorStore';
import { getEditorLanguage } from './editorLanguages';
import pythonSymbols from '../data/completions/python.symbols?raw';
import microSymbols from '../data/completions/micropython.symbols?raw';
import cppSymbols from '../data/completions/cpp.symbols?raw';

export interface Candidate {
  label: string;
  kind:
    | 'Keyword'
    | 'Function'
    | 'Variable'
    | 'Class'
    | 'Method'
    | 'Field'
    | 'Module'
    | 'Constant'
    | 'File'
    | 'Property'
    | 'Value'
    | 'Snippet'
    | 'Reference';
  detail?: string;
  insertText?: string;
}

interface Declaration extends Candidate {
  scope?: SyntaxNode;
  owner?: string;
  type?: string;
  offset: number;
}

function words(names: string, kind: Candidate['kind'], detail?: string): Candidate[] {
  return names.split(' ').map((label) => ({ label, kind, detail }));
}

// Index identifiers from the language references by their declaring scope. The
// catalog is decoded once on first use of that language, outside the typing loop.
function catalog(source: string, library: string) {
  let scopes: Map<string, Candidate[]> | undefined;
  return (owner: string): Candidate[] => {
    if (!scopes) {
      scopes = new Map();
      for (const line of source.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const [scope, kind, names] = line.split('\t');
        const group = scopes.get(scope) ?? [];
        group.push(...words(names, kind as Candidate['kind'], scope || library));
        scopes.set(scope, group);
      }
    }
    return scopes.get(owner) ?? [];
  };
}

const pythonLibrary = catalog(pythonSymbols, 'Python standard library');
const microLibrary = catalog(microSymbols, 'MicroPython');
const cppLibrary = catalog(cppSymbols, 'C/C++ standard library');
export const standardHeaders = words(
  'algorithm any array atomic barrier bit bitset cassert cctype cerrno cfenv cfloat charconv chrono cinttypes ciso646 climits clocale cmath codecvt compare complex concepts condition_variable coroutine csetjmp csignal cstdarg cstddef cstdint cstdio cstdlib cstring ctime cuchar cwchar cwctype deque exception execution expected filesystem flat_map flat_set format forward_list fstream functional future generator initializer_list iomanip ios iosfwd iostream istream iterator latch limits list locale map mdspan memory memory_resource mutex new numbers numeric optional ostream print queue random ranges ratio regex scoped_allocator semaphore set shared_mutex source_location span spanstream sstream stack stacktrace stdexcept stdfloat stop_token streambuf string string_view strstream syncstream system_error thread tuple type_traits typeindex typeinfo unordered_map unordered_set utility valarray variant vector version assert.h complex.h ctype.h errno.h fenv.h float.h inttypes.h iso646.h limits.h locale.h math.h setjmp.h signal.h stdalign.h stdarg.h stdatomic.h stdbool.h stddef.h stdint.h stdio.h stdlib.h stdnoreturn.h string.h tgmath.h threads.h time.h uchar.h wchar.h wctype.h',
  'File',
  'C/C++ standard header',
);
const pythonKeywords = words(
  'and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try type while with yield',
  'Keyword',
);
const cppKeywords = words(
  'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if import inline int long module mutable namespace new noexcept not not_eq nullptr operator or or_eq override private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq',
  'Keyword',
);

function* children(node: SyntaxNode) {
  for (let child = node.firstChild; child; child = child.nextSibling) yield child;
}

function ancestor(node: SyntaxNode, names: string[]) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (names.includes(parent.name)) return parent;
  }
}

function pythonValueType(node: SyntaxNode | null | undefined, content: string): string | undefined {
  if (!node) return;
  switch (node.name) {
    case 'String':
      return 'str';
    case 'ArrayExpression':
    case 'ArrayComprehensionExpression':
      return 'list';
    case 'DictionaryExpression':
    case 'DictionaryComprehensionExpression':
      return 'dict';
    case 'TupleExpression':
      return 'tuple';
    case 'SetExpression':
    case 'SetComprehensionExpression':
      return 'set';
    case 'CallExpression':
      return pythonValueType(node.firstChild, content);
    case 'VariableName':
    case 'MemberExpression':
      return content.slice(node.from, node.to);
  }
}

type NodeText = (node?: SyntaxNode | null) => string;
type AddDeclaration = (
  name: SyntaxNode | null,
  kind: Candidate['kind'],
  type?: string,
  scopeNode?: SyntaxNode,
) => void;

function collectPython(node: SyntaxNode, value: NodeText, add: AddDeclaration, content: string) {
  const name = node.getChild('VariableName');
  if (node.name === 'ClassDefinition') add(name, 'Class');
  if (node.name === 'FunctionDefinition')
    add(name, 'Function', value(node.getChild('TypeDef')?.firstChild));
  if (node.name === 'ImportStatement') {
    const parts = [...children(node)];
    const split = parts.findIndex((part) => part.name === 'import');
    const module =
      value(node.firstChild) === 'from' ? parts.slice(1, split).map(value).join('') + '.' : '';
    const imports = parts.slice(split + 1).filter((part) => !['(', ')'].includes(part.name));
    for (let i = 0; i < imports.length; ) {
      const start = i;
      while (i < imports.length && !['as', ','].includes(imports[i].name)) i++;
      const target = imports.slice(start, i).map(value).join('');
      const alias = imports[i]?.name === 'as' ? imports[++i] : undefined;
      if (imports[start]?.name === 'VariableName')
        add(
          alias ?? imports[start],
          module ? 'Variable' : 'Module',
          module + (alias || module ? target : value(imports[start])),
        );
      if (alias) i++;
      if (imports[i]?.name === ',') i++;
    }
  }
  if (node.name === 'AssignStatement') {
    const lhs = node.firstChild;
    const rhs = node.getChild('AssignOp')?.nextSibling;
    const type = pythonValueType(rhs, content);
    if (lhs?.name === 'VariableName')
      add(lhs, 'Variable', type || value(node.getChild('TypeDef')).slice(1).trim());
    if (lhs?.name === 'MemberExpression' && value(lhs.firstChild) === 'self') {
      const method = ancestor(node, ['FunctionDefinition']);
      if (method) add(lhs.getChild('PropertyName'), 'Field', type, method);
    }
  }
  if (node.name === 'ForStatement') add(name, 'Variable');
  if (node.name === 'ParamList') {
    for (const part of children(node)) {
      if (
        part.name === 'VariableName' &&
        ['(', ',', '*', '**'].includes(part.prevSibling?.name ?? '')
      )
        add(
          part,
          'Variable',
          part.nextSibling?.name === 'TypeDef'
            ? value(part.nextSibling).slice(1).trim()
            : undefined,
        );
    }
  }
}

function collectCpp(node: SyntaxNode, value: NodeText, add: AddDeclaration) {
  if (
    [
      'StructSpecifier',
      'ClassSpecifier',
      'EnumSpecifier',
      'AliasDeclaration',
      'TypeDefinition',
    ].includes(node.name)
  )
    add(node.getChild('TypeIdentifier'), 'Class');
  if (node.name === 'NamespaceDefinition') add(node.getChild('Identifier'), 'Module');
  if (node.name === 'Enumerator') add(node.getChild('Identifier'), 'Constant');
  if (node.name === 'PreprocDirective' && node.firstChild?.name === '#define')
    add(node.getChild('Identifier'), 'Constant');
  if (
    ['Declaration', 'FieldDeclaration', 'FunctionDefinition', 'ParameterDeclaration'].includes(
      node.name,
    )
  ) {
    const type = value(
      node.getChild('TypeIdentifier') ??
        node.getChild('ScopedTypeIdentifier') ??
        node.getChild('TemplateType')?.firstChild,
    );
    for (const part of children(node)) {
      let declarator: SyntaxNode | null = part;
      let functionName = false;
      while (declarator?.name.endsWith('Declarator')) {
        functionName ||= declarator.name === 'FunctionDeclarator';
        declarator = declarator.firstChild;
      }
      if (declarator && ['FieldIdentifier', 'Identifier'].includes(declarator.name))
        add(
          declarator,
          functionName ? 'Function' : node.name === 'FieldDeclaration' ? 'Field' : 'Variable',
          type,
        );
    }
  }
}

function parseFile(content: string, isPython: boolean, filename: string) {
  const tree = (isPython ? python : cpp).parse(content);
  const declarations: Declaration[] = [];
  const value = (node?: SyntaxNode | null) => (node ? content.slice(node.from, node.to) : '');
  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const add = (
        name: SyntaxNode | null,
        kind: Candidate['kind'],
        type?: string,
        scopeNode = node,
      ) => {
        if (!name || name.from === name.to) return;
        const scope = ancestor(
          scopeNode,
          isPython
            ? ['FunctionDefinition', 'ClassDefinition']
            : ['CompoundStatement', 'FunctionDefinition', 'FieldDeclarationList', 'EnumeratorList'],
        );
        const parent =
          scope?.name === 'ClassDefinition'
            ? scope
            : scope?.parent &&
                [
                  'ClassSpecifier',
                  'StructSpecifier',
                  'EnumSpecifier',
                  'NamespaceDefinition',
                ].includes(scope.parent.name)
              ? scope.parent
              : null;
        const owner =
          parent &&
          value(
            parent.getChild('VariableName') ??
              parent.getChild('TypeIdentifier') ??
              parent.getChild('Identifier'),
          );
        declarations.push({
          label: value(name),
          kind,
          type,
          scope,
          owner: owner || undefined,
          detail: filename,
          offset: name.from,
        });
      };
      if (isPython) collectPython(node, value, add, content);
      else collectCpp(node, value, add);
    },
  });
  return { tree, declarations };
}

// Store snapshots are immutable. Editing a file invalidates just its own index.
const cache = new WeakMap<WorkspaceFile, ReturnType<typeof parseFile>>();
function index(file: WorkspaceFile, isPython: boolean) {
  let result = cache.get(file);
  if (!result) {
    result = parseFile(file.content, isPython, file.name);
    cache.set(file, result);
  }
  return result;
}

export function codeCandidates(
  file: WorkspaceFile,
  files: WorkspaceFile[],
  offset: number,
  prefix: string,
  micropython: boolean,
): Candidate[] {
  const isPython = getEditorLanguage(file.name) === 'python';
  const { tree, declarations } = index(file, isPython);
  const token = tree.resolveInner(offset, -1);
  if (/Comment|String/.test(token.name)) return [];
  const visible = declarations.filter(
    ({ scope }) => !scope || (scope.from <= offset && offset <= scope.to),
  );
  const siblings = files.filter(
    (f) => f.id !== file.id && getEditorLanguage(f.name) === (isPython ? 'python' : 'cpp'),
  );
  const byName = (name: string) => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].label === name && visible[i].offset <= offset) return visible[i];
    }
  };
  const access = /([A-Za-z_]\w*(?:\.\w+)*)\s*(?:\.|->|::)\s*\w*$/.exec(prefix);
  if (isPython) {
    const modules = siblings.map((f) => ({
      name: f.name
        .replace(/\.pyi?$/i, '')
        .replace(/\/__init__$/, '')
        .replaceAll('/', '.'),
      file: f,
    }));
    const members = (target: string) => {
      const module = modules.find((m) => m.name === target);
      if (module) return index(module.file, true).declarations.filter((d) => !d.scope);
      const dot = target.lastIndexOf('.');
      const ownerModule = dot >= 0 && modules.find((m) => m.name === target.slice(0, dot));
      const owner = target.slice(dot + 1);
      const items = ownerModule ? index(ownerModule.file, true).declarations : declarations;
      const builtin = micropython ? microLibrary(target) : pythonLibrary(target);
      // The MicroPython reference documents firmware-specific methods and
      // refers readers to Python for the common built-in collection methods.
      const standard =
        micropython &&
        !builtin.length &&
        ['list', 'dict', 'str', 'set', 'bytes', 'tuple'].includes(target)
          ? pythonLibrary(target)
          : builtin;
      return [...standard, ...items.filter((d) => d.owner === owner)];
    };
    const from = /^\s*from\s+([\w.]+)\s+import\s+[\w, ]*$/.exec(prefix);
    if (from) return members(from[1]);
    const importing = /^\s*(?:import|from)\s+([\w.]*)$/.exec(prefix);
    const library = micropython ? microLibrary : pythonLibrary;
    if (importing) {
      const scope = importing[1].split('.').slice(0, -1).join('.');
      const local = modules.flatMap(({ name }): Candidate[] => {
        const parts = name.split('.');
        const depth = scope ? scope.split('.').length : 0;
        return (!scope || name.startsWith(scope + '.')) && parts[depth]
          ? [{ label: parts[depth], kind: 'Module' }]
          : [];
      });
      return [...local, ...library(scope).filter((d) => d.kind === 'Module')];
    }
    const member =
      token.name === 'MemberExpression' ? token : ancestor(token, ['MemberExpression']);
    const dot = member?.getChild('.');
    if (dot && dot.to <= offset && /^\s*\w*$/.test(file.content.slice(dot.to, offset))) {
      const receiver = pythonValueType(member?.firstChild, file.content);
      if (!receiver) return [];
      const [base, ...rest] = receiver.split('.');
      let target = byName(base)?.type ?? base;
      // Follow one constructor/import alias, e.g. led = P(2) with Pin imported as P.
      const [head, ...tail] = target.split('.');
      target = [byName(head)?.type ?? head, ...tail, ...rest].join('.');
      if (base === 'self') {
        const cls = ancestor(token, ['ClassDefinition'])?.getChild('VariableName');
        if (cls) target = file.content.slice(cls.from, cls.to);
      }
      return members(target);
    }
    return [...visible, ...pythonKeywords, ...library('').filter((d) => d.kind !== 'Module')];
  }
  const others = siblings.flatMap((other) => index(other, false).declarations);
  const qualified = /([A-Za-z_]\w*(?:::\w+)*)::\s*\w*$/.exec(prefix);
  if (qualified || access) {
    const receiver = qualified?.[1] ?? access![1];
    const owner = byName(receiver)?.type || receiver;
    const project = [...declarations, ...others].filter(
      (d) => d.owner === owner.split('::').at(-1),
    );
    return [...project, ...cppLibrary(owner)];
  }
  if (/^\s*#\s*\w*$/.test(prefix))
    return words(
      'define elif elifdef elifndef else embed endif error if ifdef ifndef include line pragma undef warning',
      'Keyword',
    );
  const using = [
    ...file.content.slice(0, offset).matchAll(/^\s*using\s+namespace\s+([\w:]+)\s*;/gm),
  ];
  return [
    ...visible,
    ...others.filter((d) => !d.scope),
    ...cppKeywords,
    ...cppLibrary(''),
    ...using.flatMap((match) => cppLibrary(match[1])),
  ];
}
