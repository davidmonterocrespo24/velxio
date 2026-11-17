// The other end of od-pulse.ino's line: D2 as INPUT_PULLUP, nothing else.
#include <avr/io.h>
void setup() {
  DDRD &= ~_BV(2);
  PORTD |= _BV(2);
}
void loop() {}
