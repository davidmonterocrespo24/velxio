/**
 * Infrared gallery examples — the link the simulator did not have.
 *
 * Both parts on this canvas were dead before `simulation/ir/irAir`: the remote
 * dispatched a DOM event nothing listened for, and the receiver asked for a
 * pin its element does not have. So there was nothing to put in a gallery, and
 * a user who dragged the two parts out and wired them found that neither did
 * anything at all.
 *
 * What these show, and what makes them worth loading:
 *
 *  - THERE IS NO WIRE between the remote and the receiver, and there is not
 *    meant to be. A remote points across a room. Put the two parts anywhere on
 *    the canvas, at any angle, and the link works — the medium is a bus, not a
 *    geometry.
 *  - THE TIMING IS REAL. The envelope on the receiver's DAT pin is a genuine
 *    NEC waveform placed on the board's own cycle counter, so IRremote decodes
 *    it exactly as it decodes a physical remote. That is the whole reason the
 *    receiver is a line-owning model rather than a part poking a pin from a
 *    timer.
 *  - TWO RECEIVERS BOTH HEAR ONE REMOTE, which is what infrared does and what
 *    no wire could express.
 *
 * The Uno runs on avr8js in the browser; the ESP32 example runs on the
 * in-browser engine or the QEMU worker (`backend/app/services/esp32_ir.py`)
 * with no change to the sketch.
 */
import type { ExampleProject } from './examples';

const UNO_CODE = `// IR remote -> IR receiver, with no wire between them.
//
// Click a button on the remote (or click the receiver itself, which sends its
// own configured code). Open the Serial Monitor at 9600 baud to see what
// arrived. The receiver's DAT pin carries a real NEC envelope on the board's
// own clock, so IRremote decodes it exactly as it would a physical remote.
//
// Wiring: DAT -> 2   VCC -> 5V   GND -> GND
#include <IRremote.hpp>

const int RECV_PIN = 2;

void setup() {
  Serial.begin(9600);
  IrReceiver.begin(RECV_PIN, ENABLE_LED_FEEDBACK);
  Serial.println(F("Point the remote at the receiver and press a button."));
}

void loop() {
  if (IrReceiver.decode()) {
    if (IrReceiver.decodedIRData.protocol == NEC) {
      Serial.print(F("address 0x"));
      Serial.print(IrReceiver.decodedIRData.address, HEX);
      Serial.print(F("  command 0x"));
      Serial.println(IrReceiver.decodedIRData.command, HEX);
    } else if (IrReceiver.decodedIRData.protocol == NEC && IrReceiver.decodedIRData.flags) {
      Serial.println(F("(repeat)"));
    } else {
      Serial.println(F("unknown protocol"));
    }
    IrReceiver.resume();
  }
}
`;

const UNO_TWO_CODE = `// One remote, two receivers — which is what infrared does and what no wire
// could express. Both are on their own pin; both hear every button press.
//
// Wiring: receiver A DAT -> 2, receiver B DAT -> 3, both VCC -> 5V, GND -> GND
#include <IRremote.hpp>

// IRremote drives one receiver at a time, so this reads the two pins directly
// and measures the envelope itself. That is also the honest demonstration:
// the pin really is carrying NEC timing, not a value handed over out of band.
const int PIN_A = 2;
const int PIN_B = 3;

// Wait for the line to reach \`level\`, up to \`timeout\` us. Returns the time
// spent waiting, or 0 on timeout.
unsigned long waitFor(int pin, int level, unsigned long timeout) {
  unsigned long start = micros();
  while (digitalRead(pin) != level) {
    if (micros() - start > timeout) return 0;
  }
  return micros() - start;
}

// One NEC frame off \`pin\`, or -1. Active low: a mark pulls the line down.
long readNec(int pin) {
  if (digitalRead(pin) != LOW) return -1;
  unsigned long header = waitFor(pin, HIGH, 12000);      // the 9 ms mark
  if (header < 7000) return -1;
  if (waitFor(pin, LOW, 6000) < 3500) return -1;         // the 4.5 ms space

  unsigned long bits = 0;
  for (int i = 0; i < 32; i++) {
    if (waitFor(pin, HIGH, 2000) == 0) return -1;        // the 560 us mark
    unsigned long space = waitFor(pin, LOW, 3000);       // its length is the bit
    if (space == 0) return -1;
    if (space > 1000) bits |= (1UL << i);                // least significant first
  }
  return (long)bits;
}

void report(const char *name, long frame) {
  uint8_t address = frame & 0xFF;
  uint8_t command = (frame >> 16) & 0xFF;
  Serial.print(name);
  Serial.print(F(": address 0x"));
  Serial.print(address, HEX);
  Serial.print(F("  command 0x"));
  Serial.println(command, HEX);
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_A, INPUT);
  pinMode(PIN_B, INPUT);
  Serial.println(F("Press a button. Both receivers hear it."));
}

void loop() {
  long a = readNec(PIN_A);
  if (a >= 0) report("A", a);
  long b = readNec(PIN_B);
  if (b >= 0) report("B", b);
}
`;

const ESP32_CODE = `// IR remote -> IR receiver on an ESP32. Same sketch shape as the Uno one:
// the link is the air, not a wire, and the envelope is real NEC timing on the
// guest's own clock — in the browser engine and under QEMU alike.
//
// Wiring: DAT -> GPIO 15   VCC -> 3V3   GND -> GND
#include <IRremote.hpp>

const int RECV_PIN = 15;

void setup() {
  Serial.begin(115200);
  IrReceiver.begin(RECV_PIN, ENABLE_LED_FEEDBACK);
  Serial.println("Point the remote at the receiver and press a button.");
}

void loop() {
  if (IrReceiver.decode()) {
    Serial.printf("address 0x%02X  command 0x%02X\\n",
                  IrReceiver.decodedIRData.address,
                  IrReceiver.decodedIRData.command);
    IrReceiver.resume();
  }
}
`;

const IR_TAGS = ['ir', 'infrared', 'remote', 'nec', 'irremote', 'receiver', 'vs1838b'];

export const infraredExamples: ExampleProject[] = [
  {
    id: 'ir-remote-uno',
    title: 'IR Remote (Arduino Uno)',
    description:
      'Press a button on the IR remote and the Uno decodes it with IRremote. ' +
      'There is no wire between the remote and the receiver, and there is not ' +
      'meant to be one — a remote points across a room, so the two parts are ' +
      'linked wherever you put them on the canvas. Open the Serial Monitor at ' +
      '9600 baud.',
    libraries: ['IRremote'],
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'arduino-uno',
    boardFilter: 'arduino-uno',
    tags: IR_TAGS,
    code: UNO_CODE,
    components: [
      { type: 'ir-receiver', id: 'ir1', x: 440, y: 140, properties: { irAddress: '0x00', irCommand: '0x45', channel: '' } },
      { type: 'ir-remote', id: 'remote1', x: 640, y: 60, properties: { irAddress: '0x00', channel: '' } },
    ],
    wires: [
      { id: 'w-dat', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'ir1', pinName: 'DAT' }, color: '#ffaa00' },
      { id: 'w-vcc', start: { componentId: 'arduino-uno', pinName: '5V' }, end: { componentId: 'ir1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'w-gnd', start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'ir1', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'ir-two-receivers-uno',
    title: 'IR: one remote, two receivers',
    description:
      'One press, both receivers. This is the thing a wire cannot express: ' +
      'infrared is a room, not a connection, so every receiver hears every ' +
      'remote. The sketch times the envelope on each pin itself, which is also ' +
      'the proof that the pin really is carrying NEC timing. Serial Monitor at ' +
      '9600 baud.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'arduino-uno',
    boardFilter: 'arduino-uno',
    tags: [...IR_TAGS, 'two receivers'],
    code: UNO_TWO_CODE,
    components: [
      { type: 'ir-receiver', id: 'irA', x: 440, y: 100, properties: { irAddress: '0x00', irCommand: '0x45', channel: '' } },
      { type: 'ir-receiver', id: 'irB', x: 440, y: 260, properties: { irAddress: '0x00', irCommand: '0x45', channel: '' } },
      { type: 'ir-remote', id: 'remote1', x: 660, y: 60, properties: { irAddress: '0x00', channel: '' } },
    ],
    wires: [
      { id: 'wa-dat', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'irA', pinName: 'DAT' }, color: '#ffaa00' },
      { id: 'wa-vcc', start: { componentId: 'arduino-uno', pinName: '5V' }, end: { componentId: 'irA', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'wa-gnd', start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'irA', pinName: 'GND' }, color: '#000000' },
      { id: 'wb-dat', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'irB', pinName: 'DAT' }, color: '#ffcc44' },
      { id: 'wb-vcc', start: { componentId: 'arduino-uno', pinName: '5V' }, end: { componentId: 'irB', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'wb-gnd', start: { componentId: 'arduino-uno', pinName: 'GND.2' }, end: { componentId: 'irB', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'ir-remote-esp32',
    title: 'IR Remote (ESP32)',
    description:
      'The same link on an ESP32: press a button on the remote and the sketch ' +
      'decodes it with IRremote. Works on the in-browser engine and under QEMU ' +
      'with no change — the envelope is placed on the guest clock either way. ' +
      'Serial Monitor at 115200 baud.',
    libraries: ['IRremote'],
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    tags: [...IR_TAGS, 'esp32'],
    code: ESP32_CODE,
    components: [
      { type: 'ir-receiver', id: 'ir1', x: 460, y: 150, properties: { irAddress: '0x00', irCommand: '0x45', channel: '' } },
      { type: 'ir-remote', id: 'remote1', x: 660, y: 60, properties: { irAddress: '0x00', channel: '' } },
    ],
    wires: [
      { id: 'w-dat', start: { componentId: 'esp32', pinName: '15' }, end: { componentId: 'ir1', pinName: 'DAT' }, color: '#ffaa00' },
      { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'ir1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND.1' }, end: { componentId: 'ir1', pinName: 'GND' }, color: '#000000' },
    ],
  },
];
