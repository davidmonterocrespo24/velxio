/**
 * AVR hot-path benchmarks for the Velxio simulator.
 *
 * Drives the avr8js CPU directly, NOT through AVRSimulator. The wrapper
 * depends on requestAnimationFrame and DOM-bound listeners that only exist
 * in a real browser. Stripping it isolates the actual hot path
 * (`avrInstruction(cpu); cpu.tick();`) so regressions land on the code
 * we care about: the integration of plugins/SDK with the simulator.
 *
 * Each bench runs CYCLES_PER_ITERATION cycles per op. Wall-clock translates
 * to MHz via:
 *   MHz = (cycles_per_iteration × ops_per_second) / 1e6
 *
 * Registered with tinybench by the runner in bench/run.ts.
 */

import type { Bench } from 'tinybench';
import {
  CPU,
  avrInstruction,
  AVRIOPort,
  portBConfig,
  portCConfig,
  portDConfig,
} from 'avr8js';
import { hexToUint8Array } from '../src/utils/hexParser';
import { BLINK_HEX, TOGGLE_HEX, buildNopLoopHex } from './fixtures/hex';

const CYCLES_PER_ITERATION = 100_000;

function makeCpu(hex: string): CPU {
  const bytes = hexToUint8Array(hex);
  const program = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < program.length; i++) {
    program[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  }
  return new CPU(program);
}

function runCycles(cpu: CPU, count: number): void {
  for (let i = 0; i < count; i++) {
    avrInstruction(cpu);
    cpu.tick();
  }
}

export function registerAvrBenches(bench: Bench): void {
  bench.add('BENCH-AVR-01 blink loop, no port listeners', () => {
    const cpu = makeCpu(BLINK_HEX);
    runCycles(cpu, CYCLES_PER_ITERATION);
  });

  bench.add('BENCH-AVR-02 toggle PORTB, no listeners', () => {
    const cpu = makeCpu(TOGGLE_HEX);
    runCycles(cpu, CYCLES_PER_ITERATION);
  });

  bench.add('BENCH-AVR-03 NOP loop, dispatch baseline', () => {
    const cpu = makeCpu(buildNopLoopHex(31));
    runCycles(cpu, CYCLES_PER_ITERATION);
  });

  bench.add('BENCH-AVR-04 toggle PORTB with 1 listener', () => {
    const cpu = makeCpu(TOGGLE_HEX);
    const portB = new AVRIOPort(cpu, portBConfig);
    let observed = 0;
    portB.addListener(() => {
      observed++;
    });
    runCycles(cpu, CYCLES_PER_ITERATION);
    if (observed < 0) throw new Error('unreachable');
  });

  bench.add('BENCH-AVR-05 toggle PORTB with all 3 ports + listeners', () => {
    const cpu = makeCpu(TOGGLE_HEX);
    const noop = () => {};
    new AVRIOPort(cpu, portBConfig).addListener(noop);
    new AVRIOPort(cpu, portCConfig).addListener(noop);
    new AVRIOPort(cpu, portDConfig).addListener(noop);
    runCycles(cpu, CYCLES_PER_ITERATION);
  });
}

export const AVR_BENCH_METADATA = {
  cyclesPerIteration: CYCLES_PER_ITERATION,
  // Convert ops/s → MHz given CYCLES_PER_ITERATION cycles per op.
  hzToMhz(hz: number): number {
    return (hz * CYCLES_PER_ITERATION) / 1e6;
  },
};
