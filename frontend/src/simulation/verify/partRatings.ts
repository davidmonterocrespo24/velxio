/**
 * A part's datasheet ratings as the app knows them: from the component
 * registry, which loads public/components-metadata.json (generated from
 * scripts/component-overrides.json) before anything is placed, plus whatever
 * an overlay merges in. The circuit check before Run and the runtime monitor
 * read them here (velxio/velxio-prod#138); a part with no `ratings` in its
 * metadata is not checked.
 */
import { ComponentRegistry } from '../../services/ComponentRegistry';
import type { RatedPart } from './transistorStress';

export function ratedPartFromRegistry(metadataId: string): RatedPart | undefined {
  const meta = ComponentRegistry.getInstance().getById(metadataId);
  return meta?.ratings ? { ratings: meta.ratings, name: meta.name } : undefined;
}
