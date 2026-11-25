// Timer0 fast PWM at register level (the core set WGM 3 and prescaler 64).
// OCR0A = 0 with COM0A1: a one-tick spike (4 us) every 1024 us on pin 6.
// OCR0B = 255 with COM0B1: constantly HIGH on pin 5 (datasheet section 15.7.3).
void setup() {
  pinMode(6, OUTPUT);
  pinMode(5, OUTPUT);
  OCR0A = 0;
  OCR0B = 255;
  TCCR0A |= _BV(COM0A1) | _BV(COM0B1);
}
void loop() {}
