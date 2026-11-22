// A sketch that shares Timer0 (fast PWM, prescaler 64) through its compare A
// interrupt, as the Adafruit GPS examples do. The flag is set at the timer
// clock after TCNT0 == OCR0A, so the ISR reads TCNT0 = OCR0A + 1 = 176.
volatile uint8_t seen = 0;
volatile uint16_t hits = 0;
ISR(TIMER0_COMPA_vect) {
  hits++;
  if (hits == 10) seen = TCNT0;
}
void setup() {
  Serial.begin(115200);
  OCR0A = 0xAF;
  TIMSK0 |= _BV(OCIE0A);
}
void loop() {
  static bool done = false;
  if (!done && millis() >= 100) {
    done = true;
    noInterrupts();
    uint16_t h = hits;
    uint8_t s = seen;
    interrupts();
    Serial.print("tcnt=");
    Serial.print(s);
    Serial.print(" hits=");
    Serial.println(h);
  }
}
