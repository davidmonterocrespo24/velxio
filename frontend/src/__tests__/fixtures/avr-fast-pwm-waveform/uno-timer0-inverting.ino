// Timer0 inverting fast PWM: cleared at BOTTOM, set when TCNT0 leaves OCR0A.
// OCR0A = 64: LOW for 65 ticks, HIGH for 191 (764 us of 1024 us) on pin 6.
void setup() {
  pinMode(6, OUTPUT);
  OCR0A = 64;
  TCCR0A = _BV(COM0A1) | _BV(COM0A0) | _BV(WGM01) | _BV(WGM00);
}
void loop() {}
