/**
 * registerCoreParts.ts — single entry point that seeds the shared
 * `PartSimulationRegistry` with every built-in part.
 *
 * Why this file exists (CORE-002c-step2):
 *   Before this refactor each parts file (`BasicParts.ts`, `ComplexParts.ts`,
 *   …) ran `PartSimulationRegistry.register(...)` at the top level as a
 *   module side-effect. That made it impossible to import any single parts
 *   file in isolation (tests, plugin tooling) without dragging the full
 *   catalog in, and it blurred the line between host-provided built-ins and
 *   plugin contributions — both hit the same side-effect path.
 *
 *   Now every parts module exports a pure `registerXxxParts(registry)`
 *   function. This file composes them in a stable order that matches the
 *   pre-refactor load order, and also seeds the single non-file entry
 *   (`raspberry-pi-3`) that previously lived inline in `PartSimulationRegistry.ts`.
 *
 *   Plugin registrations go through the exact same `PartRegistry` surface
 *   via `ctx.partSimulations.register()` / `registerSdkPart()` — built-ins
 *   are no longer special.
 *
 * Idempotent: calling `registerCoreParts()` more than once is a no-op. The
 * guard is module-local and process-local; hot-reload in the Vite dev server
 * re-executes the module, which resets the flag — intentional because the
 * underlying `PartRegistry.register` is last-writer-wins, so a re-seed just
 * replaces the entries.
 */

import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { registerBasicParts } from '../simulation/parts/BasicParts';
import { registerComplexParts } from '../simulation/parts/ComplexParts';
import { registerChipParts } from '../simulation/parts/ChipParts';
import { registerSensorParts } from '../simulation/parts/SensorParts';
import { registerLogicGateParts } from '../simulation/parts/LogicGateParts';
import { registerProtocolParts } from '../simulation/parts/ProtocolParts';
import { useSimulatorStore } from '../store/useSimulatorStore';

let seeded = false;

/**
 * Seed every built-in part into `PartSimulationRegistry`. Called from
 * `frontend/src/simulation/parts/index.ts` so that any call site that
 * imports from `../simulation/parts` still sees a fully-populated registry
 * — backwards-compatible with the pre-refactor side-effect pattern.
 */
export function registerCoreParts(): void {
  if (seeded) return;
  seeded = true;

  registerBasicParts(PartSimulationRegistry);
  registerComplexParts(PartSimulationRegistry);
  registerChipParts(PartSimulationRegistry);
  registerSensorParts(PartSimulationRegistry);
  registerLogicGateParts(PartSimulationRegistry);
  registerProtocolParts(PartSimulationRegistry);

  // `raspberry-pi-3` is a host-only bridge — it forwards MCU pin events into
  // the Zustand store so the QEMU backend (running in a separate process)
  // can observe them. Kept inline here rather than in a parts file because
  // there is no simulation logic beyond the Zustand dispatch.
  PartSimulationRegistry.register('raspberry-pi-3', {
    onPinStateChange: (pinName, state) => {
      useSimulatorStore.getState().sendRemotePinEvent(pinName, state ? 1 : 0);
    },
  });
}

/**
 * Test-only helper. Drops the module-local `seeded` flag so a test suite
 * can exercise the seeding path more than once per Vitest worker (e.g. to
 * assert idempotence, or to re-seed after `PartSimulationRegistry.__clearForTests()`).
 */
export function __resetCorePartsSeedForTests(): void {
  seeded = false;
}
