/**
 * The bus fabric (project board-buses-2026-09).
 *
 * Parts register their bus devices here, by their own pin names; engine
 * adapters expose their controller ports through getBusBinding(). Neither
 * side ever sees the other, so nothing depends on attach order, on which
 * simulator object a part was handed, or on how an engine answers MISO.
 */

export * from './types';
export * from './pinFunctions';
export { BusRegistry, busRegistry, type DiagnosticListener } from './registry';
export { BoardBusFabric } from './fabric';
export { SpiBus, reverseBits, type SpiMember } from './spiBus';
export { SoftSpiDecoder } from './softSpi';
export { createStoreNetResolver, railOf } from './storeResolver';

import { busRegistry } from './registry';
import type { BusHandle, SpiDevice, SpiDeviceDescriptor } from './types';

/**
 * Put an SPI device on the bus its wiring says it is on. The handle's
 * dispose() takes it off again, by identity. Call it from a part's
 * attachEvents and return the dispose from its cleanup.
 */
export function attachSpiDevice(desc: SpiDeviceDescriptor, device: SpiDevice): BusHandle {
  return busRegistry.attachSpi(desc, device);
}
