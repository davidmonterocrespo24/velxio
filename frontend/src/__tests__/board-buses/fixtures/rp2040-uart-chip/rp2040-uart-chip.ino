// Raspberry Pi Pico talking to a UART chip on UART1 (Serial2: TX GP8, RX GP9)
// while it logs on UART0 (Serial, the console).
//   chip (fixtures/rp2040-chips/uart-pong.c): answers "PONG<n>" to a "PING"
//   line, n = the number of lines it has heard in total.
// The console line "debug PING" goes out on UART0 only; a chip on UART1 never
// hears it on real hardware, so the right reply is PONG1, on Serial2.
void setup() {
  Serial.begin(115200);
  Serial2.begin(115200);
  Serial.println("READY");
  Serial.println("debug PING");
  delay(2);
  Serial2.print("PING\n");
  String reply;
  unsigned long t0 = millis();
  bool got = false;
  while (!got && millis() - t0 < 50) {
    while (Serial2.available()) {
      char c = Serial2.read();
      if (c == '\n') { got = true; break; }
      reply += c;
    }
  }
  Serial.print("REPLY:");
  Serial.println(reply.length() ? reply : String("NONE"));
  String stray;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n') stray += c;
  }
  Serial.print("U0RX:");
  Serial.println(stray.length() ? stray : String("NONE"));
  Serial.println("DONE");
}

void loop() {}
