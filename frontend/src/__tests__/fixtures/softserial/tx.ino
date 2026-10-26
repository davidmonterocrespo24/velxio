#include <SoftwareSerial.h>
SoftwareSerial mySerial(10, 11); // RX, TX
void setup() {
  Serial.begin(9600);
  mySerial.begin(9600);
  Serial.println("Transmitter Initialized.");
}
void loop() {
  mySerial.println("PING");
  Serial.println("Sent: PING");
  delay(1000);
}
