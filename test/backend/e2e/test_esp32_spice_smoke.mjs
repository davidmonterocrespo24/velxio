/**
 * Smoke test: verify that eecircuit-engine (ngspice-WASM) runs standalone in
 * the E2E test environment. Does NOT require the backend.
 *
 * Run: node test/backend/e2e/test_esp32_spice_smoke.mjs
 */
import { Simulation } from 'eecircuit-engine';

const sim = new Simulation();
await sim.start();

sim.setNetList(`Smoke test
V1 vcc 0 DC 3.3
R1 vcc mid 10k
R2 mid 0 10k
.op
.end`);

const result = await sim.runSim();
const names = result.variableNames.map(n => n.toLowerCase());
const idx = names.indexOf('v(mid)');
const v = result.data[idx].values[0];

console.log(`v(mid) = ${v.toFixed(4)} V (expected 1.6500)`);
const ok = Math.abs(v - 1.65) < 0.01;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
