/**
 * Intel HEX Format Parser
 * Converts Intel HEX format to Uint8Array for AVR8 program memory
 *
 * Intel HEX format:
 * :LLAAAATT[DD...]CC
 *
 * LL = byte count
 * AAAA = address
 * TT = record type (00=data, 01=EOF)
 * DD = data bytes
 * CC = checksum
 */

export function hexToUint8Array(hexContent: string): Uint8Array {
  const lines = hexContent.split('\n').filter((line) => line.trim().startsWith(':'));

  // Determine max address to size the array
  let maxAddress = 0;
  const dataRecords: Array<{ address: number; data: number[] }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(':')) continue;

    // Remove ':' and parse
    const bytes = trimmed.substring(1);

    // Parse record
    const byteCount = parseInt(bytes.substring(0, 2), 16);
    const address = parseInt(bytes.substring(2, 6), 16);
    const recordType = parseInt(bytes.substring(6, 8), 16);

    // Type 00 = data record
    if (recordType === 0x00) {
      const data: number[] = [];
      for (let i = 0; i < byteCount; i++) {
        const dataByte = parseInt(bytes.substring(8 + i * 2, 10 + i * 2), 16);
        data.push(dataByte);
      }

      dataRecords.push({ address, data });
      maxAddress = Math.max(maxAddress, address + byteCount);
    }
    // Type 01 = end of file
    else if (recordType === 0x01) {
      break;
    }
  }

  // Create array with enough space
  const result = new Uint8Array(maxAddress);

  // Fill with data
  for (const record of dataRecords) {
    for (let i = 0; i < record.data.length; i++) {
      result[record.address + i] = record.data[i];
    }
  }

  return result;
}

/**
 * Verify Intel HEX checksum
 */
export function verifyHexChecksum(line: string): boolean {
  if (!line.startsWith(':')) return false;

  const bytes = line.substring(1);
  let sum = 0;

  // Sum all bytes except checksum
  for (let i = 0; i < bytes.length - 2; i += 2) {
    sum += parseInt(bytes.substring(i, i + 2), 16);
  }

  // Get checksum
  const checksum = parseInt(bytes.substring(bytes.length - 2), 16);

  // Checksum = two's complement of sum
  return ((sum + checksum) & 0xff) === 0;
}
