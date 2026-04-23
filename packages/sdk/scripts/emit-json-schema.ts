/**
 * Emit `plugin-manifest.v1.json` from the Zod manifest schema.
 *
 * Output goes to `dist/schemas/plugin-manifest.v1.json`. The build pipeline
 * ships this alongside the JS so the marketplace CDN can host it at
 * `https://sdk.velxio.dev/schemas/plugin-manifest.v1.json` for IDE
 * autocomplete in plugin authors' `plugin.json`.
 *
 * Run: `npm run schema:emit`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PluginManifestSchema } from '../src/manifest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../dist/schemas/plugin-manifest.v1.json');

const jsonSchema = zodToJsonSchema(PluginManifestSchema, {
  name: 'PluginManifest',
  target: 'jsonSchema7',
  $refStrategy: 'none',
});

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://sdk.velxio.dev/schemas/plugin-manifest.v1.json',
      title: 'Velxio plugin manifest (v1)',
      description:
        'The contract for a Velxio plugin. Validated by the marketplace before publish and by the host before load.',
      ...(typeof jsonSchema === 'object' && jsonSchema !== null ? jsonSchema : {}),
    },
    null,
    2,
  ),
);

console.log(`Emitted ${OUT_PATH}`);
