// tx.ino with a longer line: 40 bytes at 9600 baud on D11 (41.6 ms from the
// first start bit to the last stop bit), one every 1213 ms.
#include <SoftwareSerial.h>
SoftwareSerial mySerial(10, 11); // RX, TX
void setup() {
  mySerial.begin(9600);
  delay(200);
}
void loop() {
  mySerial.print("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZab\r\n");
  delay(1213);
}
