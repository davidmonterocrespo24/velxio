/**
 * What the examples gallery search matches against, normalised once per
 * example: the gallery filters on every keystroke and there are several
 * hundred entries. Keyed by the example object, so an overlay registering
 * late examples (new objects) can never be served a stale entry.
 */

import type { ExampleProject } from '../data/examples';
import { componentSearchKeywords } from '../data/componentSearchKeywords';
import { prepareSearchFields, type PreparedSearchFields } from './searchMatch';

const cache = new WeakMap<ExampleProject, PreparedSearchFields>();

export function exampleSearchFields(
  example: ExampleProject,
  boardFilter: string,
): PreparedSearchFields {
  const hit = cache.get(example);
  if (hit) return hit;
  // Defensive on `components`: it is required by ExampleProject, but overlay
  // example sets are built by factories that cast their result, so the
  // compiler is not actually guarding this. One entry that omitted it took
  // the entire gallery down with a TypeError the first time anyone typed in
  // the search box — a whole page lost to one malformed example.
  const partTypes = (example.components ?? []).map((c) => c.type);
  const prepared = prepareSearchFields([
    { text: example.title, weight: 3 },
    { text: (example.tags ?? []).join(' '), weight: 2 },
    // The parts on the canvas, plus what people call them: an example with
    // a DHT22 is found by "temperature" even if its title never says so.
    { text: partTypes.join(' '), weight: 2 },
    { text: partTypes.map(componentSearchKeywords).join(' '), weight: 1.5 },
    { text: `${boardFilter} ${example.boardType ?? ''}`, weight: 1.5 },
    { text: `${example.category} ${example.difficulty}`, weight: 1 },
    { text: example.description, weight: 1 },
  ]);
  cache.set(example, prepared);
  return prepared;
}
