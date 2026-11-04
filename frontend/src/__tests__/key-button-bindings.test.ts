import { describe, it, expect } from 'vitest';
import {
  isKeyBindable,
  normalizeKey,
  formatKeyLabel,
  isModifierKey,
  buildKeyBindingMap,
} from '../utils/keyButtonBindings';

const comp = (id: string, metadataId: string, key?: unknown) => ({
  id,
  metadataId,
  properties: key === undefined ? {} : { key },
});

describe('keyButtonBindings', () => {
  it('marks both pushbutton variants as bindable, other parts not', () => {
    expect(isKeyBindable('pushbutton')).toBe(true);
    expect(isKeyBindable('pushbutton-6mm')).toBe(true);
    expect(isKeyBindable('slide-switch')).toBe(false);
    expect(isKeyBindable('led')).toBe(false);
  });

  it('normalizes single characters case-insensitively, keeps named keys', () => {
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey('a')).toBe('a');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
    expect(normalizeKey(' ')).toBe(' ');
  });

  it('formats key labels for the keycap badge', () => {
    expect(formatKeyLabel('a')).toBe('A');
    expect(formatKeyLabel(' ')).toBe('Space');
    expect(formatKeyLabel('ArrowUp')).toBe('↑');
    expect(formatKeyLabel('ArrowRight')).toBe('→');
    expect(formatKeyLabel('Enter')).toBe('Enter');
  });

  it('rejects lone modifiers', () => {
    expect(isModifierKey('Shift')).toBe(true);
    expect(isModifierKey('Meta')).toBe(true);
    expect(isModifierKey('a')).toBe(false);
    expect(isModifierKey('Enter')).toBe(false);
  });

  it('builds the key → component-ids map from component properties', () => {
    const map = buildKeyBindingMap([
      comp('b1', 'pushbutton', 'a'),
      comp('b2', 'pushbutton-6mm', 'A'), // same key, different case
      comp('b3', 'pushbutton', 'ArrowUp'),
      comp('b4', 'pushbutton'), // unbound
      comp('b5', 'pushbutton', ''), // cleared binding
      comp('led1', 'led', 'a'), // not bindable — ignored
      comp('b6', 'pushbutton', 42), // junk value — ignored
    ]);
    expect(map.get('a')).toEqual(['b1', 'b2']);
    expect(map.get('ArrowUp')).toEqual(['b3']);
    expect(map.size).toBe(2);
  });
});
