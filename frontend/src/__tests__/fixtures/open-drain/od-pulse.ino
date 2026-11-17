// An open-drain line between two boards: four 1 ms pulses on D2, 500 ms apart.
// The pad is pulled low the open-drain way (its PORT bit cleared, then its DDR
// bit set: never driven high) and let go (DDR cleared, then the pull-up back
// on); between pulses it idles as INPUT_PULLUP, as the other board's D2 does
// (od-listen.ino). od-pair.ino is this with PAIRS 1: two pulses 10 ms apart
// each time.
#include <avr/io.h>
#ifndef PAIRS
#define PAIRS 0
#endif
static void pulse() {
  PORTD &= ~_BV(2);
  DDRD |= _BV(2);
  delayMicroseconds(1000);
  DDRD &= ~_BV(2);
  PORTD |= _BV(2);
}
void setup() {
  DDRD &= ~_BV(2);
  PORTD |= _BV(2);
  delay(100);
  for (int k = 0; k < 4; k++) {
    pulse();
#if PAIRS
    delay(10);
    pulse();
#endif
    delay(500);
  }
}
void loop() {}
