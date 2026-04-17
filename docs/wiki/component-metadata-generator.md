# Component Metadata Generator

Documentation of the component metadata auto-generation system and the override mechanism that preserves custom property configurations across regenerations.

---

## Table of Contents

1. [Overview](#overview)
2. [How It Works](#how-it-works)
3. [The Problem: Lost Customizations](#the-problem-lost-customizations)
4. [The Solution: component-overrides.json](#the-solution-component-overridesjson)
5. [Override File Format](#override-file-format)
6. [How Overrides Are Applied](#how-overrides-are-applied)
7. [Current Overrides](#current-overrides)
8. [Adding New Overrides](#adding-new-overrides)
9. [Generator Internals](#generator-internals)
10. [File Reference](#file-reference)

---

## Overview

Velxio uses 48+ electronic components from the [wokwi-elements](https://github.com/wokwi/wokwi-elements) library. Each component needs metadata (properties, categories, pin counts, controls) for the UI to render property dialogs, component picker, and simulation logic.

Instead of maintaining this metadata manually, a **generator script** scans the wokwi-elements TypeScript source files, extracts `@property` decorators, `@customElement` tag names, and `pinInfo` getters, then produces `frontend/public/components-metadata.json`.

---

## How It Works

```
wokwi-libs/wokwi-elements/src/*-element.ts
         │
         ▼
scripts/generate-component-metadata.ts    ←── reads TypeScript AST
         │
         ├── Extracts @customElement('wokwi-led') → id: "led"
         ├── Extracts @property() color = 'red'   → { name: "color", defaultValue: "red" }
         ├── Counts pinInfo entries                → pinCount: 2
         ├── Reads .stories.ts for display name    → name: "LED"
         ├── Maps id to category via CATEGORY_MAP  → category: "output"
         │
         ├── Applies overrides from component-overrides.json  ← NEW
         │
         ▼
frontend/public/components-metadata.json
```

**Running the generator:**

```bash
cd scripts
npx ts-node generate-component-metadata.ts
```

Or if `ts-node` is not available:

```bash
npx tsx scripts/generate-component-metadata.ts
```

---

## The Problem: Lost Customizations

The generator reads property types from the wokwi-elements source and infers a UI control:

| TypeScript Type | Inferred Control |
|-----------------|-----------------|
| `boolean`       | `boolean`       |
| `number`        | `range`         |
| `string`        | `text`          |

This is a reasonable default, but some components need **richer controls** that can't be inferred from the TypeScript source:

- **LED `color`**: The wokwi-elements source declares `@property() color = 'red'` (a plain string). But in the UI, we want a **dropdown select** with predefined colors (`red`, `green`, `blue`, etc.), not a free-text input.

- **SSD1306 `protocol`**: The wokwi-elements source has no `protocol` property at all — it's a Velxio-specific concept for choosing between I2C and SPI communication modes. We need to **inject an entirely new property** that doesn't exist in wokwi-elements.

Previously, these customizations were made by hand-editing `components-metadata.json`. But every time the generator ran (e.g., after updating wokwi-libs), it would **overwrite the entire file** and the customizations would be lost.

---

## The Solution: component-overrides.json

A separate JSON file at `scripts/component-overrides.json` stores all custom property overrides. The generator reads this file **after** scanning wokwi-elements and applies the overrides before writing the output.

```
Auto-generated from wokwi-elements    +    component-overrides.json
(properties, defaults, pin counts)         (custom controls, new properties)
              │                                        │
              └──────────────┬─────────────────────────┘
                             ▼
               components-metadata.json
                  (final merged output)
```

Since `component-overrides.json` is a separate file that the generator **reads but never writes**, customizations are preserved across any number of regenerations.

---

## Override File Format

```json
{
  "$comment": "Custom property overrides applied AFTER auto-generation...",
  "<component-id>": {
    "properties": {
      "<property-name>": {
        // Fields to patch on an existing property, or full definition for a new one
      }
    },
    "defaultValues": {
      "<property-name>": "<default-value>"
    }
  }
}
```

### Patching an Existing Property

To change the control type of an existing property (one that the generator already extracts from wokwi-elements):

```json
{
  "led": {
    "properties": {
      "color": {
        "control": "select",
        "options": ["red", "green", "blue", "yellow", "orange", "white", "purple"]
      }
    }
  }
}
```

This finds the existing `color` property on the LED component and patches it with `control: "select"` and `options: [...]`. All other fields (`name`, `type`, `defaultValue`) are kept from the auto-generated version.

### Adding a New Property

To inject a property that doesn't exist in the wokwi-elements source:

```json
{
  "ssd1306": {
    "properties": {
      "protocol": {
        "name": "protocol",
        "type": "string",
        "defaultValue": "i2c",
        "control": "select",
        "description": "Communication protocol",
        "options": ["i2c", "spi"]
      }
    },
    "defaultValues": {
      "protocol": "i2c"
    }
  }
}
```

Since no existing property named `protocol` exists on the SSD1306, the generator **appends** it to the properties array. The `defaultValues` merge ensures the default is set.

---

## How Overrides Are Applied

The `applyOverrides()` method in the generator works as follows:

```
For each component in the generated metadata:
  1. Check if component-overrides.json has an entry for this component ID
  2. If yes, for each property override:
     a. Find existing property by name in the component's properties array
     b. If found → Object.assign(existing, patch)  (merge/overwrite fields)
     c. If not found → push(patch) to properties array  (add new property)
  3. Merge any defaultValues from the override into the component's defaultValues
```

The key behavior:

| Scenario | Action |
|----------|--------|
| Override property exists in wokwi-elements | Patch: only overridden fields change, rest preserved |
| Override property does NOT exist in wokwi-elements | Add: full property definition appended |
| Override has `defaultValues` | Merge: `{ ...autoGenerated, ...override }` |

---

## Current Overrides

### LED Color Selector

**Component:** `led`
**Property:** `color`
**Change:** `control: "text"` → `control: "select"` with 7 color options

The wokwi LED element accepts any CSS color string, but in practice users want to pick from standard LED colors. The select dropdown provides:
- `red`, `green`, `blue`, `yellow`, `orange`, `white`, `purple`

**UI result:** When clicking on an LED in the simulator, the property dialog shows a dropdown instead of a text input.

### SSD1306 Protocol Selector

**Component:** `ssd1306`
**Property:** `protocol` (new, not in wokwi-elements)
**Control:** `select` with `["i2c", "spi"]`
**Default:** `"i2c"`

The real SSD1306 OLED display supports both I2C and SPI communication. In Velxio, the simulation logic reads this property to decide which bus to attach:

- **I2C mode**: Registers as an `I2CDevice` on the simulator's I2C bus. Responds to address `0x3C`. Uses control byte (`0x00` = command, `0x40` = data).
- **SPI mode**: Hooks into the SPI `onByte` callback. Uses the DC (Data/Command) pin to distinguish commands from data.

The simulation code in `PartSimulationRegistry` reads the protocol at attachment time:

```typescript
PartSimulationRegistry.register('ssd1306', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const comp = useSimulatorStore.getState().components.find(c => c.id === componentId);
    const protocol = (comp?.properties?.protocol as string) ?? 'i2c';
    if (protocol === 'spi') return attachSSD1306SPI(element, simulator, getPin);
    // I2C default...
  },
});
```

**UI result:** The property dialog shows an I2C/SPI dropdown. A colored badge (blue = I2C, orange = SPI) appears next to the component label on the canvas.

---

## Adding New Overrides

### Step 1: Edit component-overrides.json

Add a new entry keyed by the component's `id` (the part after `wokwi-` in the tag name):

```json
{
  "resistor": {
    "properties": {
      "value": {
        "control": "select",
        "options": ["220", "330", "1000", "4700", "10000"]
      }
    }
  }
}
```

### Step 2: Regenerate metadata

```bash
npx tsx scripts/generate-component-metadata.ts
```

The generator will log:

```
  🔧 Applied overrides for resistor

🔧 Applied overrides to 1 component(s)
```

### Step 3: Verify

Open `frontend/public/components-metadata.json` and search for the component. The override fields should be present.

### Common override patterns

**Change a text input to a dropdown:**
```json
{
  "<component-id>": {
    "properties": {
      "<prop-name>": {
        "control": "select",
        "options": ["option1", "option2", "option3"]
      }
    }
  }
}
```

**Add a description to an existing property:**
```json
{
  "<component-id>": {
    "properties": {
      "<prop-name>": {
        "description": "Human-readable description shown in the property dialog"
      }
    }
  }
}
```

**Add a completely new property with a default:**
```json
{
  "<component-id>": {
    "properties": {
      "newProp": {
        "name": "newProp",
        "type": "string",
        "defaultValue": "default",
        "control": "select",
        "description": "Description",
        "options": ["default", "alt1", "alt2"]
      }
    },
    "defaultValues": {
      "newProp": "default"
    }
  }
}
```

---

## Generator Internals

### TypeScript AST Parsing

The generator uses the TypeScript compiler API (`ts.createSourceFile`) to parse each `*-element.ts` file without executing it. It extracts:

1. **Tag name**: From `@customElement('wokwi-led')` decorator → `wokwi-led`
2. **Properties**: From `@property() color = 'red'` decorators → `{ name: "color", type: "string", defaultValue: "red" }`
3. **Pin count**: By counting object literals `{ name: ... }` inside the `pinInfo` getter body
4. **Display name**: From the corresponding `.stories.ts` file's `title:` field

### Category Assignment

Components don't declare their own category. The generator uses a hardcoded `CATEGORY_MAP`:

```typescript
const CATEGORY_MAP: Record<string, ComponentCategory> = {
  'led': 'output',
  'pushbutton': 'input',
  'ssd1306': 'displays',
  'servo': 'motors',
  'resistor': 'passive',
  // ... etc
};
```

Components not in the map get `category: "other"`.

### Control Inference

The generator infers a UI control from the TypeScript property type:

```typescript
private inferControl(tsType: string): 'text' | 'range' | 'color' | 'boolean' | 'select' {
  if (tsType.includes('boolean')) return 'boolean';
  if (tsType.includes('number')) return 'range';
  return 'text';  // strings and everything else
}
```

This is why custom overrides are needed — the generator can't know that `color: string` should be a `select` with specific options.

### Tag Generation

Each component gets search tags derived from its ID and display name:

```
id: "led-bar-graph" → tags: ["led-bar-graph", "led bar graph", "led", "bar", "graph"]
```

---

## File Reference

| File | Description |
|------|-------------|
| `scripts/generate-component-metadata.ts` | Generator script — scans wokwi-elements, applies overrides, writes JSON |
| `scripts/component-overrides.json` | Custom property overrides (survives regeneration) |
| `frontend/public/components-metadata.json` | Generated output — consumed by the frontend at runtime |
| `frontend/src/types/component-metadata.ts` | TypeScript interface for `ComponentMetadata` |
| `frontend/src/services/ComponentRegistry.ts` | Loads and indexes the metadata JSON at runtime |
| `wokwi-libs/wokwi-elements/src/*-element.ts` | Source files scanned by the generator |
