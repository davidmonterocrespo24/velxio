export { ChipInstance, type ChipInstanceOptions } from './ChipRuntime';
export { SPIDevice } from './SPIBus';
export { WasiShim } from './WasiShim';
export {
  getSimulatorBridges,
  ensureUartBridge,
  avrUartTx,
  detectSimulatorKind,
  type SimulatorKind,
} from './simulatorBridges';

/** Decode a base64-encoded WASM blob (from /api/compile-chip or stored in props). */
export function decodeWasmBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
