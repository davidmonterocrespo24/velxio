/**
 * A three-wire SPI chip answers on the line it listens on. M5GFX probes the
 * Cardputer's ST7789 that way (bus_cfg.spi_3wire, no MISO pin, SIO reads):
 * with the panel declared on MISO-less pins it answered nothing and the
 * autodetect fell through to another board.
 */
import { describe, it, expect } from 'vitest';
import { SpiBus, type SpiMember } from '../../simulation/buses/spiBus';
import type { DiagnosticSink, SpiDeviceDescriptor } from '../../simulation/buses/types';

const sink = (() => {}) as unknown as DiagnosticSink;

function member(desc: Partial<SpiDeviceDescriptor>, legs: { mosiPin?: number; misoPin?: number }): SpiMember {
  const ref = (pin: number) => ({ kind: 'board' as const, boardId: 'b', pin });
  return {
    owner: 'panel',
    desc: { owner: 'panel', pins: { sck: ref(36), mosi: ref(35), cs: ref(37) }, ...desc } as SpiDeviceDescriptor,
    device: { transfer: () => 0x85 },
    mosiPin: legs.mosiPin,
    misoPin: legs.misoPin,
    selected: false,
    reverse: false,
    checked: false,
  };
}

describe('three-wire SPI answer', () => {
  it('a chip that answers on its MOSI leg is heard when that leg is wired', () => {
    const bus = new SpiBus('b', 36, sink);
    const m = member({ dataOut: 'mosi' }, { mosiPin: 35 });
    bus.add(m);
    bus.setSelected(m, true);
    expect(bus.frame(0x04, 8)).toBe(0x85);
  });

  it('the same chip with its MOSI leg unwired leaves the line idle', () => {
    const bus = new SpiBus('b', 36, sink);
    const m = member({ dataOut: 'mosi' }, {});
    bus.add(m);
    bus.setSelected(m, true);
    expect(bus.frame(0x04, 8)).toBe(bus.idleMiso);
  });

  it('a chip with no MISO pin and no dataOut still answers nothing', () => {
    const bus = new SpiBus('b', 36, sink);
    const m = member({}, { mosiPin: 35 });
    bus.add(m);
    bus.setSelected(m, true);
    expect(bus.frame(0x04, 8)).toBe(bus.idleMiso);
  });
});
