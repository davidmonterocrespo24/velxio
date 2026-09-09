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
// own clock, so IRremote decodes it exactly as it would a physical remote --
// measured on this build: a 9000 us header mark, a 4496 us space, 560 us bit
// marks and 1688 us one-spaces.
//
// DISABLE_LED_FEEDBACK is deliberate. With feedback on, IRremote's ISR also
// toggles pin 13 on every mark, and on this emulated Uno that extra work
// inside the 50 us interrupt makes its state machine complete frames out of
// nothing: the sketch prints a stream of undecodable results with no remote
// anywhere near it. Turning it off costs the blink and nothing else.
//
// Wiring: DAT -> 2   VCC -> 5V   GND -> GND
#include <IRremote.hpp>

const int RECV_PIN = 2;

void setup() {
  Serial.begin(9600);
  IrReceiver.begin(RECV_PIN, DISABLE_LED_FEEDBACK);
  Serial.println(F("Point the remote at the receiver and press a button."));
}

void loop() {
  if (IrReceiver.decode()) {
    if (IrReceiver.decodedIRData.protocol == UNKNOWN) {
      Serial.println(F("received something this build cannot name"));
    } else if (IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT) {
      Serial.println(F("(key held)"));
    } else {
      Serial.print(F("protocol "));
      Serial.print(getProtocolString(IrReceiver.decodedIRData.protocol));
      Serial.print(F("  address 0x"));
      Serial.print(IrReceiver.decodedIRData.address, HEX);
      Serial.print(F("  command 0x"));
      Serial.println(IrReceiver.decodedIRData.command, HEX);
    }
    IrReceiver.resume();
  }
}
`;

const UNO_TWO_CODE = `// One remote, two receivers -- which is what infrared does and what no wire
// could express. Both are on their own pin; both hear every button press.
//
// IRremote drives one receiver per sketch, so this times the envelope on each
// pin itself. That is also the honest demonstration: the pins really are
// carrying NEC timing, not a value handed over out of band.
//
// Wiring: receiver A DAT -> 2, receiver B DAT -> 3, both VCC -> 5V, GND -> GND
#include <Arduino.h>

const int PIN_A = 2;
const int PIN_B = 3;

// A demodulator's output is active low: it pulls the line down for each mark.
// So a MARK is the time spent LOW, and the bit value is in the SPACE that
// follows it -- 560 us for a zero, 1690 us for a one.
struct Rx {
  int pin;
  const char *name;
  int lastLevel;
  unsigned long lastEdgeUs;
  unsigned int spaces[34];
  byte n;
  bool inFrame;
};

Rx rxs[2];

void report(Rx &r) {
  unsigned long bits = 0;
  for (byte i = 0; i < 32; i++) {
    if (r.spaces[i + 1] > 1000) bits |= (1UL << i);   // least significant first
  }
  Serial.print(r.name);
  Serial.print(F(": address 0x"));
  Serial.print((uint8_t)(bits & 0xFF), HEX);
  Serial.print(F("  command 0x"));
  Serial.println((uint8_t)((bits >> 16) & 0xFF), HEX);
}

void poll(Rx &r) {
  int now = digitalRead(r.pin);
  if (now == r.lastLevel) return;
  unsigned long t = micros();
  unsigned int w = (unsigned int)(t - r.lastEdgeUs);
  r.lastEdgeUs = t;
  if (now == HIGH) {
    // A LOW that long was the 9 ms header mark: the frame starts here.
    if (!r.inFrame && w > 7000 && w < 11000) {
      r.inFrame = true;
      r.n = 0;
    }
  } else if (r.inFrame) {
    if (r.n < 34) r.spaces[r.n] = w;
    r.n++;
    if (r.n >= 33) {                                  // header space + 32 bits
      report(r);
      r.inFrame = false;
    }
  }
  r.lastLevel = now;
}

void setup() {
  Serial.begin(9600);
  rxs[0] = { PIN_A, "A", HIGH, 0, {}, 0, false };
  rxs[1] = { PIN_B, "B", HIGH, 0, {}, 0, false };
  for (byte i = 0; i < 2; i++) {
    pinMode(rxs[i].pin, INPUT);
    rxs[i].lastLevel = digitalRead(rxs[i].pin);
    rxs[i].lastEdgeUs = micros();
  }
  Serial.println(F("Press a button. Both receivers hear it."));
}

void loop() {
  poll(rxs[0]);
  poll(rxs[1]);
}
`;

const ESP32_CODE = `// IR remote -> IR receiver on an ESP32. Same link as the Uno example: the
// medium is the air, not a wire, and the envelope is real NEC timing on the
// guest's own clock -- in the browser engine and under QEMU alike.
//
// Wiring: DAT -> GPIO 15   VCC -> 3V3   GND -> GND
#include <IRremote.hpp>

const int RECV_PIN = 15;

void setup() {
  Serial.begin(115200);
  IrReceiver.begin(RECV_PIN, DISABLE_LED_FEEDBACK);
  Serial.println("Point the remote at the receiver and press a button.");
}

void loop() {
  if (IrReceiver.decode()) {
    if (IrReceiver.decodedIRData.protocol == UNKNOWN) {
      Serial.println("received something this build cannot name");
    } else if (IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT) {
      Serial.println("(key held)");
    } else {
      Serial.printf("protocol %s  address 0x%02X  command 0x%02X\\n",
                    getProtocolString(IrReceiver.decodedIRData.protocol),
                    IrReceiver.decodedIRData.address,
                    IrReceiver.decodedIRData.command);
    }
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
      {
        type: 'ir-receiver',
        id: 'ir1',
        x: 440,
        y: 140,
        properties: { irAddress: '0x00', irCommand: '0x45', channel: '' },
      },
      {
        type: 'ir-remote',
        id: 'remote1',
        x: 640,
        y: 60,
        properties: { irAddress: '0x00', channel: '' },
      },
    ],
    wires: [
      {
        id: 'w-dat',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'ir1', pinName: 'DAT' },
        color: '#ffaa00',
      },
      {
        id: 'w-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'ir1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'ir1', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'ir-two-receivers-uno',
    title: 'IR: one remote, two receivers',
    description:
      'One press, both receivers. This is the thing a wire cannot express: ' +
      'infrared is a room, not a connection, so every receiver hears every ' +
      'remote. The sketch times the envelope on each pin itself, which is also ' +
      'the proof that the pins really are carrying NEC timing. Serial Monitor ' +
      'at 9600 baud.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'arduino-uno',
    boardFilter: 'arduino-uno',
    tags: [...IR_TAGS, 'two receivers'],
    code: UNO_TWO_CODE,
    components: [
      {
        type: 'ir-receiver',
        id: 'irA',
        x: 440,
        y: 100,
        properties: { irAddress: '0x00', irCommand: '0x45', channel: '' },
      },
      {
        type: 'ir-receiver',
        id: 'irB',
        x: 440,
        y: 260,
        properties: { irAddress: '0x00', irCommand: '0x45', channel: '' },
      },
      {
        type: 'ir-remote',
        id: 'remote1',
        x: 660,
        y: 60,
        properties: { irAddress: '0x00', channel: '' },
      },
    ],
    wires: [
      {
        id: 'wa-dat',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'irA', pinName: 'DAT' },
        color: '#ffaa00',
      },
      {
        id: 'wa-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'irA', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'wa-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'irA', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wb-dat',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'irB', pinName: 'DAT' },
        color: '#ffcc44',
      },
      {
        id: 'wb-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'irB', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'wb-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.2' },
        end: { componentId: 'irB', pinName: 'GND' },
        color: '#000000',
      },
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
      {
        type: 'ir-receiver',
        id: 'ir1',
        x: 460,
        y: 150,
        properties: { irAddress: '0x00', irCommand: '0x45', channel: '' },
      },
      {
        type: 'ir-remote',
        id: 'remote1',
        x: 660,
        y: 60,
        properties: { irAddress: '0x00', channel: '' },
      },
    ],
    wires: [
      {
        id: 'w-dat',
        start: { componentId: 'esp32', pinName: '15' },
        end: { componentId: 'ir1', pinName: 'DAT' },
        color: '#ffaa00',
      },
      {
        id: 'w-vcc',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'ir1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'esp32', pinName: 'GND.1' },
        end: { componentId: 'ir1', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
];
