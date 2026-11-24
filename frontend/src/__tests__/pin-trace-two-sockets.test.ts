// @vitest-environment jsdom
/**
 * A board plugged into one socket is not plugged into the next one. A seated
 * board joins the socket's pads by name (PinTrace traceThroughSocket), and the
 * question was whether the board sits on ANY socket of the canvas: a XIAO on a
 * Round Display also drove every pad of a reSpeaker Lite that was only wired to
 * it, so the reSpeaker's data pin read as the display's backlight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceDetailed } from '../simulation/PinTrace';

const PADS = [
  { name: 'D0', x: 0, y: 0 },
  { name: 'D6', x: 0, y: 72 },
];

function mount(id: string, socket: boolean): void {
  const el = document.createElement('div') as HTMLElement & Record<string, unknown>;
  el.id = id;
  el.pinInfo = PADS;
  if (socket) el.boardSocket = { anchorPin: 'D0', accepts: ['xiao-'] };
  document.body.append(el);
}

const board = { id: 'xiao', boardKind: 'xiao-esp32-s3', x: 106, y: 106 };
const components = [
  { id: 'display', metadataId: 'socket-a', x: 100, y: 100, properties: {} },
  { id: 'audio', metadataId: 'socket-b', x: 600, y: 100, properties: {} },
];
const wire = {
  id: 'w',
  start: { componentId: 'xiao', pinName: 'MTDO', x: 0, y: 0 },
  end: { componentId: 'audio', pinName: 'D6', x: 0, y: 0 },
  waypoints: [],
  color: '#000',
};
const state = (wires: unknown[]) => ({ boards: [board], components, wires }) as never;

beforeEach(() => {
  mount('xiao', false);
  mount('display', true);
  mount('audio', true);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('two sockets, one board', () => {
  it('the socket it sits in has its pads by name', () => {
    expect(traceDetailed(state([]), 'display', 'D6')?.arduinoPin).toBe(43);
  });

  it('the other one is connected by its wires and nothing else', () => {
    expect(traceDetailed(state([]), 'audio', 'D6')?.arduinoPin ?? null).toBeNull();
    expect(traceDetailed(state([wire]), 'audio', 'D6')?.arduinoPin).toBe(40);
    expect(traceDetailed(state([wire]), 'audio', 'D0')?.arduinoPin ?? null).toBeNull();
  });
});
