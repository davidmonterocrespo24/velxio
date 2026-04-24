export * from './PartSimulationRegistry';
export * from './ActiveParts';

// Seed every built-in part into the shared `PartSimulationRegistry`.
// Before CORE-002c-step2 each file below registered at module-load time via
// a side-effect import. That pattern is replaced by a single idempotent
// `registerCoreParts()` call — every parts file now exports a pure
// `registerXxxParts(registry)` function and `registerCoreParts` composes
// them in the same order. Keeping the call here preserves backwards
// compatibility for existing call sites (`DynamicComponent`, `SimulatorCanvas`)
// that import from `../simulation/parts` and expect a populated registry.
import { registerCoreParts } from '../../builtin/registerCoreParts';

registerCoreParts();
