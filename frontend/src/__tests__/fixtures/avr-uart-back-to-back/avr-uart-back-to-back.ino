// Back-to-back characters through HardwareSerial at two rates.
void setup() {
  Serial.begin(9600);
  Serial.print("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij"); // 46 chars, fits the 64-byte ring
  Serial.flush();
  Serial.end();
  Serial.begin(115200);
  Serial.print("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij");
  Serial.flush();
}
void loop() {}
