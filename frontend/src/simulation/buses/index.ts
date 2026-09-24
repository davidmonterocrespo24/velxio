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
export {
  BusRegistry,
  busRegistry,
  type DiagnosticListener,
  type RemoteSpiMapEntry,
  type SpiMapListener,
} from './registry';
export {
  busChipB64,
  bytesToBase64,
  loadBusChip,
  primeBusChip,
  resetBusChipsForTest,
} from './busChips';
export { RemoteSpiPort, type RemoteSpiPortOptions } from './remotePort';
export { RemoteSpiLane } from './remoteLane';
export { BoardBusFabric } from './fabric';
export { SpiBus, reverseBits, type SpiMember } from './spiBus';
export { SoftSpiDecoder } from './softSpi';
export { createStoreNetResolver, railOf } from './storeResolver';
export { boardPinsFromPinManager } from './boardPins';

// Every OSS board's pin function table registers on import (the overlay
// registers its own boards when it installs them).
import './boardPinTables';
import { setBusChipLoadListener } from './busChips';
import { busRegistry } from './registry';
import type { BusHandle, SpiDevice, SpiDeviceDescriptor } from './types';

// A model's artifact is fetched, so the map a remote board published on the
// first membership change was built before the bytes arrived. Wiring the two
// here keeps busChips.ts free of any import from the registry.
setBusChipLoadListener(() => busRegistry.spiModelsChanged());

/**
 * Put an SPI device on the bus its wiring says it is on. The handle's
 * dispose() takes it off again, by identity. Call it from a part's
 * attachEvents and return the dispose from its cleanup.
 */
export function attachSpiDevice(desc: SpiDeviceDescriptor, device: SpiDevice): BusHandle {
  return busRegistry.attachSpi(desc, device);
}
