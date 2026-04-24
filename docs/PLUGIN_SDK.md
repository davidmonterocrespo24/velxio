# `@velxio/sdk` — Plugin SDK

> Status: **Phase 0/1 in progress.** The SDK ships, the host's `PluginContext`
> factory ships, but there is no plugin loader yet (CORE-006 / CORE-007). This
> doc describes the public surface plugin authors will write against.
>
> **For the full permission catalog, threat model, and consent UX, see
> [PLUGIN_PERMISSIONS.md](./PLUGIN_PERMISSIONS.md).** Each section below
> mentions the permission its API requires; that doc is the canonical
> reference.

## At a glance

A Velxio plugin is a JavaScript module with a single default export wrapped in
`definePlugin({ ... })`. The host loader validates a manifest, builds a
`PluginContext` scoped to the manifest's permissions, and calls
`activate(ctx)` once. Everything the plugin does — register a new component,
add a button to the toolbar, persist user settings — flows through `ctx`.

```ts
import { definePlugin, defineComponent, definePartSimulation } from '@velxio/sdk';

export default definePlugin({
  activate(ctx) {
    const led = ctx.components.register(defineComponent({
      id: 'demo.fancy-led',
      name: 'Fancy LED',
      category: 'basic',
      element: 'wokwi-led',
      description: 'A LED with a custom glow shader',
      pins: [
        { name: 'A', x: 0, y: 0, signal: 'gpio' },
        { name: 'C', x: 0, y: 10, signal: 'power-gnd' },
      ],
    }));

    const part = ctx.partSimulations.register('demo.fancy-led', definePartSimulation({
      onPinStateChange(pinName, state, element) {
        if (pinName === 'A') element.setAttribute('value', state ? '1' : '0');
      },
    }));

    return [led, part];     // host disposes both on uninstall
  },
});
```

## Components — the three-call extension flow

A "component" in Velxio is split across three independent registries because
each has a different lifecycle and permission boundary:

| Registry                          | What it owns                              | Permission             |
|-----------------------------------|-------------------------------------------|------------------------|
| `ctx.components`                  | Picker entry, pin layout, properties form | `components.register`  |
| `ctx.partSimulations`             | MCU-side behavior (onPinStateChange, attachEvents) | `simulator.pins.read`  |
| `ctx.spice`                       | Electrical-mode SPICE mapper + models     | `simulator.spice.read` |

A plugin can register **any combination** of these. A passive resistor only
needs the SPICE mapper. An interactive button only needs the part simulation.
A self-contained OLED display registers all three.

### Picker entry — `ctx.components.register`

```ts
const handle = ctx.components.register(defineComponent({
  id: 'demo.oled-lite',
  name: 'OLED-lite 0.96"',
  category: 'displays',           // shapes the picker bucket
  element: 'wokwi-ssd1306',       // existing wokwi-element OR a tag your plugin defines
  description: 'A monochrome 128x64 OLED',
  icon: 'data:image/svg+xml;…',   // shown in the picker thumbnail
  keywords: ['oled', 'ssd1306', 'i2c'],
  pins: [
    { name: 'VCC', x: 0,  y: 0,  signal: 'power-vcc' },
    { name: 'GND', x: 0,  y: 5,  signal: 'power-gnd' },
    { name: 'SCL', x: 0,  y: 10, signal: 'i2c-scl' },
    { name: 'SDA', x: 0,  y: 15, signal: 'i2c-sda' },
  ],
  properties: [
    { name: 'address', kind: 'number', default: 0x3c, min: 0, max: 127 },
    { name: 'rotation', kind: 'enum', default: '0',
      options: [{ value: '0', label: '0°' }, { value: '180', label: '180°' }] },
  ],
}));
```

#### Duplicate ids are a hard error

Plugins **cannot** silently shadow built-ins or other plugins. The second
`register()` call with the same `id` throws `DuplicateComponentError` —
caught at activation time, not at runtime when the picker mysteriously
points at the wrong renderer. To replace your own registration, dispose
the previous handle first.

```ts
import { DuplicateComponentError } from '@velxio/sdk';

try {
  ctx.components.register(def);
} catch (err) {
  if (err instanceof DuplicateComponentError) {
    ctx.logger.warn(`id "${err.componentId}" is already taken`);
  } else throw err;
}
```

Naming convention to dodge collisions: prefix every id with your plugin id,
e.g. `demo.oledlite.ssd1306` instead of bare `ssd1306`.

### MCU-side behavior — `ctx.partSimulations.register`

The part simulation is the plugin's bridge between the running AVR/RP2040
and the DOM element on the canvas. It implements two optional hooks:

```ts
ctx.partSimulations.register('demo.oled-lite', definePartSimulation({
  // Fired when an MCU pin connected to this component toggles.
  onPinStateChange(pinName, state, element) {
    /* update visual state */
  },

  // Fired once when the simulator starts. Return cleanup.
  attachEvents(element, sim) {
    const handler = () => sim.setPinState(7, true);    // requires simulator.pins.write
    element.addEventListener('click', handler);
    return () => element.removeEventListener('click', handler);
  },
}));
```

The `sim` argument is a `SimulatorHandle`:

```ts
interface SimulatorHandle {
  readonly componentId: string;
  readonly boardPlatform: 'avr' | 'rp2040' | 'esp32' | 'unknown';            // no permission
  isRunning(): boolean;
  setPinState(pin: number, state: boolean): void;                            // needs simulator.pins.write
  getArduinoPin(componentPinName: string): number | null;
  onPinChange(pinName: string, cb: (state: PinState) => void): Disposable;   // needs simulator.pins.read
  onPwmChange(pinName: string, cb: (duty: number) => void): Disposable;      // needs simulator.pwm.read
  onSpiTransmit(cb: (byte: number) => void): Disposable;                     // needs simulator.spi.read
  schedulePinChange(pinName: string, state: boolean, cyclesFromNow: number): void; // needs simulator.pins.write
  registerI2cSlave(addr: number, handler: I2cSlaveHandler): Disposable;      // needs simulator.i2c.write
  registerSpiSlave(handler: SpiSlaveHandler): Disposable;                    // needs simulator.spi.write
  setAnalogValue(pinName: string, volts: number): void;                      // needs simulator.analog.write
  onSensorControlUpdate(cb: (values: Record<string, number | boolean>) => void): Disposable; // needs simulator.sensors.read
  cyclesNow(): number;
  clockHz(): number;
}
```

#### Subscribing to pin transitions — `onPinChange`

`onPinChange` is the canonical way to react to digital edges on **this
component's own pin**. It resolves the pin name once (via the same wire
graph `getArduinoPin` reads) and subscribes to the host's pin manager —
plugins do not see Arduino board pin numbers, only their own
component-side names like `'DOUT'` or `'CS'`.

```ts
ctx.partSimulations.register('demo.tally-counter', definePartSimulation({
  attachEvents(element, sim) {
    let count = 0;
    const sub = sim.onPinChange('TRIG', (state) => {
      if (state) count++;            // count rising edges
      element.textContent = String(count);
    });
    return () => sub.dispose();      // tear down on simulator stop
  },
}));
```

Important contract details:

- **Resolved at subscription time.** If `getArduinoPin(pinName)` returns
  `null` (the pin is not wired), `onPinChange` returns a no-op
  `Disposable` and the callback never fires. Plugins that need to react
  to wires being added later should re-subscribe on
  `events.on('wire:connect', …)`.
- **Single pin signature.** The callback receives only the boolean
  `state`. The `pin` and `componentId` are implicit (the handle is
  per-component, the pin name was passed at subscribe time).
- **Caller owns the dispose.** Subscriptions are NOT auto-tracked
  inside `attachEvents` — if you wire one up, return a teardown that
  calls `sub.dispose()`. Long-lived subscriptions made outside
  `attachEvents` should be added to `ctx.subscriptions` so they fire on
  plugin deactivation.

#### Observing PWM duty — `onPwmChange`

Digital edges are enough for LEDs and buttons. Servos, fan controllers,
tone generators, and most analog-looking outputs need the PWM duty cycle
instead. `onPwmChange` fires whenever the MCU's PWM unit updates the
duty for the subscribed pin; `duty` is a 0‒1 fraction.

```ts
// servo: map duty → angle (0.05 ≈ 1 ms → 0°, 0.10 ≈ 2 ms → 180°)
ctx.partSimulations.register('demo.servo-sg90', definePartSimulation({
  attachEvents(element, sim) {
    const sub = sim.onPwmChange('SIG', (duty) => {
      const angle = Math.max(0, Math.min(180, (duty - 0.05) * 1800));
      (element as HTMLElement).style.setProperty('--angle', `${angle}deg`);
    });
    return () => sub.dispose();
  },
}));
```

Same late-arriving-wire rules as `onPinChange`: unwired at subscribe
time → no-op Disposable, no auto-retry. Requires `simulator.pwm.read`.

#### Observing SPI traffic — `onSpiTransmit`

SPI displays (ILI9341, ST7789, SSD1331) and flash chips need to see
every byte the MCU shifts out. `onSpiTransmit` gives a per-byte
callback. The host wraps AVRSPI's single `onTransmit` slot, so multiple
subscribers stack in dispose order — disposing one subscription does
not tear down another.

```ts
ctx.partSimulations.register('demo.ili9341', definePartSimulation({
  attachEvents(element, sim) {
    let inCommand = false;

    const dc = sim.onPinChange('DC', (state) => { inCommand = !state; });
    const spi = sim.onSpiTransmit((byte) => {
      if (inCommand) handleCommand(byte);
      else           handlePixel(byte);
    });

    return () => { dc.dispose(); spi.dispose(); };
  },
}));
```

Callbacks are fault-isolated — a throw inside one subscriber does not
block the next. Requires `simulator.spi.read`. On boards without SPI
(ESP32 bridge, pre-start), the subscription is a no-op Disposable.

#### Scheduling a future edge — `schedulePinChange`

HC-SR04 ultrasonic sensors echo back after a distance-proportional
delay. DHT22 sensors drive the data line in precise microsecond
windows. Plugins express this as "drive pin X to state S, N cycles from
now" — the host converts to an absolute cycle via `cyclesNow() + N` and
enqueues it on the simulator's scheduler.

```ts
// HC-SR04: when TRIG goes high, echo back after ~2 * distance_cm * 58 µs
ctx.partSimulations.register('demo.hcsr04', definePartSimulation({
  attachEvents(element, sim) {
    const distanceCm = 42;
    const clk = sim.clockHz();
    const usToCycles = (us: number) => Math.round((us / 1_000_000) * clk);

    const trig = sim.onPinChange('TRIG', (state) => {
      if (!state) return;                                   // rising edge only
      const pulseUs = Math.round(distanceCm * 58);
      sim.schedulePinChange('ECHO', true,  usToCycles(10));           // echo start
      sim.schedulePinChange('ECHO', false, usToCycles(10 + pulseUs)); // echo end
    });

    return () => trig.dispose();
  },
}));
```

`cyclesFromNow` is **relative**, clamped to `Math.max(0, n | 0)` — the
host does the add. Requires `simulator.pins.write`. Silent no-op when
the pin is not wired or the host scheduler is missing.

#### Acting as an I²C slave — `registerI2cSlave`

OLED displays, RTCs, IMUs, and most sensor fusion chips speak I²C.
`registerI2cSlave` lets a plugin participate in the bus as a virtual
slave at a fixed 7-bit address. The handler mirrors the host's
`I2CDevice` shape 1:1 — `writeByte` returns `true` to ACK, `false` to
NAK; `readByte` returns the next byte the master will read; optional
`stop` fires on bus release.

```ts
// minimal SSD1306 at 0x3C — just ACK everything, latch the last command
ctx.partSimulations.register('demo.ssd1306-lite', definePartSimulation({
  attachEvents(element, sim) {
    let lastCmd = 0;
    const slave = sim.registerI2cSlave(0x3c, {
      writeByte(v) { lastCmd = v; return true; },
      readByte()   { return 0xff; },
      stop()       { /* flush framebuffer, etc. */ },
    });
    return () => slave.dispose();
  },
}));
```

Requires `simulator.i2c.write` (a virtual slave can drive bytes back
to the master, hence the write tier rather than the passive-read
tier). Silent no-op when the host has no I²C bus.

#### Timing primitives — `cyclesNow` / `clockHz`

Two small reads that bit-banged protocols and timing-sensitive sensors
need. `cyclesNow()` returns the simulator's monotonic cycle counter;
`clockHz()` returns the MCU clock (16 MHz on AVR, varies on RP2040).
Together they let a plugin compute µs/ms windows without reaching
around the handle.

```ts
// DHT22: the 1-wire protocol encodes bits as pulse widths
const clk = sim.clockHz();
const startCycle = sim.cyclesNow();
// … later, inside a pin-change handler …
const elapsedUs = ((sim.cyclesNow() - startCycle) / clk) * 1_000_000;
```

Both have conservative fallbacks: `cyclesNow()` returns `0` if the
host can't provide a counter; `clockHz()` returns `16_000_000`.
Neither requires a permission — they expose no new capability beyond
what the handle already gives plugins.

#### Injecting ADC voltages — `setAnalogValue`

Potentiometers, photoresistors, joysticks, and most analog sensors
need to push a voltage into the MCU's ADC. `setAnalogValue(pinName,
volts)` takes **volts** and the host converts to the right raw sample
for the running board (10-bit AVR at 5 V reference, 12-bit RP2040 at
3.3 V reference, 12-bit ESP32 at 3.3 V reference). Plugins stay
board-agnostic.

```ts
// Potentiometer: <input type="range"> in the panel drives the ADC reading
ctx.partSimulations.register('demo.potentiometer', definePartSimulation({
  attachEvents(element, sim) {
    const slider = element.querySelector('input')!;
    const onInput = () => {
      const ratio = Number(slider.value) / 100;   // 0..1
      sim.setAnalogValue('SIG', ratio * 5.0);     // 0..5 V (AVR reference)
    };
    slider.addEventListener('input', onInput);
    return () => slider.removeEventListener('input', onInput);
  },
}));
```

Requires `simulator.analog.write` (**High** — plugins can drive any
ADC reading the sketch takes, same severity class as
`simulator.pins.write`). Silent no-op when the resolved pin isn't
analog-capable (AVR pins outside 14–19, RP2040 pins outside 26–29)
or the board has no ADC surface.

#### Reacting to sensor control panel — `onSensorControlUpdate`

The simulator ships a `SensorControlPanel` UI that gives users sliders,
toggles and joysticks for every sensor component. Plugins subscribe
to it via `onSensorControlUpdate(handler)` — the host routes panel
values to the right component instance automatically (keyed by
`componentId`).

```ts
// Tilt-switch with a Boolean toggle in the panel
ctx.partSimulations.register('demo.tilt-switch', definePartSimulation({
  attachEvents(element, sim) {
    const sub = sim.onSensorControlUpdate((values) => {
      if (typeof values.toggle === 'boolean') {
        sim.setPinState(sim.getArduinoPin('SIG')!, values.toggle);
      }
    });
    return () => sub.dispose();
  },
}));
```

The `values` record is a `Record<string, number | boolean>` whose keys
are whatever the component declares. The panel filters to only
changed keys, so a slider move for `temperature` won't redundantly
ship `humidity`. One listener per `componentId` — a second
`onSensorControlUpdate` replaces the first.

Requires `simulator.sensors.read` (**Low** — read-only observation of
user input; no MCU side-effects without a separate `setAnalogValue`
or `setPinState` call).

#### Acting as an SPI slave — `registerSpiSlave`

`onSpiTransmit` (observer) sees bytes but can't **reply** on MISO.
SPI displays with readback (ILI9341 RAMRD), microSD cards, and flash
chips must respond to the master byte-by-byte. `registerSpiSlave`
takes a handler whose `onByte(master)` return value becomes the byte
shifted back to the master on the same transfer.

```ts
ctx.partSimulations.register('demo.ili9341', definePartSimulation({
  attachEvents(element, sim) {
    let dcCommand = false;
    const dc = sim.onPinChange('DC', (state) => { dcCommand = !state; });
    const slave = sim.registerSpiSlave({
      onByte(master) {
        if (dcCommand) processCommand(master);
        else           processData(master);
        return 0xff;                             // most writes return open-drain
      },
      stop() { /* CS went HIGH or a new slave displaced us */ },
    });
    return () => { dc.dispose(); slave.dispose(); };
  },
}));
```

Not stackable: a single SPI bus has one active slave. Calling
`registerSpiSlave` again displaces the first — the displaced handler's
optional `stop()` fires so it can release CS-driven state. The return
value is clamped to `Uint8` and defaults to `0xff` if the plugin's
`onByte` throws (fault isolation — a crashing slave doesn't break
the SPI stream).

Requires `simulator.spi.write` (**High** — the slave drives bytes the
sketch interprets as real device data). Silent no-op when the board
has no SPI peripheral.

#### Board platform hints — `boardPlatform`

`sim.boardPlatform` is a read-only string: `'avr'`, `'rp2040'`,
`'esp32'`, or `'unknown'`. Use it sparingly — prefer feature-probing
via the handle's methods (no-op Disposables on unsupported surfaces).
It's there for the rare cases where behavior genuinely differs by
board (servo PWM frequency interpretation, ADC reference voltage).

```ts
const vRef = sim.boardPlatform === 'avr' ? 5.0 : 3.3;
sim.setAnalogValue('SIG', value * vRef);
```

No permission required — passive identifier, no observation
capability.

#### Fault isolation

Both hooks run inside the host simulator loop, so a thrown error would crash
the simulator for every other component. The host wraps every plugin-supplied
`onPinStateChange` and `attachEvents` in a try/catch — the throw is logged
through `ctx.logger.error` (tagged `[plugin:<id>]`) and **swallowed**. A
throwing `attachEvents` returns a no-op cleanup so the host's later teardown
can't double-fault.

This is automatic; plugin authors do not need to wrap their own code. But
remember: a plugin that silently misbehaves is harder to debug than one that
crashes loudly during development. Use `ctx.logger.error` explicitly when you
catch errors yourself.

### Electrical-mode mapping — `ctx.spice.registerMapper`

For components that have meaningful behavior in electrical (SPICE) mode,
register a mapper. The mapper is called once per netlist build (not per tick)
and converts the component instance into raw ngspice cards.

```ts
import { defineSpiceMapper } from '@velxio/sdk';

ctx.spice.registerMapper('demo.fancy-rvariable', defineSpiceMapper((comp, netLookup) => {
  const a = netLookup('1');
  const b = netLookup('2');
  if (!a || !b) return null;       // floating — emit nothing
  const r = String(comp.properties.resistance ?? '5k');
  return {
    cards: [`R_${comp.id} ${a} ${b} ${r}`],
    modelsUsed: new Set(),
  };
}));
```

Need a SPICE model card too?

```ts
ctx.spice.registerModel(
  'DPLUGIN',
  '.model DPLUGIN D(Is=1e-15 N=1)',
);

ctx.spice.registerMapper('demo.fancy-diode', defineSpiceMapper((comp, netLookup) => {
  const a = netLookup('A');
  const k = netLookup('K');
  if (!a || !k) return null;
  return { cards: [`D_${comp.id} ${a} ${k} DPLUGIN`], modelsUsed: new Set(['DPLUGIN']) };
}));
```

The host emits matching `.model` cards into the netlist when any mapper's
`modelsUsed` references their name.

### Internal nets — `ctx.internalNode(suffix)`

A mapper that needs an extra node — a BJT with an intermediate base tap, an
op-amp with a virtual-ground point, an integrator with a feedback midpoint —
must NEVER invent its own net name from `comp.id`. Two instances of the same
component would produce identical strings and short their internal state
together.

`ctx.internalNode(suffix)` is the only safe way to mint one. The host scopes
the returned name by the current component id, so two instances of the same
mapper get distinct nets:

```ts
import { defineSpiceMapper } from '@velxio/sdk';

ctx.spice.registerMapper('demo.bjt-with-tap', defineSpiceMapper((comp, netLookup, ctx) => {
  const c = netLookup('C');
  const e = netLookup('E');
  if (!c || !e) return null;

  const internal = ctx.internalNode('vbe_tap');   // → "n_<comp.id>_vbe_tap"

  return {
    cards: [
      `Q_${comp.id} ${c} ${internal} ${e} BJT_NPN`,
      `R_${comp.id}_base ${internal} 0 1k`,
    ],
    modelsUsed: new Set(['BJT_NPN']),
  };
}));
```

**Contract** (host-enforced):

| Property                     | Behavior |
|------------------------------|----------|
| Namespace                    | `n_${componentId}_${suffix}` after both are sanitized to `[A-Za-z0-9_]` (so `comp-12345-abc` + `vbe.tap` → `n_comp_12345_abc_vbe_tap`). |
| Per-component scoping        | Two instances of the same mapper → distinct nets, even with the same `suffix`. |
| Idempotent within one call   | `ctx.internalNode('foo')` twice in one invocation → the same string. |
| Stable across rebuilds       | Same inputs → same name. AC analyses can reference internal nodes across rebuilds. |
| Floating detection           | Internal nodes participate in the auto pull-down detector. A node connected only via a capacitor to the rest of the circuit gets a 100 MΩ pull-down to ground, just like any other floating net. |
| Empty / non-string `suffix`  | Throws `Error("internalNode(suffix) requires a non-empty string, …")` — the host refuses to mint debug-hostile names like `n_<id>_undefined`. |

**Why per-component scoping matters.** Auto-named nets in the host are pure
`n0` / `n1` / `n2` … (no underscore). Internal nodes use `n_<id>_<suffix>`,
so plugin internal nodes can never collide with the auto-named namespace
either.

## Compact authoring — `defineCompoundComponent` + `registerCompound`

The three-call flow above (component + part-sim + spice + spice-models) is the
foundation, but most components want every layer at once. `defineCompoundComponent`
is the identity helper that lets you describe everything in **one literal**, and
`ctx.components.registerCompound()` fans it out to the same gated registries as
the discrete calls — under the same permission rules, with the same disposables.

```ts
import {
  defineCompoundComponent,
  definePartSimulation,
  defineSpiceMapper,
} from '@velxio/sdk';

export const oledLite = defineCompoundComponent({
  // ── ComponentDefinition fields (always required) ──
  id: 'demo.oled-lite',
  name: 'OLED-lite 0.96"',
  category: 'displays',
  element: 'wokwi-ssd1306',
  description: 'A monochrome 128x64 OLED',
  pins: [
    { name: 'VCC', x: 0, y: 0,  signal: 'power-vcc' },
    { name: 'GND', x: 0, y: 5,  signal: 'power-gnd' },
    { name: 'SCL', x: 0, y: 10, signal: 'i2c-scl' },
    { name: 'SDA', x: 0, y: 15, signal: 'i2c-sda' },
  ],

  // ── Optional: MCU-side behavior ──
  simulation: definePartSimulation({
    attachEvents: (el, sim) => {
      // ... draw to the canvas, listen for I2C, etc.
      return () => { /* cleanup */ };
    },
  }),

  // ── Optional: SPICE mapper ──
  spice: defineSpiceMapper((c, netLookup) => {
    const v = netLookup('VCC');
    const g = netLookup('GND');
    if (!v || !g) return null;
    return { cards: [`R_${c.id}_load ${v} ${g} 250`], modelsUsed: new Set() };
  }),

  // ── Optional: SPICE .model cards your mapper references ──
  spiceModels: [
    { name: 'D_OLED', card: '.model D_OLED D(Is=1e-15)' },
  ],
});

export function activate(ctx) {
  const handle = ctx.components.registerCompound(oledLite);
  ctx.subscriptions.add(handle);
}
```

### Permission union

`registerCompound` requires the **union** of the underlying register calls:

| Field set on the literal | Permission added                |
|--------------------------|---------------------------------|
| _always_                 | `components.register`           |
| `simulation`             | `simulator.pins.read`           |
| `spice` or `spiceModels` | `simulator.spice.read`          |

Permissions are enforced naturally — `registerCompound` calls the same gated
adapters one at a time, so a missing permission throws `PermissionDeniedError`
from the same gate as the discrete call would.

### Rollback on partial failure

If any sub-registration throws (typically because a permission is missing, or
because the component id collides with `DuplicateComponentError`), every
already-acquired sub-handle is disposed in **LIFO order** before the error is
re-raised. The component never appears half-registered in the picker, no
orphan part-sim or mapper is left behind, and the plugin can catch the error
at activation time.

### Single dispose tears down everything

The returned `Disposable` is a thin wrapper around the LIFO unwind of every
acquired sub-handle. Disposing it once releases the picker entry, the part
simulation, the SPICE mapper, and every `.model` card in one call. Calling
`dispose()` a second time is a safe no-op (matches `ctx.subscriptions`
contract — every host disposable is idempotent).

### When to prefer the three-call flow

The discrete `register()`, `partSimulations.register()`, `spice.registerMapper()`
calls are still the canonical surface and remain fully supported. Reach for them
when:

- you want different `Disposable` lifetimes per layer (e.g. swap the SPICE
  mapper at runtime without touching the picker entry);
- you're consuming an **external** `ComponentDefinition` and only contributing
  one of the three layers (e.g. adding a SPICE mapper to a built-in element);
- a parent module owns the component definition and individual modules
  contribute their own layer.

Otherwise — for self-contained components — `defineCompoundComponent` cuts the
boilerplate by ~3× and keeps the entire definition in one reviewable literal.

## High-level part authoring — `defineHighLevelPart` + `registerHighLevel`

`ctx.partSimulations.register()` hands the plugin a bare `SimulatorHandle` with
`onPinChange` / `setPinState` / `getArduinoPin`. That contract is complete and
stable, but it leaves every author re-implementing the same three pieces
whenever they build an interactive component:

1. tracking current pin state for a UI render (by subscribing to `onPinChange`
   and stashing the last value),
2. converting boolean level to a human-readable `'low'`/`'high'`/`'floating'`,
3. observing serial / I²C traffic across the bus.

`ctx.partSimulations.registerHighLevel(id, def)` packages those three pieces
behind a richer `PartSimulationAPI`:

```ts
import { defineHighLevelPart } from '@velxio/sdk';

const button = defineHighLevelPart({
  pins: ['SIG'],                      // pins you intend to touch
  attach(element, api) {
    const onDown = () => api.pin('SIG').set('low');
    const onUp   = () => api.pin('SIG').set('high');
    element?.addEventListener('mousedown', onDown);
    element?.addEventListener('mouseup',   onUp);

    const unsub = api.pin('SIG').onChange((level) => {
      console.log('[button] SIG is now', level);   // 'low' | 'high' | 'floating'
    });

    return () => {
      element?.removeEventListener('mousedown', onDown);
      element?.removeEventListener('mouseup',   onUp);
      unsub.dispose();
    };
  },
});

// In activate(ctx):
const handle = ctx.partSimulations.registerHighLevel('demo.button', button);
ctx.subscriptions.add(handle);
```

### `PartSimulationAPI` — what the author gets

| Surface                | Purpose                                                              | Notes                                                                                                          |
|------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `pin(name).state`      | Last level observed on the pin (`'low'` / `'high'` / `'floating'`).  | `'floating'` until the first transition is seen. Throws for pin names not declared in `def.pins`.              |
| `pin(name).onChange`   | Fire-on-transition subscription.                                      | Returns `Disposable`; idempotent `dispose()`.                                                                  |
| `pin(name).set(level)` | Force-set the MCU-side pin from the component side.                   | Gated at call time on `simulator.pins.write`. Silent no-op when the pin is not wired.                          |
| `serial.onRead(fn)`    | Observe every byte the MCU transmits on UART0.                        | Backed by the `serial:tx` event. Returns `Disposable`.                                                         |
| `i2c.onTransfer(fn)`   | Observe every transaction on the I²C bus.                             | Backed by the `i2c:transfer` event; listener is responsible for filtering by `event.addr`. Returns `Disposable`. |

### Permission requirements

| Entry point                                 | Permission(s) required        |
|---------------------------------------------|--------------------------------|
| `registerHighLevel(id, def)` (register time)| `simulator.pins.read`         |
| `api.pin(n).set(…)` (call time)             | `simulator.pins.write`        |
| `api.serial.onRead(fn)`                     | — (subscribes to read-only events) |
| `api.i2c.onTransfer(fn)`                    | — (subscribes to read-only events) |

The register-time gate matches `partSimulations.register()`. `set()` gates at
call time instead of register time so a part can freely observe pins without
the `pins.write` permission and still be written if its other pins need to
drive the MCU.

### State tracking contract

- `pin(name).state` is initialized to `'floating'` at `attach(...)` time and
  updates on every observed transition. It does **not** do a synchronous initial
  read of the PinManager — `'floating'` is the intentionally conservative
  default for the first frame. If the first transition hasn't happened yet,
  the value stays `'floating'`.
- Declaring `pins` is load-bearing: `api.pin(name)` throws for any name not
  in `def.pins`. Declare every pin you intend to touch — missing declarations
  surface at `attach(...)` time rather than at a random later frame.

### Teardown

`attach(element, api)` returns a teardown function. The host calls it when the
simulator stops or when the plugin is unloaded, and **always** releases every
internal subscription afterwards — even if your teardown throws. Subscriptions
you create via `api.pin(n).onChange` / `api.serial.onRead` / `api.i2c.onTransfer`
are also auto-disposed as part of the host's cleanup, so you only need to tear
down what `attach` itself allocates (DOM listeners, intervals, external
handles).

### When to prefer the low-level `register()` flow

- You need to interact with the `SimulatorHandle` directly (e.g. for
  `handle.componentId` or `handle.isRunning()`).
- Your part doesn't care about pin-state tracking (e.g. it only drives the
  element in response to MCU state changes via `onPinStateChange`).
- You need synchronous initial-state reads today.

In those cases stay on `ctx.partSimulations.register(...)` — the low-level
contract is fully supported and `defineHighLevelPart` is purely additive.

## Disposal & teardown — `ctx.subscriptions`

Every `register()` returns a `Disposable` (`{ dispose(): void }`). The host's
`PluginContext` collects every disposable the plugin acquires through `ctx`
into a single store, `ctx.subscriptions`, and tears it all down LIFO when the
plugin uninstalls — even if the plugin forgets. You should also push
disposables you create yourself (intervals, event listeners, custom workers)
into the same store so they participate in the same teardown:

```ts
ctx.subscriptions.add({
  dispose() { clearInterval(myTicker); }
});
```

`ctx.addDisposable(d)` is a convenience alias for `ctx.subscriptions.add(d)`
— pick whichever reads better at the call site. Returning a `Disposable`
(or array of them) from `activate(ctx)` is also supported and goes through
the same store.

### Guarantees

- **LIFO unwind.** Disposables run in reverse-acquisition order.
- **Idempotent.** Calling `subscriptions.dispose()` twice is a no-op.
- **Fault-isolated.** A throw inside one disposable is logged via
  `ctx.logger.error` and swallowed — the rest still run.
- **Late-arrival safe.** After `dispose()`, any later `subscriptions.add(d)`
  disposes `d` immediately and warns. This catches the common bug of an
  async task producing a disposable after the plugin has been deactivated.
- **One store.** Every host-managed registry handle (commands, components,
  spice mappers, …) ends up in the SAME store as your plugin-managed
  disposables. There is no second list to forget about.

### Do NOT rely on dispose() ordering across stores

`subscriptions` is per-context. If you ever build a multi-context plugin
(unusual but possible — for instance, one for the editor pane and one for
the simulator pane), each context has its own LIFO list. Their relative
order is undefined.

## Pure-data contributions — `ctx.templates` and `ctx.libraries`

Two plugin shapes are **data, not code**: project templates and Arduino
libraries. Neither needs a worker, neither runs JS at activation, and both
are validated synchronously at `register()` so a malformed bundle fails in
dev rather than at use time.

### Project templates — `ctx.templates.register`

A template is a serializable `ProjectSnapshot` (board + sketch files +
components + wires) that the editor can instantiate from scratch as a
"New from template" entry.

```ts
import { defineTemplate } from '@velxio/sdk';

const blink = defineTemplate({
  id: 'demo.blink',
  name: 'Blink',
  description: 'The Hello World of Arduino — toggles the built-in LED.',
  category: 'beginner',                 // beginner | intermediate | advanced | showcase
  difficulty: 1,                        // 1..5
  tags: ['led', 'gpio', 'beginner'],
  thumbnail: 'data:image/svg+xml;…',
  readme: '# Blink\nA gentle introduction…',  // markdown, sandboxed
  snapshot: {
    schemaVersion: 1,
    board: 'arduino-uno',
    files: [
      { name: 'sketch.ino', content: 'void setup(){ pinMode(13, OUTPUT); }\nvoid loop(){ digitalWrite(13, !digitalRead(13)); delay(500); }' },
    ],
    components: [
      { id: 'uno', metadataId: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
});

ctx.templates.register(blink);
```

#### Validation

The snapshot is parsed with a Zod schema **at register time**. Failures
throw `InvalidTemplateError` synchronously with a message that points at
the offending field. Specifically:

- `schemaVersion` must be `1`.
- `files` must have 1–64 entries, each ≤ 500 KB.
- Total file bytes ≤ 1 MB (`TEMPLATE_MAX_TOTAL_BYTES`).
- `components` ≤ 512, `wires` ≤ 2048.
- Every wire endpoint's `componentId` must exist in `components[]`.

Use `validateProjectSnapshot()` from `@velxio/sdk` to run the same
validation in your build/lint tooling.

#### Duplicate ids are a hard error

Same rationale as `DuplicateComponentError`: silent shadowing of an
existing template id would mean two plugins racing for the same picker
entry. `ctx.templates.register()` throws `DuplicateTemplateError` if the
id is already registered. To replace your own entry, dispose the prior
handle first.

### Arduino libraries — `ctx.libraries.register`

Plugins can ship vendored Arduino/PlatformIO libraries (`.h`/`.cpp`/`.S`
files) that the host injects into the sketch's `libraries/` folder before
`arduino-cli` runs. The host **never reaches the network** to fetch
them — every byte comes from the plugin bundle.

```ts
import { defineLibrary } from '@velxio/sdk';

const adafruitGfx = defineLibrary({
  id: 'Adafruit_GFX',                   // arduino-cli folder name
  version: '1.11.5',                    // semver, recorded only
  files: [
    { path: 'src/Adafruit_GFX.h',   content: '#pragma once\n…' },
    { path: 'src/Adafruit_GFX.cpp', content: '#include "Adafruit_GFX.h"\n…' },
    { path: 'library.properties',   content: 'name=Adafruit GFX\nversion=1.11.5\n' },
  ],
  platforms: ['avr', 'rp2040'],         // avr | rp2040 | esp32
  examples: [{ name: 'mock_ili9341', sketch: '#include <Adafruit_GFX.h>\nvoid setup(){}\nvoid loop(){}' }],
});

ctx.libraries.register(adafruitGfx);
```

#### Validation rules

`ctx.libraries.register()` runs `validateLibraryDefinition()` synchronously
and throws `InvalidLibraryError` on the first failure. The rules:

| Rule                              | Cap / requirement                                            |
|-----------------------------------|--------------------------------------------------------------|
| Per-file size                     | ≤ 512 KB                                                     |
| Total bundle size                 | ≤ 2 MB                                                       |
| File path                         | Relative, no `..`, no leading `/`, allowed chars only        |
| Path depth                        | ≤ 8 segments                                                 |
| File extensions                   | `.h .hpp .hh .c .cc .cpp .cxx .s .S .inc .ino .txt .md .properties` |
| Duplicate paths                   | Rejected                                                     |
| `#include "…"` / `#include <…>`   | No `..`, no absolute paths                                   |
| `#pragma`                         | Allowlisted: `once pack GCC clang message warning error`     |
| `#define`, `#if`, `#ifdef`        | Allowed (legitimate library code shouldn't be blocked)       |

Use `validateLibraryDefinition()` from `@velxio/sdk` to run the same
checks in your build tooling.

#### Dependency resolution

If your library depends on others, declare it via `dependsOn`. The
registry exposes `resolve(ids)` for the host's compile pipeline:

```ts
const ssd1306 = defineLibrary({
  id: 'Adafruit_SSD1306',
  version: '2.5.7',
  files: [...],
  platforms: ['avr', 'rp2040'],
  dependsOn: ['Adafruit_GFX', 'Adafruit_BusIO'],  // both must be registered too
});

ctx.libraries.register(ssd1306);

// Later, the compile pipeline calls:
const order = ctx.libraries.resolve(['Adafruit_SSD1306']);
//   → [Adafruit_GFX, Adafruit_BusIO, Adafruit_SSD1306]   (deps before dependent)
```

`resolve()` is a topological sort. Unknown ids are silently skipped — the
compiler will surface "library not found" if the user actually `#include`s
something that's missing. A circular `dependsOn` graph throws
`LibraryDependencyCycleError` with the offending path.

#### Duplicate ids are a hard error

Library ids are folder names in arduino-cli, so two libraries with the
same id would silently collide in the temp build dir. The host throws
`DuplicateLibraryError` to surface the conflict at activation.

### SDK-004b — wiring templates and libraries to the host

SDK-004 shipped the pure data contracts; SDK-004b connects them to the
two pipelines users actually touch:

#### Compile pipeline injection

`compileCode()` (`frontend/src/services/compilation.ts`) reads the
`HostLibraryRegistry` before each POST to `/api/compile`:

1. `platformForFqbn(boardFqbn)` maps the FQBN to one of `'avr' | 'esp32'
   | 'rp2040'` (or `null` for unrecognized boards). RP2040 matches both
   the official `arduino:mbed_rp2040:*` and the earlephilhower
   `rp2040:rp2040:*` variants.
2. `collectLibrariesForBoard(fqbn)` filters the registry by
   `LibraryDefinition.platforms`, asks `LibraryRegistry.resolve(ids)` to
   return the topological closure (so each library lands after its
   `dependsOn` deps), then maps to the wire shape `{id, version, files:
   [{path, content}]}`. All other fields (`examples`, `dependsOn`,
   `description`, …) are stripped — the backend only needs what it
   mounts on disk.
3. The `libraries` field is **only set when non-empty**. An empty list
   omits the field entirely so requests from boards with no matching
   plugins look identical to a stock Velxio install.

The backend (`backend/app/api/routes/compile.py`) re-validates every
incoming library through `app/services/library_validation.py`, which
mirrors the SDK's Zod rules byte-for-byte (path-safety regex, depth ≤ 8,
extension allowlist, `#pragma` allowlist, ≤ 512 KB per file, ≤ 2 MB
total). Status mapping is precise:

- 400 → semantic violation (path traversal, hidden segments, banned
  pragma, duplicate ids inside the same request)
- 413 → size violation (per-file or total cap)
- 422 → Pydantic structural failure (e.g. empty `files` list)

Validation always runs server-side because the Vite client is
untrusted — a modified browser cannot bypass it.

`arduino_cli._materialize_libraries()` writes each accepted library to
`<sketch_dir>/libraries/<id>/<file.path>` inside the existing
`tempfile.TemporaryDirectory()` so cleanup is automatic, then injects
`--libraries <root>` into the `arduino-cli` command via `cmd[-1:-1] =
[...]` so the sketch positional stays last on both AVR and ESP32 build
branches.

#### Template picker

`<TemplatePickerModal />` (`frontend/src/components/layout/`) reads the
template registry through `useSyncExternalStore`. Two consequences worth
calling out:

- Both `HostTemplateRegistry` and `HostLibraryRegistry` cache their
  sorted `list()` snapshot and invalidate it on every register / dispose
  / reset. Without this, `useSyncExternalStore` raises *"The result of
  getSnapshot should be cached to avoid an infinite loop"* because each
  call returned a fresh `Array.from(...).sort(...)`.
- The SDK's `TemplateDefinition.snapshot.wires[]` only carries
  `{componentId, pinName}` per endpoint — wire `(x, y)` are DOM-derived.
  After mounting components, the modal awaits **two `requestAnimationFrame`
  ticks** before resolving pin coordinates: the first commits the React
  tree, the second gives wokwi-elements time to populate `pinInfo`.
  Endpoints whose pins still don't resolve fall back to `(0, 0)`; the
  next interaction calls `updateWirePositions()` and snaps them into
  place.

The Templates button in `AppHeader` is gated on `pathname === '/editor'`
so it only appears on the editor surface.

#### Tests

| File | Count | What it locks down |
|------|-------|--------------------|
| `backend/tests/test_library_validation.py` | 28 | Path safety params, allowed extensions/pragmas, batch behaviour, 400 vs 413 status hint |
| `backend/tests/test_compile_route_libraries.py` | 6 | TestClient happy path, traversal → 400, oversize → 413, empty → 422, duplicate ids → 400 |
| `frontend/src/__tests__/compilation-libraries.test.ts` | 8 | Platform filter for avr/esp32/rp2040, topo sort (Core before Wrapper), `{id,version,files}` shape, omit-when-empty |
| `frontend/src/__tests__/TemplatePickerModal.test.tsx` | 6 | Empty state, grouping, default preview, switching, instantiation drives stores, properties cloning |

End-to-end coverage with a real plugin bundle (worker + license gate +
loader cache) waits on a CORE-007 plugin fixture; today the registries
are exercised through `registerFromPlugin()` directly, which traverses
the same code paths.

## Translatable strings — `ctx.i18n`

Plugins ship UI text (command labels, panel titles, error messages) as a
**static translation bundle** keyed by locale. The host owns the active
locale; the plugin reads translations through `ctx.i18n.t(key, vars?)`.
There is no permission gate — translations are local, read-only data.

```ts
import { definePlugin, defineI18nBundle } from '@velxio/sdk';

const strings = defineI18nBundle({
  en: { 'cmd.run': 'Run analysis', 'panel.title': 'Logic Probe' },
  es: { 'cmd.run': 'Analizar',     'panel.title': 'Sonda lógica' },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.add(ctx.i18n.registerBundle(strings));

    ctx.commands.register({
      id: 'logic.run',
      title: ctx.i18n.t('cmd.run'),
      run: () => { /* … */ },
    });

    // React to locale changes — re-register affected entries with the new strings.
    ctx.subscriptions.add({
      dispose: ctx.i18n.onLocaleChange(() => {
        // Re-create translation-dependent UI here. The host does not
        // re-render plugin UI for you; the plugin owns its surface.
      }),
    });
  },
});
```

### Locale resolution

`ctx.i18n.t(key)` resolves the active locale against the registered bundle in this order:

1. **Exact match** — `es-MX` → table `es-MX`.
2. **Language-only** — `es-MX` → table `es`.
3. **Region collapse** — `es` → first `es-XX` entry in the bundle.
4. **Default locale** — `en` (override-able by the host).
5. **Key fallback** — if the key is not in any matched table, the function returns the key itself. Missing strings show up as visible debug output, not as empty UI.

`ctx.i18n.format(template, vars)` runs the same `{name}` interpolation
without touching the bundle — useful when the source string came from
elsewhere (e.g. a backend error message).

### Interpolation

Translated strings can contain `{name}` placeholders. They're substituted
from the `vars` object. Doubled braces (`{{`, `}}`) are emitted as literal
braces. Missing variables leave the placeholder in place so the bug is
visible in the rendered string instead of printing `undefined`.

```ts
ctx.i18n.t('greeting', { name: 'David' });   // "Hello, David!"
ctx.i18n.t('greeting', {});                  // "Hello, {name}!"  ← missing var stays literal
```

### Validation rules

`ctx.i18n.registerBundle(bundle)` runs synchronously and throws
`InvalidI18nBundleError` (with `pluginId` baked in) if any rule fails:

| Rule | Cap |
|---|---|
| Locale tag shape | `[a-z]{2}(?:-[A-Z]{2})?` (matches manifest `i18n` field) |
| Translation key shape | `[a-zA-Z_][a-zA-Z0-9_.-]{0,127}` |
| Keys per locale | ≤ 1024 |
| Single value bytes (UTF-8) | ≤ 4 KB |
| Total bundle bytes (UTF-8 sum) | ≤ 256 KB |

These caps are picked to allow real, content-rich plugins (a 256 KB
translation table is a *lot* of UI text) while ruling out plugins that
try to ship CMS-sized payloads through a string registry.

### Lifecycle

`registerBundle()` returns a `Disposable`. Add it to `ctx.subscriptions`
so the bundle clears on plugin deactivate. Re-registering replaces the
prior bundle atomically — disposing the old handle after a re-register
is a no-op (the new bundle owns the slot).

`onLocaleChange()` returns an unsubscribe function. Wrap it in a
`Disposable` and add to `ctx.subscriptions` (the example above shows the
shape). Throws inside listener callbacks land on the plugin's logger and
do not block other listeners — same fault-isolation rule as
`ctx.events`.

### Manifest declaration

The marketplace uses `manifest.i18n: ['en', 'es']` to badge the plugin
as "available in your language" in listings. It is **declarative
metadata only** — the host does not enforce a match between the manifest
list and the registered bundle. A plugin that declares `['en', 'es']`
but ships a bundle with only `en` will simply fall back to `en` for
Spanish users; the marketplace badge will be wrong but no runtime error
fires. The CLI in SDK-009 will lint this.

### SDK-005b — editor locale picker + shell strings

SDK-005 shipped the SDK contract and host registry. SDK-005b mounts the
**user-facing UI** so the editor shell uses the same `LocaleStore` that
plugins subscribe to — a single picker change re-translates both at
once.

**Module map** (`frontend/src/i18n/`):

- `locales/en.ts` — English shell strings as `as const`. Exports
  `ShellTranslationKey = keyof typeof en`. Adding a new shell string
  means adding a key here first; every other locale file mirrors it as
  `Partial<Record<ShellTranslationKey, string>>` so the type system
  forces missing-key visibility.
- `locales/es.ts` — Spanish strings. Missing keys fall back to English,
  then to the key itself.
- `locales/index.ts` — `SHELL_LOCALES` map + `SUPPORTED_LOCALES`
  descriptors (with `nativeName` always in the locale's own language so
  a user who can't read the current UI can still find their language).
- `translator.ts` — pure `translate(locale, key, vars?)`. Same chain as
  the SDK plugin-side resolver (`resolveLocale` → `interpolate`); plus
  a final **key-as-debug fallback** so missing strings render as visible
  output instead of empty space.
- `LocaleProvider.ts` — host-side wiring on top of the SDK's
  `LocaleStore` singleton. Exports `bootEditorLocale()`,
  `setEditorLocale(code)`, `getEditorLocale()`,
  `subscribeEditorLocale(fn)`. Persists to `localStorage` under
  `velxio.locale` with a try/catch around `setItem` for Safari private
  mode.
- `useLocale.ts` — `useLocale()` and `useTranslate()` React hooks via
  `useSyncExternalStore`. `useTranslate()` returns a
  `useCallback`-memoised `t(key, vars?)` whose **identity is stable
  until the locale changes** — so a downstream `React.memo` keeps its
  identity, mirroring the `<SlotOutlet />` render-fn discipline.

**Boot order discipline** — `App.tsx` calls `bootEditorLocale()`
**before** wiring the IndexedDB settings backend, and far before the
first plugin context is constructed. Plugins read the active locale at
`registerBundle` time, so a late boot would silently lock plugins to the
SDK default `en` until the user manually flipped the picker.

```ts
// frontend/src/App.tsx
import { bootEditorLocale } from './i18n/LocaleProvider';
bootEditorLocale();              // ← MUST come first
if (typeof indexedDB !== 'undefined') {
  getSettingsRegistry().setBackend(new IndexedDBSettingsBackend());
}
```

**Resolution chain on boot** — `localStorage[velxio.locale]` (validated
against `SUPPORTED_LOCALE_CODES`) → `navigator.language` (resolved via
the SDK's `resolveLocale`, so `es-MX` collapses to `es`) →
`I18N_DEFAULT_LOCALE` (`en`). The resolved value is **persisted back**
so subsequent loads are deterministic — even if `navigator.language`
changes because the user flipped OS preferences, the explicit choice
survives.

**Picker UI** lives in the Installed Plugins modal header (the only
"editor preferences" surface today). When more cross-cutting settings
appear, lift `<LocalePicker />` into a dedicated `<EditorSettings />`
panel and stop bundling it. The picker writes via `setEditorLocale`,
which (a) persists to localStorage and (b) calls
`setActiveLocale(code)` on the host store — the same dispatch that
fires every plugin's `onLocaleChange` listener.

**Shell components currently translated** (7/7 — SDK-005c part D
closed 2026-04-24):

- `<AppHeader />` — every nav link, button label, button title, dropdown
  entry.
- `<InstalledPluginsModal />` — modal title/refresh/marketplace/close,
  EmptyState, UninstallConfirm dialog, PluginSettingsDialog.
- `<LoginPromptModal />` — title, body, sign-in/create-account/cancel
  buttons.
- `<SaveProjectModal />` — create/update titles, name + description
  fields, public/private visibility radio (with descriptions), save
  button states (idle/saving/update), error banner with the
  interpolated `{status}` from a failed HTTP call.
- `<FileExplorer />` — workspace header, save tooltip, board pill
  tooltip (interpolated `{board}`), running/compiled/idle status text,
  collapse/expand, new-file placeholder, unsaved suffix, delete
  confirm prompt, empty state, rename/delete context-menu items.
- `<TemplatePickerModal />` — title + close, built-in/`via {id}`
  provenance line, select prompt, readme disclosure, replace-warning,
  difficulty aria-label (interpolated `{level}`), empty state +
  marketplace link, the four category labels (beginner/intermediate/
  advanced/showcase). `DifficultyDots`, `EmptyState`, `TemplatePreview`
  each call `useTranslate()` internally — matches the AppHeader
  pattern.
- `<EditorToolbar />` — board pill (editing/running tooltips, language
  mode select), every toolbar button title (compile in 4 states, run
  in 3 states, stop, reset, compile-all, run-all, libraries label +
  tooltip, overflow menu items, output-console toggle), library hint
  banner (text + jump-to-manager button + dismiss), every status
  banner message (ready, micropython ready, compiled, compile-failed,
  export-failed, no-board, firmware-loaded, imported, etc.), and the
  output-console log lines (start-compile, no-fqbn, arch-mismatch,
  loading-firmware — all with interpolated vars). Backend-supplied
  error text from `result.error || result.stderr` stays verbatim —
  those strings are server-side and outside the shell scope.

**Translator shadowing rule**: never let `t` get shadowed by a
callback parameter. The TemplatePickerModal migration renamed
`templates.find((t) => …)` → `templates.find((tpl) => …)` for exactly
this reason — the shadow silently swaps a string for a TemplateRecord
and the failure mode is "category labels render as `[object Object]`",
caught only by visual inspection.

**Tests** (24 total):

- `frontend/src/__tests__/i18n.test.ts` — 11 pure tests on `translate()`:
  en/es happy path, English fallback for missing es key, key-as-debug
  fallback, region collapse (`es-MX` → `es`), unknown-language fallback,
  empty locale tolerance, missing-var literal preservation.
- `frontend/src/__tests__/i18n-boot.test.ts` — 9 jsdom tests on
  `bootEditorLocale` + `setEditorLocale`: priority chain, malformed
  stored value rejection, persistence on first boot, Safari private-mode
  tolerance (`Storage.prototype.setItem` throws → no exception bubbles
  out).
- `frontend/src/__tests__/useLocale.test.tsx` — 4 jsdom tests using
  `createRoot` + `act`: hook re-renders on `setEditorLocale`, multi-
  consumer fan-out, `useTranslate` identity stability across same-locale
  re-renders.

**LocaleStore singleton reset for tests** — both jsdom test files import
`resetLocaleStoreForTests()` from `plugin-host/I18nRegistry` in their
`beforeEach`. The hook tests also pin the locale to `'en'` before each
test so a `set('es')` is always a real change (the store deduplicates
same-value writes by design).

## User-tunable settings — `ctx.settings`

A plugin declares the **shape** of its user-facing configuration as a
small JSON-Schema-like object. The host renders the form (in the
"Installed Plugins" panel — wired in CORE-008/SDK-006b), persists the
values per (user, pluginId), and notifies the plugin via `onChange`.

```ts
import { defineSettingsSchema } from '@velxio/sdk';

const schema = defineSettingsSchema({
  type: 'object',
  properties: {
    apiKey: { type: 'string', format: 'password', title: 'API Key', minLength: 8 },
    threshold: { type: 'number', minimum: 0, maximum: 100, default: 50 },
    mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
    enabled: { type: 'boolean', default: true },
    boards: { type: 'array', items: { type: 'string' }, default: ['arduino-uno'] },
  },
  required: ['apiKey'],
});

export default definePlugin({
  async activate(ctx) {
    ctx.subscriptions.add(
      ctx.settings.declare({
        schema,
        // Optional async cross-field validator. Runs after schema checks.
        async validate(values) {
          if (!String(values.apiKey).startsWith('sk-')) {
            return { ok: false, errors: { apiKey: 'must start with sk-' } };
          }
          return { ok: true };
        },
      }),
    );

    const config = await ctx.settings.get(); // defaults filled in
    ctx.subscriptions.add({
      dispose: ctx.settings.onChange((next) => {
        ctx.logger.info('settings changed:', next);
      }),
    });
  },
});
```

### Schema language

The accepted subset is intentionally small so the renderer stays bounded:

| Type        | Modifiers                                                       |
| ----------- | --------------------------------------------------------------- |
| `string`    | `format` (`text` \| `password` \| `url` \| `email` \| `multiline`), `enum`, `minLength`, `maxLength`, `pattern` |
| `number`    | `minimum`, `maximum`, `multipleOf`                              |
| `integer`   | same as `number`, plus integer-only check                       |
| `boolean`   | —                                                               |
| `array`     | `items` MUST be `{ type: 'string' }` (string-list only)         |
| `object`    | `properties` map; one nesting level only (no objects in objects) |

Every leaf accepts `title`, `description`, `default`. The top-level
schema must be `type: 'object'` with a `properties` map and an
optional `required` list. Constants live on the SDK:
`SETTINGS_MAX_PROPERTIES = 64`, `SETTINGS_MAX_VALUES_BYTES = 32 KB`,
`SETTINGS_MAX_STRING_LENGTH = 4096`.

What's **not** in the language: `oneOf`/`allOf`, recursive `$ref`,
arrays of non-strings, more than one nested object level, unbounded
records.

### `declare`, `get`, `set`, `reset`

- **`declare(declaration)`** — required permission `settings.declare`.
  Throws `InvalidSettingsSchemaError` synchronously on a malformed
  schema. Returns a `Disposable`; disposing it removes the
  declaration. Re-declaring replaces atomically — values that still
  pass the new schema are kept; mismatched ones fall back to the new
  defaults. The OLD handle's `dispose()` after a re-declare is a
  no-op (it doesn't own the live entry anymore).
- **`get()`** — needs no further permission. Resolves with the merged
  values (raw defaults + persisted overrides). Returns `{}` when no
  schema has been declared yet — readers should always tolerate
  missing keys.
- **`set(partial)`** — partial update. Schema validation runs first;
  then the plugin's own async `validate` if one was supplied. On
  success, persists and fires every `onChange` subscriber. On
  failure, returns `{ ok: false, errors }` and writes nothing.
- **`reset()`** — restores every key to its schema default and fires
  `onChange`.
- **`onChange(fn)`** — subscribe; returns an unsubscribe function. Not
  called on subscribe. Throws inside the listener route to the
  plugin's logger and do not block other subscribers.

### Persistence

The default backend is in-memory; production wires a backend that hits
IndexedDB (and eventually `plugin_installs.settings_json` on the Pro
backend). The SDK contract does not change either way — `set()` and
`get()` are async, and persistence happens behind the
`SettingsBackend` seam.

### Permission model

`settings.declare` is the only permission for this surface. Once a
schema is declared, reads, writes, resets, and subscriptions need
no further permission — the values belong to the plugin's own
namespace and are not user-visible to other plugins.

### Settings form renderer + IndexedDB backend (SDK-006b)

`frontend/src/components/plugin-host/SettingsForm.tsx` is the editor
view that turns a declared `SettingsSchema` into a live form. The
"Installed Plugins" modal mounts it from the per-row settings dialog —
plugins never import or render it themselves; they only declare the
schema and the host owns the UI.

Three things make this component non-trivial:

1. **Live re-render on `declare`.** The form subscribes to
   `getSettingsRegistry().subscribe(...)` via `useSyncExternalStore`,
   so a plugin re-declaring (or disposing) its schema redraws the form
   immediately. The body is keyed by a `schemaFingerprint(schema)` so a
   shape change unmounts the old controls and mounts a fresh tree —
   stale per-field state can't survive a schema migration.
2. **Two-layer validation.** Every keystroke runs
   `applyAndValidate(schema, values, current)` from `@velxio/sdk` to
   surface inline schema errors (Save stays disabled while any leaf is
   invalid). On Save, the form additionally awaits the plugin's own
   async `validate(values)` if it was supplied at `declare()` time, so
   cross-field rules the schema can't express still run before the
   write — identical to what `createPluginSettings.set()` would do
   internally. Backend errors take precedence over live errors so the
   user always sees the most recent rejection.
3. **Round-trippable JSON.** Per-plugin Export downloads
   `${pluginId}-settings.json` shaped as `{ pluginId, values }`;
   Import accepts either that shape or a bare values object and routes
   through the same `applyAndValidate` so a malformed import surfaces
   inline rather than corrupting the persisted state.

Type dispatch: `string` → `<input>` / `<select enum>` / `<textarea
multiline>` / `<input type="password|email|url">`; `number`/`integer` →
`<input type="number">` with `min`/`max`/`step`; `boolean` →
checkbox; `array` of strings → tag/chip list; `object` (one nesting
level) → fieldset routing inner errors via the dotted path the schema
validator emits (`outer.inner`).

`IndexedDBSettingsBackend`
(`frontend/src/plugin-host/IndexedDBSettingsBackend.ts`) is the
production `SettingsBackend` wired in `App.tsx` at module load:

```ts
if (typeof indexedDB !== 'undefined') {
  getSettingsRegistry().setBackend(new IndexedDBSettingsBackend());
}
```

DB `velxio.plugin-settings`, store `settings`, key = `pluginId`,
value = `{ values, updatedAt }`. SSR/test contexts that lack
`indexedDB` keep the in-memory default. The SDK contract does not
change — `set()` and `get()` were already async, so swapping backends
is invisible to plugins.

What ships in SDK-006b vs what's deferred:

- **Shipped** — form renderer with all six leaf control types,
  inline validation, async-validate path, Save / Reset-with-confirm,
  Export, Import, IndexedDB persistence, App-level wire-up.
- **Deferred** to a follow-up:
  - "Export all plugin settings" panel-level button (operates over
    every persisted plugin id).
  - Wire to `plugin_installs.settings_json` on the Pro backend (lives
    with PRO-003 marketplace install endpoints).

Tests: `frontend/src/__tests__/SettingsForm.test.tsx` (14 tests, jsdom)
covers the empty state, every leaf control type, inline schema
validation, Save flow with cached-value update, Reset, and the
backend round-trip.

## Slot UI infrastructure (CORE-002b)

When a plugin calls `ctx.commands.register()`, `ctx.toolbar.register()`,
`ctx.panels.register()`, etc. the contribution lives in a **per-plugin**
registry first (see SDK-002). The editor needs a single source-of-truth
across every loaded plugin so React surfaces (toolbar, command palette,
panel docks) can render the union without re-subscribing per plugin.

### `HostSlotRegistry` — the aggregator

`frontend/src/plugin-host/HostSlotRegistry.ts` is a singleton that owns:

- A two-level map `slots: Map<SlotId, Map<pluginId, Map<itemId, SlotEntry>>>`.
- A snapshot cache per slot — `getEntries(slotId)` returns the **same frozen
  array reference** until a mutation in that slot invalidates it. React's
  `useSyncExternalStore` uses identity comparison to skip re-renders, so
  this guarantee is load-bearing.
- A subscriber set per slot — `subscribe(slotId, fn)` only notifies on
  mutations that touch that slot. Toolbar items registering does not wake
  the command palette.

The aggregator exposes one mutation entry point: `mountPlugin(pluginId,
ui)`. `createPluginContext()` calls it once per plugin after wiring all
seven UI registries. The bridge subscribes to each per-plugin registry
and **reconciles by diff** on every notify (add/update/remove) so the
slot snapshot always matches the plugin's current state.

The bridge's `dispose()` is **not** tracked in the plugin's
`ctx.subscriptions` store — it's host infrastructure. The dispose wrapper
in `createPluginContext` calls `slotBridge.dispose()` first, then
`subscriptions.dispose()`, so the slot snapshots clear before any
plugin-tracked teardown runs.

### `<SlotOutlet />` — the React surface

`frontend/src/components/plugin-host/SlotOutlet.tsx` is the React side:

```tsx
<SlotOutlet slot="editor.toolbar.left">
  {(entry) => <ToolbarButton item={entry.item} pluginId={entry.pluginId} />}
</SlotOutlet>
```

- `slot` is a stable id from `SlotIds.ts`. Renaming a slot is a breaking
  change — the slot id is the only contract between host UI and plugin
  contributions.
- `children` is a renderer for **one** entry. The outlet does not decide
  what the item looks like — toolbars render `<button>`s, panels render
  whatever fits the dock, etc. The render function MUST be stable
  (declared at module scope or wrapped in `useCallback`) — the outlet
  is `React.memo`'d and a fresh closure on every render defeats the memo.
- `fallback` is rendered when the slot is empty (default `null`).

The outlet does NOT execute commands. A toolbar button referencing a
`commandId` needs the surface layer to resolve the owning plugin's
command registry and call `commands.execute(id)`. The outlet only
enumerates.

### Slot routing — how items reach the right slot

`SlotIds.ts` declares the `SlotId` union and a `SLOT_ROUTING` table that
maps each slot to its source registry plus an optional `accepts`
predicate. For example:

```ts
'editor.toolbar.left':  { source: 'toolbar', accepts: (i) => i.position === 'left' },
'editor.toolbar.right': { source: 'toolbar', accepts: (i) => i.position === 'right' },
```

Toolbar items declare `position: 'left' | 'right'`; the aggregator routes
each item to exactly one slot. To add a new slot, add the id to
`ALL_SLOT_IDS` and a row to `SLOT_ROUTING` — the test suite enforces that
every slot has a routing row and every routing row points at a known
registry.

## La regla de oro — lookup at setup, not on the hot path

Every registry (`registry.lookup()`, `partSimulations.list()`,
`spice.lookup()`, slot snapshots) runs an `O(1)` `Map` lookup. That is
fast — but a frame tick at 60 fps gives you ≤16.6 ms total budget for the
AVR step, the scheduler tick, every part-sim's `onPinStateChange`, and
the React paint. Touching the registry inside a hot path adds work that
**scales with the number of installed plugins**, which is exactly the
work that the SDK is trying to make zero-cost.

**Rule:** resolve the reference once at setup (component construction,
netlist build, plugin activate) and keep the captured reference. The
frame loop calls the captured reference directly.

```ts
// ✅ Good — lookup runs once at setup, frame loop calls the ref directly.
function attachLed(componentId: string) {
  const sim = partSimulations.lookup('led');
  if (!sim) return;
  sim.onPinStateChange?.(componentId, 'A', 1);
  return sim;
}

// ❌ Bad — every frame pays a Map lookup that scales with plugin count.
function tickLed(componentId: string) {
  partSimulations.lookup('led')?.onPinStateChange?.(componentId, 'A', 1);
}
```

The same rule applies to `ctx.events.on(...)`: subscribe at activate,
keep the disposable in `ctx.subscriptions`, and let the EventBus's
zero-listener fast-path optimize out emits when nobody is listening.
Don't subscribe-then-unsubscribe inside a tick.

## What's NOT in SDK-003

The SDK-003 contract intentionally defers a few higher-level conveniences:

- ~~**Single-call definition shape.**~~ Shipped in **SDK-003b step 1** —
  see "Compact authoring — `defineCompoundComponent` + `registerCompound`"
  above.
- **High-level `PartSimulationAPI`** with `pin().state/onChange/set`, plus
  built-in `serial`/`i2c` helpers — remaining SDK-003b work. Today you use
  `attachEvents(element, SimulatorHandle)` directly. (The building blocks
  landed across CORE-002c-step1 and step3: `onPinChange`, `onPwmChange`,
  `onSpiTransmit`, `schedulePinChange`, `registerI2cSlave`, `cyclesNow`,
  `clockHz` — see "Subscribing to pin transitions" and the five sections
  that follow it above.)
- ~~**Richer `NetlistMapContext`** with `internalNode(suffix)` for reserving
  unique internal nets.~~ Shipped in **SDK-003b step 3** — see
  "Internal nets — `ctx.internalNode(suffix)`" below. Today every SPICE
  mapper receives `ctx.internalNode(suffix)` directly on
  `SpiceMapperContext`; no need to mint your own (`comp.id + '_n_internal'`)
  — collisions across instances would short their internal state together.

These are pure additions on top of the current contract and do not break
anything in SDK-003.

## SDK-002b — host integration follow-ups

SDK-002 shipped the `PluginContext` surface and the in-memory host
implementation. SDK-002b closes the four gaps that made it unsafe to flip
the runtime on for paid plugins. Each one is independently shippable; the
order below matches the order in the source task.

### 1. Streaming response cap in `ScopedFetch` (Part A)

Before SDK-002b, `ScopedFetch` only validated the `Content-Length` header
upfront. A server that omitted the header (or sent a chunked transfer
encoding) could push arbitrary bytes through the plugin's `fetch()` until
something else OOM'd the tab. The fix is two-layer:

1. **Header check** — same as before, throws synchronously if the declared
   length exceeds `SCOPED_FETCH_MAX_BYTES` (4 MB default).
2. **Mid-stream check** — `response.body` is wrapped in a counting
   `ReadableStream` that aborts with `HttpResponseTooLargeError(url,
   observed, max)` the moment a chunk pushes the running total over the
   cap. The cap is enforced even when the server lies about the length or
   omits the header entirely.

`HttpResponseTooLargeError` is a new SDK-level error (exported from the
barrel) so callers can catch it without importing host internals.

### 2. IndexedDB plugin storage backend (Part B)

The default `MapStorageBackend` is in-memory only — every refresh wipes
`ctx.userStorage` / `ctx.workspaceStorage`. SDK-002b adds an
IndexedDB-backed `StorageBackend` that gives plugins cross-session
persistence **without changing the SDK contract**. The seam is the same
`StorageBackend` interface SDK-002 already shipped; the host just
constructs a different implementation.

**Implementation:** `frontend/src/plugin-host/IndexedDBPluginStorageBackend.ts`

- One DB (`velxio.plugin-storage`), one object store (`entries`), keys
  prefixed `${pluginId}:${bucket}:${key}`. One store with prefixed keys
  instead of one store per plugin because IDB requires every store to be
  declared in `onupgradeneeded` — dynamic per-plugin stores would force a
  version bump on every install.
- **Async construction, sync reads.** `IndexedDBPluginStorageBackend.create()`
  scans the bucket prefix into an in-memory `Map` mirror via a cursor +
  `IDBKeyRange.bound(prefix, prefix + '￿')` (the BMP highest code point as
  upper bound). After construction, `get`/`keys` are O(1) Map lookups so
  the sync `StorageBackend` interface holds. Memory cost ≤ the bucket
  quota (1 MB).
- **Write-through queue.** `set`/`delete` mutate the mirror synchronously
  and enqueue the IDB put on a single-track promise chain. The new
  optional `flushed?(): Promise<void>` hook on `StorageBackend` lets
  `InMemoryPluginStorage.set/delete` await persistence so the caller's
  `await ctx.userStorage.set(k, v)` doesn't return before the bytes are
  durable. A tab close mid-flight loses *at most* the most recent op.
- **Errors during persistence** are reported via the injected `onError`
  callback (default `console.error`). The host wires this to
  `PluginLogger.error` so failures are tagged with the plugin id; the
  mirror keeps the new value so the next write retries.

**Wiring:** `PluginManager.configure({ storageBackendFactory })` accepts
an optional `(pluginId, bucket) => Promise<StorageBackend>` factory.
`load()` awaits it for both buckets in parallel **before** constructing
the worker, then injects per-plugin backends into the services overlay
that `createPluginContext` consumes (`services.userStorageBackend`,
`services.workspaceStorageBackend`). On factory throw, the entry is
marked `failed` and the worker is never constructed — the failure
surfaces in the Installed Plugins panel like any other load-time error.

If the factory is omitted, plugins fall back to `MapStorageBackend`
(the SDK-002 baseline) — backwards-compatible.

### 3. TypeDoc API reference (Part C)

`packages/sdk/typedoc.json` configures TypeDoc 0.28 with four entry
points: `src/index.ts`, `src/manifest.ts`, `src/events.ts`, and
`src/permissions-catalog.ts` (matching the four `exports` subpaths).
`npm run docs:api` from `packages/sdk/` emits static HTML to
`docs-api/` (gitignored). `excludeInternal` + `excludePrivate`
keep the surface limited to what plugin authors actually call;
`validation.invalidLink: true` fails the build if a docstring
references a missing symbol.

`.github/workflows/sdk-docs.yml` runs typecheck + `docs:api` on every
push/PR that touches `packages/sdk/**` and uploads the HTML as a workflow
artifact (`sdk-api-docs`, 14-day retention). The publish step to
GitHub Pages is **deliberately deferred** — enabling Pages requires a
repo-settings change (Pages source + custom domain config) tracked in
`task_plan/human_review/SDK-002b-followup-pages-deploy.md`. Once that
lands, the workflow gains a deploy step.

### What did NOT land in SDK-002b

- **Slot UI rendering.** Already shipped in CORE-002b
  (`SlotIds.ts` + `HostSlotRegistry` + `<SlotOutlet />` + `mountPlugin`)
  before SDK-002b started. The 7 `MapBackedRegistry<T>` registries from
  SDK-002 are now consumed by real React surfaces.
- **App.tsx wiring of the IndexedDB factory.** The backend is exposed as
  a building block; the production `PluginManager.configure({...,
  storageBackendFactory: createPluginStorageBackends })` call lands with
  the loader integration story (CORE-007 already shipped, but the editor
  startup still constructs `PluginManager` lazily — wiring the factory is
  a one-line edit deferred so it can land alongside the eventual
  "production loader boot" task).

## Worker-safe UI — declarative SVG overlays + delegated part events (CORE-006b-step5)

Plugins that run inside the worker sandbox (CORE-006 runtime) have no DOM
access: a `mount(element)` or `attachEvents(element, handle)` callback
cannot cross the `postMessage` boundary. Two additive surfaces give those
plugins the same expressive power without handing them a live DOM node.

### Declarative canvas overlays — `overlay.svg`

`CanvasOverlayDefinition` gained an optional `svg?: SvgNode` field. The
plugin emits a pure-data tree; the host validates it at register time and
renders real SVG on the main thread via `document.createElementNS`.

```ts
import { defineSvgOverlay } from '@velxio/sdk';

const gridOverlay = defineSvgOverlay({
  id: 'demo.grid',
  zIndex: 5,
  svg: {
    tag: 'g',
    attrs: { stroke: '#88888844', 'stroke-width': 1 },
    children: [
      { tag: 'line', attrs: { x1: 0, y1: 0, x2: 1000, y2: 0 } },
      { tag: 'line', attrs: { x1: 0, y1: 0, x2: 0, y2: 1000 } },
    ],
  },
});
// in activate(ctx):
ctx.canvasOverlays.register(gridOverlay);
```

**What the schema enforces** (`packages/sdk/src/svg.ts`):
- Tag allowlist: `g`, `rect`, `circle`, `ellipse`, `line`, `path`,
  `polygon`, `polyline`, `text`, `tspan`, `use`, `defs`, `title`, `desc`.
  `<script>`, `<foreignObject>`, `<style>`, `<image>`, `<animate*>` are
  rejected.
- Per-tag attribute allowlist plus a small set of global styling
  attributes (`fill`, `stroke*`, `transform`, `opacity`, `clip-path`,
  etc.). `data-*` attributes are always allowed.
- `on*` event-handler attributes rejected structurally regardless of tag.
- `style` attribute rejected — inline CSS would bypass the per-attr
  allowlist.
- `javascript:` / `data:text/html` URI schemes rejected in every value.
- `<use href="#id">` — fragment references only.
- Caps: `MAX_SVG_NODES = 256`, `MAX_SVG_DEPTH = 8`,
  `MAX_SVG_ATTR_LENGTH = 1024`, `MAX_SVG_TEXT_LENGTH = 1024`.

Validation runs at the SDK boundary (inside
`ctx.canvasOverlays.register`) and again inside `mountDeclarativeSvg()`
as a defence-in-depth measure — the cost is linear in node count.
Failures throw `InvalidSvgNodeError { pluginId, reason }`.

If the plugin ships **both** `mount` and `svg`, the declarative path
wins and a warning is logged through `ctx.logger`. Static only for now —
a re-render hook arrives with the panels follow-up.

### Delegated part events — `sim.events` + `sim.onEvent`

`PartSimulation` gained two optional fields:

```ts
export type PartEventKind =
  | 'click' | 'mousedown' | 'mouseup'
  | 'mouseenter' | 'mouseleave' | 'contextmenu';

export interface DelegatedPartEvent {
  readonly type: PartEventKind;
  readonly x: number; readonly y: number;  // element-local
  readonly button: number;
  readonly shiftKey: boolean; readonly altKey: boolean;
  readonly ctrlKey: boolean; readonly metaKey: boolean;
  readonly pluginId?: string;
}
```

Declaring them swaps out the DOM-bound `attachEvents` with a
`postMessage`-safe channel:

```ts
ctx.partSimulations.register('demo.pushbutton', definePartSimulation({
  events: ['mousedown', 'mouseup'],
  onEvent(ev) {
    // ev is a plain JSON object — survives structuredClone/postMessage
    if (ev.type === 'mousedown') pressed = true;
    if (ev.type === 'mouseup')   pressed = false;
  },
}));
```

The host installs one listener per kind on the part's root element and
forwards each event as a flat JSON payload. `x` / `y` are relative to
the element's bounding rect, so plugins can hit-test without CTM or DOM
reads. A throwing `onEvent` is logged via `ctx.logger.error` and
swallowed — a buggy plugin never blocks sibling parts.

`events` + `attachEvents` compose: if both are set the host installs
delegated listeners AND calls `attachEvents`. Teardown fires both on
stop. Plugins authored for the worker sandbox should leave
`attachEvents` unset; plugins authored for the main-thread loader can
ignore `events` / `onEvent`.

**Worker stub behaviour.** `ContextStub.ts` only emits the
`warnDomBound` warning when the imperative path (`mount` /
`attachEvents`) is used **without** its declarative counterpart. A
correctly-authored worker plugin sees no warning.

See also: `frontend/src/plugin-host/mountDeclarativeSvg.ts`,
`frontend/src/plugin-host/delegatePartEvents.ts`,
`packages/sdk/src/svg.ts`, and
`frontend/src/__tests__/plugin-host-event-delegation.test.ts`.

## See also

- [docs/EVENT_BUS.md](EVENT_BUS.md) — `ctx.events` payload catalog.
- [docs/COMPILE_MIDDLEWARE.md](COMPILE_MIDDLEWARE.md) — middleware contract.
- [docs/PERFORMANCE.md](PERFORMANCE.md) — the hard performance budgets every
  registered part-sim and SPICE mapper must respect.
- `frontend/src/plugin-host/SlotIds.ts` + `HostSlotRegistry.ts` +
  `frontend/src/components/plugin-host/SlotOutlet.tsx` — slot UI
  infrastructure (CORE-002b).
- `frontend/src/plugin-host/IndexedDBPluginStorageBackend.ts` — IndexedDB
  storage backend for plugins (SDK-002b).
- `packages/sdk/typedoc.json` + `.github/workflows/sdk-docs.yml` — API
  reference generation pipeline (SDK-002b).
