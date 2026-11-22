import { describe, expect, it } from 'vitest';
import { indentationEdits } from '../components/editor/indentationEdits';

describe('converting file indentation', () => {
  it('resizes nesting levels while leaving alignment spaces and code in place', () => {
    const edits = indentationEdits(
      ['void setup() {', '  outer();', '    inner();', '     aligned();'],
      { insertSpaces: true, indentSize: 2, tabSize: 2 },
      { insertSpaces: true, tabSize: 4 },
      () => false,
    );
    expect(edits.map(({ range, text }) => [range.startLineNumber, range.endColumn, text])).toEqual([
      [2, 3, '    '],
      [3, 5, '        '],
      [4, 6, '         '],
    ]);
  });

  it('converts mixed prefixes using tab stops and skips literal content', () => {
    const edits = indentationEdits(
      [' \t  call("a  b");', '    literal text', '  '],
      { insertSpaces: true, indentSize: 4, tabSize: 4 },
      { insertSpaces: false, tabSize: 4 },
      (index) => index === 1,
    );
    expect(edits).toEqual([{
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 },
      text: '\t  ',
    }]);
  });

  it('preserves indent order when narrowing an irregular file', () => {
    const edits = indentationEdits(
      ['   first()', '    second()'],
      { insertSpaces: true, indentSize: 4, tabSize: 4 },
      { insertSpaces: false, tabSize: 2 },
      () => false,
    );
    expect(edits.map(({ text }) => text)).toEqual(['\t ', '\t\t']);
  });

  it('uses the indentation width for tabs when the display width was changed separately', () => {
    const edits = indentationEdits(
      ['\touter()', '\t\tinner()'],
      { insertSpaces: false, indentSize: 4, tabSize: 8 },
      { insertSpaces: true, tabSize: 2 },
      () => false,
    );
    expect(edits.map(({ text }) => text)).toEqual(['  ', '    ']);
  });
});
