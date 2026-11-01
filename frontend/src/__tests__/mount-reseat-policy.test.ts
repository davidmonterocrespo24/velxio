// @vitest-environment jsdom
/**
 * The mount-time reseat (DynamicComponent) asks the mount reseat policy
 * (utils/mountReseatPolicy.ts) before it re-derives a part's breadboard seats
 * from geometry: 'reseat' (the default) re-derives them, 'skip' keeps the
 * seats the part has, 'wait' asks again on the next poll.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { DynamicComponent } from '../components/DynamicComponent';
import type { ComponentMetadata } from '../types/component-metadata';
import { installMountReseatPolicy, type MountReseat } from '../utils/mountReseatPolicy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A two-pin part laid out like wokwi-resistor. */
const TAG = 'test-mount-reseat-part';
if (!customElements.get(TAG)) {
  customElements.define(
    TAG,
    class extends HTMLElement {
      get pinInfo() {
        return [
          { name: '1', x: 0, y: 5.65, signals: [] },
          { name: '2', x: 58.8, y: 5.65, signals: [] },
        ];
      }
    },
  );
}
const META = {
  id: TAG,
  tagName: TAG,
  name: 'Mount reseat test part',
  category: 'basic',
  thumbnail: '',
  properties: [],
  defaultValues: {},
  pinCount: 2,
  tags: [],
} as unknown as ComponentMetadata;

/** A breadboard at the origin, the part far off it (geometry seats it nowhere), and the seats a project saved for it. */
function load(): void {
  const s = useSimulatorStore.getState();
  s.setComponents([
    { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
    { id: 'part1', metadataId: TAG, x: 900, y: 900, properties: {} },
  ] as never);
  s.setWires(
    ['5t.a', '11t.a'].map((hole, i) => ({
      id: `bbwire-part1-${i}`,
      start: { componentId: 'part1', pinName: String(i + 1), x: 0, y: 0 },
      end: { componentId: 'bb1', pinName: hole, x: 0, y: 0 },
      waypoints: [],
      color: '#000000',
      bb: true,
    })) as never,
  );
}

const seats = () =>
  useSimulatorStore
    .getState()
    .wires.filter((w) => w.bb)
    .map((w) => `${w.start.pinName}>${w.end.pinName}`)
    .sort();

describe('the mount-time reseat asks the mount reseat policy', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    load();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    installMountReseatPolicy(null);
    useSimulatorStore.getState().setWires([]);
    useSimulatorStore.getState().setComponents([]);
  });

  /** Mount the part and let `ms` of the mount poll (every 100 ms) go by. */
  async function mount(ms = 350): Promise<void> {
    await act(async () => {
      root.render(createElement(DynamicComponent, { id: 'part1', metadata: META, properties: {}, x: 900, y: 900 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }

  it('re-derives the seats from geometry by default', async () => {
    await mount();
    expect(seats()).toEqual([]);
  });

  it('keeps the seats the part has when the policy skips', async () => {
    const asked: Array<[string, string[]]> = [];
    installMountReseatPolicy((id, pins) => {
      asked.push([id, [...pins]]);
      return 'skip';
    });
    await mount();
    expect(seats()).toEqual(['1>5t.a', '2>11t.a']);
    // Asked once, with the element's pins: a skip counts the part as seated.
    expect(asked).toEqual([['part1', ['1', '2']]]);
  });

  it('asks again on the next poll while the policy waits, then does what it says', async () => {
    let answer: MountReseat = 'wait';
    let asks = 0;
    installMountReseatPolicy(() => {
      asks++;
      return answer;
    });
    await mount();
    expect(seats()).toEqual(['1>5t.a', '2>11t.a']);
    expect(asks).toBeGreaterThan(1);
    answer = 'reseat';
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(seats()).toEqual([]);
  });
});
