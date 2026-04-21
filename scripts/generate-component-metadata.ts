/**
 * Component Metadata Generator
 *
 * Scans wokwi-elements repository and generates component metadata JSON.
 * Runs during build-time to extract:
 * - Component names from @customElement decorators
 * - Properties from @property decorators
 * - Display metadata from .stories.ts files
 * - Pin information from pinInfo getters
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { ComponentMetadata, ComponentCategory } from '../frontend/src/types/component-metadata';

// Hardcoded category mapping (components don't self-declare categories)
const CATEGORY_MAP: Record<string, ComponentCategory> = {
  // Boards
  'arduino-uno': 'boards',
  'arduino-mega': 'boards',
  'arduino-nano': 'boards',
  'esp32-devkit-v1': 'boards',
  'pi-pico': 'boards',

  // Sensors
  'dht22': 'sensors',
  'hc-sr04': 'sensors',
  'pir-motion-sensor': 'sensors',
  'mq2-gas-sensor': 'sensors',
  'mpu6050': 'sensors',
  'bmp280': 'sensors',
  'ds18b20-temp': 'sensors',
  'ntc-temperature-sensor': 'sensors',
  'photoresistor-sensor': 'sensors',

  // Displays
  'lcd1602': 'displays',
  'lcd2004': 'displays',
  'ssd1306': 'displays',
  'tm1637-7segment': 'displays',
  'ks2e-7segment': 'displays',
  'max7219-matrix': 'displays',
  'ili9341': 'displays',

  // Input
  'pushbutton': 'input',
  'slide-switch': 'input',
  'dip-switch-8': 'input',
  'membrane-keypad': 'input',
  'potentiometer': 'input',
  'sliding-potentiometer': 'input',

  // Output
  'led': 'output',
  'led-bar-graph': 'output',
  'neopixel': 'output',
  'led-matrix': 'output',
  'rgb-led': 'output',
  'buzzer': 'output',
  'relay-module': 'output',

  // Motors
  'stepper-motor': 'motors',
  'servo': 'motors',
  'biaxial-stepper': 'motors',

  // Communication
  'bluetooth-hc-05': 'communication',
  'wifi-module': 'communication',

  // Passive Components
  'resistor': 'passive',
  'capacitor': 'passive',
  'inductor': 'passive',
  'diode': 'passive',
  'analog-multiplexer': 'passive',
  'ir-receiver': 'passive',
  'ir-remote': 'passive',
  'franzininho': 'passive',
  'logic-analyzer': 'passive',
};

interface ParsedComponent {
  tagName: string;
  className: string;
  properties: Array<{
    name: string;
    type: string;
    defaultValue?: any;
  }>;
  pinCount: number;
}

class MetadataGenerator {
  private wokwiElementsPath: string;
  private outputPath: string;
  private overridesPath: string;

  constructor() {
    this.wokwiElementsPath = path.join(__dirname, '../wokwi-libs/wokwi-elements/src');
    this.outputPath = path.join(__dirname, '../frontend/public/components-metadata.json');
    this.overridesPath = path.join(__dirname, 'component-overrides.json');
  }

  /**
   * Main entry point - generates metadata JSON
   */
  async generate(): Promise<void> {
    console.log('🔍 Scanning wokwi-elements directory...');

    if (!fs.existsSync(this.wokwiElementsPath)) {
      console.error(`❌ wokwi-elements not found at: ${this.wokwiElementsPath}`);
      console.log('💡 Make sure to initialize the git submodule:');
      console.log('   git submodule update --init --recursive');
      process.exit(1);
    }

    const components: ComponentMetadata[] = [];
    const elementFiles = this.findElementFiles();

    console.log(`📦 Found ${elementFiles.length} element files`);

    for (const filePath of elementFiles) {
      try {
        const metadata = this.parseElementFile(filePath);
        if (metadata) {
          components.push(metadata);
          console.log(`  ✓ ${metadata.name} (${metadata.tagName})`);
        }
      } catch (error) {
        console.error(`  ✗ Failed to parse ${path.basename(filePath)}:`, error);
      }
    }

    // Apply custom overrides from component-overrides.json
    this.applyOverrides(components);

    // Sort by category and name
    components.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.name.localeCompare(b.name);
    });

    // Note: no `generatedAt` timestamp — it would change on every run and
    // break the CI drift check (git diff --quiet on the committed JSON).
    const output = {
      version: '1.0.0',
      components,
    };

    // Ensure output directory exists
    const outputDir = path.dirname(this.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(this.outputPath, JSON.stringify(output, null, 2));
    console.log(`\n✅ Generated metadata for ${components.length} components`);
    console.log(`📄 Output: ${this.outputPath}`);
  }

  /**
   * Apply custom overrides from component-overrides.json.
   *
   * Overrides can:
   *  - Patch existing property fields (e.g. change control from "text" to "select")
   *  - Add entirely new properties to a component
   *  - Merge extra defaultValues
   *  - Inject brand-new components via the `_customComponents` array
   *    (used for Velxio-only parts not defined in wokwi-elements, e.g. logic
   *    gates, discrete analog components, instruments).
   */
  private applyOverrides(components: ComponentMetadata[]): void {
    if (!fs.existsSync(this.overridesPath)) return;

    let overrides: Record<string, any>;
    try {
      overrides = JSON.parse(fs.readFileSync(this.overridesPath, 'utf-8'));
    } catch (e) {
      console.warn(`⚠️  Could not parse ${this.overridesPath}:`, e);
      return;
    }

    // Inject custom components first (so wokwi-elements scan can still take
    // precedence on id collisions). Each entry must be a full ComponentMetadata.
    const customComps = (overrides._customComponents ?? []) as ComponentMetadata[];
    let injected = 0;
    for (const custom of customComps) {
      if (!custom.id || !custom.tagName) {
        console.warn(`⚠️  Skipping custom component without id/tagName:`, custom);
        continue;
      }
      if (components.find(c => c.id === custom.id)) {
        console.log(`  ⏭️  Custom component ${custom.id} already scanned from wokwi-elements; skipping custom entry`);
        continue;
      }
      components.push({
        thumbnail: custom.thumbnail ?? this.generateThumbnailPlaceholder(custom.id),
        tags: custom.tags ?? this.generateTags(custom.id, custom.name || custom.id),
        properties: custom.properties ?? [],
        defaultValues: custom.defaultValues ?? {},
        pinCount: custom.pinCount ?? 0,
        ...custom,
      });
      injected++;
      console.log(`  ➕ Injected custom component ${custom.id}`);
    }
    if (injected > 0) {
      console.log(`\n➕ Injected ${injected} custom component(s)`);
    }

    let applied = 0;
    for (const comp of components) {
      const ov = overrides[comp.id];
      if (!ov) continue;

      // Merge property-level overrides
      if (ov.properties) {
        for (const [propName, patch] of Object.entries<any>(ov.properties)) {
          const existing = comp.properties.find((p: any) => p.name === propName);
          if (existing) {
            // Patch existing property (e.g. change control, add options)
            Object.assign(existing, patch);
          } else {
            // Add new property (e.g. SSD1306 "protocol")
            comp.properties.push(patch);
          }
        }
      }

      // Merge defaultValues
      if (ov.defaultValues) {
        comp.defaultValues = { ...comp.defaultValues, ...ov.defaultValues };
      }

      // Replace the picker label / SVG thumbnail (used to e.g. rename the
      // canonical resistor to "Resistor (custom)" once preset variants exist).
      if (typeof ov.name === 'string') {
        comp.name = ov.name;
      }
      if (typeof ov.thumbnail === 'string') {
        comp.thumbnail = ov.thumbnail;
      }

      applied++;
      console.log(`  🔧 Applied overrides for ${comp.id}`);
    }

    if (applied > 0) {
      console.log(`\n🔧 Applied overrides to ${applied} component(s)`);
    }
  }

  /**
   * Find all *-element.ts files (excluding .stories.ts)
   */
  private findElementFiles(): string[] {
    const files = fs.readdirSync(this.wokwiElementsPath);
    return files
      .filter(file => file.endsWith('-element.ts') && !file.includes('.stories'))
      .map(file => path.join(this.wokwiElementsPath, file));
  }

  /**
   * Parse a single element file and extract metadata
   */
  private parseElementFile(filePath: string): ComponentMetadata | null {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    const parsed = this.parseTypeScriptAST(sourceFile);
    if (!parsed) return null;

    const id = this.extractIdFromTagName(parsed.tagName);
    const category = CATEGORY_MAP[id] || 'other';
    const storiesMetadata = this.parseStoriesFile(filePath);

    return {
      id,
      tagName: parsed.tagName,
      name: storiesMetadata?.name || this.formatName(id),
      category,
      description: storiesMetadata?.description,
      thumbnail: this.generateThumbnailPlaceholder(id),
      properties: parsed.properties.map(prop => ({
        name: prop.name,
        type: this.mapPropertyType(prop.type),
        defaultValue: prop.defaultValue,
        control: this.inferControl(prop.type),
      })),
      defaultValues: this.extractDefaultValues(parsed.properties),
      pinCount: parsed.pinCount,
      tags: this.generateTags(id, storiesMetadata?.name || ''),
    };
  }

  /**
   * Parse TypeScript AST to extract decorators and properties
   */
  private parseTypeScriptAST(sourceFile: ts.SourceFile): ParsedComponent | null {
    let tagName = '';
    let className = '';
    const properties: ParsedComponent['properties'] = [];
    let pinCount = 0;

    const visit = (node: ts.Node) => {
      // Find @customElement decorator
      if (ts.isDecorator(node)) {
        const decorator = node as ts.Decorator;
        if (ts.isCallExpression(decorator.expression)) {
          const call = decorator.expression;
          if (ts.isIdentifier(call.expression) && call.expression.text === 'customElement') {
            const arg = call.arguments[0];
            if (ts.isStringLiteral(arg)) {
              tagName = arg.text;
            }
          }
        }
      }

      // Find class declaration
      if (ts.isClassDeclaration(node) && node.name) {
        className = node.name.text;

        // Find @property decorators
        node.members.forEach(member => {
          if (ts.isPropertyDeclaration(member)) {
            const propertyDecorators = ts.getDecorators(member);
            if (propertyDecorators?.some(d =>
              ts.isCallExpression(d.expression) &&
              ts.isIdentifier(d.expression.expression) &&
              d.expression.expression.text === 'property'
            )) {
              const name = member.name.getText();
              const type = member.type?.getText() || 'any';
              const defaultValue = member.initializer?.getText();

              let resolvedDefault: unknown;
              if (defaultValue) {
                try {
                  resolvedDefault = eval(defaultValue);
                } catch {
                  // Initializer references an identifier not in scope (e.g. imported constant)
                  resolvedDefault = undefined;
                }
              }
              properties.push({
                name,
                type,
                defaultValue: resolvedDefault,
              });
            }
          }

          // Count pins from pinInfo getter
          if (ts.isGetAccessor(member)) {
            const accessorName = member.name.getText();
            if (accessorName === 'pinInfo') {
              const bodyText = member.body?.getText() || '';
              // Count array elements in return statement
              const matches = bodyText.match(/\{[^}]+\}/g);
              if (matches) {
                pinCount = matches.length;
              }
            }
          }
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (!tagName || !className) return null;

    return { tagName, className, properties, pinCount };
  }

  /**
   * Parse corresponding .stories.ts file for UI metadata
   */
  private parseStoriesFile(elementFilePath: string): { name?: string; description?: string } | null {
    const storiesPath = elementFilePath.replace('-element.ts', '-element.stories.ts');
    if (!fs.existsSync(storiesPath)) return null;

    try {
      const content = fs.readFileSync(storiesPath, 'utf-8');

      // Extract title (name)
      const titleMatch = content.match(/title:\s*['"]([^'"]+)['"]/);
      const name = titleMatch?.[1];

      // Extract description
      const descMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
      const description = descMatch?.[1];

      return { name, description };
    } catch {
      return null;
    }
  }

  /**
   * Helper methods
   */
  private extractIdFromTagName(tagName: string): string {
    return tagName.replace('wokwi-', '');
  }

  private formatName(id: string): string {
    return id
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private mapPropertyType(tsType: string): 'string' | 'number' | 'boolean' | 'color' | 'select' {
    if (tsType.includes('number')) return 'number';
    if (tsType.includes('boolean')) return 'boolean';
    if (tsType.includes('string')) return 'string';
    return 'string';
  }

  private inferControl(tsType: string): 'text' | 'range' | 'color' | 'boolean' | 'select' {
    if (tsType.includes('boolean')) return 'boolean';
    if (tsType.includes('number')) return 'range';
    return 'text';
  }

  private extractDefaultValues(properties: ParsedComponent['properties']): Record<string, any> {
    const defaults: Record<string, any> = {};
    properties.forEach(prop => {
      if (prop.defaultValue !== undefined) {
        defaults[prop.name] = prop.defaultValue;
      }
    });
    return defaults;
  }

  private generateThumbnailPlaceholder(id: string): string {
    // For now, return a simple SVG placeholder
    // TODO: Extract actual SVG from render() method
    return `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
      <rect width="64" height="64" fill="#e0e0e0" rx="4"/>
      <text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" fill="#666">
        ${id.toUpperCase()}
      </text>
    </svg>`;
  }

  private generateTags(id: string, name: string): string[] {
    const tags = [id, name.toLowerCase()];
    // Add individual words for better search
    id.split('-').forEach(word => tags.push(word));
    name.split(' ').forEach(word => tags.push(word.toLowerCase()));
    return [...new Set(tags)]; // Remove duplicates
  }
}

// Run generator
const generator = new MetadataGenerator();
generator.generate().catch(error => {
  console.error('❌ Metadata generation failed:', error);
  process.exit(1);
});
