/**
 * arduino_serial_controller.ino — Arduino Uno firmware.
 *
 * Controls an ESP32's built-in LED (GPIO2) over a UART serial link.
 * Sends LED_ON / LED_OFF commands and reads the ESP32's replies.
 *
 * ── Wiring ─────────────────────────────────────────────────────────────────
 *   In Velxio canvas:
 *     Wire Arduino pin 11 (SoftSerial TX) → ESP32 GPIO1 (UART0 RX)
 *     Wire Arduino pin 10 (SoftSerial RX) ← ESP32 GPIO3 (UART0 TX)
 *
 *   On real hardware: use a 3.3V level-shifter (Arduino is 5V; ESP32 is 3.3V).
 *
 * ── Protocol ───────────────────────────────────────────────────────────────
 *   Arduino → ESP32: "LED_ON\n"  or  "LED_OFF\n"  or  "PING\n"
 *   ESP32   → Arduino: "OK:ON\n"  or  "OK:OFF\n"  or  "PONG\n"
 *
 * ── Board ──────────────────────────────────────────────────────────────────
 *   FQBN: arduino:avr:uno
 *   No extra libraries required (SoftwareSerial is built-in).
 */

#include <SoftwareSerial.h>

// Use pins 10/11 so USB Serial (0/1) stays free for the Serial Monitor
SoftwareSerial esp32Link(10, 11);  // RX, TX

bool ledOn = false;

void setup() {
  Serial.begin(9600);      // USB Serial Monitor
  esp32Link.begin(115200); // Link to ESP32

  Serial.println(F("Arduino: booting..."));
  delay(2000);  // Wait for ESP32 to boot

  // Connection check
  Serial.println(F("Arduino: sending PING..."));
  esp32Link.println("PING");
  delay(300);

  while (esp32Link.available()) {
    String resp = esp32Link.readStringUntil('\n');
    resp.trim();
    Serial.print(F("ESP32 boot reply: "));
    Serial.println(resp);
  }
}

void loop() {
  // Read any incoming response from ESP32
  while (esp32Link.available()) {
    String resp = esp32Link.readStringUntil('\n');
    resp.trim();
    if (resp.length() > 0) {
      Serial.print(F("ESP32: "));
      Serial.println(resp);
    }
  }

  // Toggle LED every second
  if (ledOn) {
    Serial.println(F("Arduino → ESP32: LED_OFF"));
    esp32Link.println("LED_OFF");
  } else {
    Serial.println(F("Arduino → ESP32: LED_ON"));
    esp32Link.println("LED_ON");
  }
  ledOn = !ledOn;

  delay(1000);
}
