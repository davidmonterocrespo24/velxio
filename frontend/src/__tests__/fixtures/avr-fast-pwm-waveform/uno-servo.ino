// Servo runs Timer1 in normal mode with compare A interrupts: 1500 us pulses
// every 20 ms on pin 9.
#include <Servo.h>
Servo s;
void setup() {
  s.attach(9);
  s.writeMicroseconds(1500);
}
void loop() {}
