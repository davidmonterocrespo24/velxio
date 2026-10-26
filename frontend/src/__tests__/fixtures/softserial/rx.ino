#include <SoftwareSerial.h>
SoftwareSerial mySerial(10, 11); // RX, TX
void setup() {
  Serial.begin(9600);
  mySerial.begin(9600);
  Serial.println("Receiver Ready. Listening for signals...");
}
void loop() {
  while (mySerial.available() > 0) {
    int b = mySerial.read();
    Serial.print("Byte: "); Serial.print(b);
    Serial.print(" | HEX: 0x"); Serial.println(b, HEX);
  }
}
