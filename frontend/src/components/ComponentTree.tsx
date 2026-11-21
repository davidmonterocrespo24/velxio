/**
 * ComponentTree — the picker's left navigation rail.
 *
 * A two-level tree (category > subgroup) with a live count on every node.
 * Counts are computed from the CURRENT result set, so they track the search
 * box: type "temp" and each branch reports how many of its parts survive.
 * Nodes that would report zero are dropped entirely rather than shown greyed,
 * which is what keeps the rail short while a query narrows the catalogue.
 *
 * Why a tree here and a flat facet list nowhere: part TYPE is genuinely
 * hierarchical (a DHT22 is a sensor, and within sensors a temperature one),
 * so one parent per node loses nothing. Attributes that are orthogonal to
 * type do NOT belong in this control.
 *
 * Keyboard model follows the WAI-ARIA tree pattern: one tab stop for the
 * whole tree (roving tabindex), arrows to move, left/right to collapse and
 * expand, Enter or Space to select.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';

export interface TreeNode {
  /** Stable selection key, e.g. 'all', 'boards', 'cat:sensors/temp'. */
  key: string;
  label: string;
  count: number;
  children?: TreeNode[];
}

interface ComponentTreeProps {
  nodes: TreeNode[];
  selected: string;
  onSelect: (key: string) => void;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  /** ID of the visible heading that labels the tree. */
  labelId: string;
}

interface FlatRow {
  node: TreeNode;
  level: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

/** Depth-first walk of the rows the user can currently see. */
function flatten(nodes: TreeNode[], expanded: Set<string>, level = 1): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const node of nodes) {
    const kids = (node.children ?? []).filter((c) => c.count > 0);
    const hasChildren = kids.length > 0;
    const isExpanded = hasChildren && expanded.has(node.key);
    rows.push({ node, level, hasChildren, isExpanded });
    if (isExpanded) rows.push(...flatten(kids, expanded, level + 1));
  }
  return rows;
}

const Chevron: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    className={`tree-chevron${open ? ' tree-chevron--open' : ''}`}
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

export const ComponentTree: React.FC<ComponentTreeProps> = ({
  nodes,
  selected,
  onSelect,
  expanded,
  onToggle,
  labelId,
}) => {
  const visible = useMemo(
    () => flatten(nodes.filter((n) => n.count > 0), expanded),
    [nodes, expanded],
  );
  // Roving tabindex: exactly one row is tabbable at a time, so the tree is a
  // single tab stop and the arrows do the walking.
  const [focusKey, setFocusKey] = useState<string>(selected);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // Resolved during render rather than repaired in an effect: filtering the
  // catalogue can delete the focused branch out from under the user, and
  // re-deriving avoids a render where NO row is tabbable (which would drop the
  // tree out of the tab order entirely).
  const focused = visible.some((r) => r.node.key === focusKey)
    ? focusKey
    : ((visible.find((r) => r.node.key === selected) ?? visible[0])?.node.key ?? '');

  const move = useCallback(
    (delta: number) => {
      const i = visible.findIndex((r) => r.node.key === focused);
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + delta))];
      if (!next) return;
      setFocusKey(next.node.key);
      rowRefs.current.get(next.node.key)?.focus();
    },
    [visible, focused],
  );

  const focusRow = useCallback((key: string) => {
    setFocusKey(key);
    rowRefs.current.get(key)?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = visible.findIndex((r) => r.node.key === focused);
    const row = visible[i];
    if (!row) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.hasChildren && !row.isExpanded) onToggle(row.node.key);
        else if (row.isExpanded) move(1);
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (row.isExpanded) {
          onToggle(row.node.key);
          break;
        }
        // Already collapsed (or a leaf): jump to the parent row, which is the
        // nearest preceding row one level up.
        for (let j = i - 1; j >= 0; j--) {
          if (visible[j].level < row.level) {
            focusRow(visible[j].node.key);
            break;
          }
        }
        break;
      }
      case 'Home':
        e.preventDefault();
        if (visible[0]) focusRow(visible[0].node.key);
        break;
      case 'End':
        e.preventDefault();
        if (visible.length) focusRow(visible[visible.length - 1].node.key);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(row.node.key);
        break;
      default:
        break;
    }
  };

  return (
    <div className="picker-tree">
      <div role="tree" aria-labelledby={labelId} onKeyDown={onKeyDown}>
        {visible.map((row) => {
          const isSelected = row.node.key === selected;
          return (
            <div
              key={row.node.key}
              ref={(el) => {
                if (el) rowRefs.current.set(row.node.key, el);
                else rowRefs.current.delete(row.node.key);
              }}
              role="treeitem"
              aria-level={row.level}
              aria-selected={isSelected}
              aria-expanded={row.hasChildren ? row.isExpanded : undefined}
              tabIndex={row.node.key === focused ? 0 : -1}
              className={`tree-row${isSelected ? ' tree-row--selected' : ''}${
                row.level > 1 ? ' tree-row--child' : ''
              }`}
              onClick={() => {
                setFocusKey(row.node.key);
                onSelect(row.node.key);
              }}
              onFocus={() => setFocusKey(row.node.key)}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  className="tree-twisty"
                  // The twisty only opens the branch; the row selects it. Both
                  // live in the same row, so the click must not do both.
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(row.node.key);
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <Chevron open={row.isExpanded} />
                </button>
              ) : (
                <span className="tree-twisty tree-twisty--empty" aria-hidden="true" />
              )}
              <span className="tree-label">{row.node.label}</span>
              <span className="tree-count">{row.node.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ComponentTree;
