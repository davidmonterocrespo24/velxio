// Arduino Mega: SPI_STC must reach its own ISR (Mega vector 24, word 0x30).
//
// Nothing else here uses an interrupt: Timer0's overflow is switched off
// first thing and the UART is polled, so the only vector this sketch can
// land on is SPI_STC. Eight master transfers each wait for the ISR to count
// them. A transfer-complete that lands on an unused slot jumps to
// __bad_interrupt, which restarts the sketch: BOOT then shows up again.
//
// Serial protocol (111111 baud, UBRR0 = 8): BOOT, then SPI_ISR:<count>.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:mega --out <this dir> <this dir>/avr-mega-spi-isr.ino
#include <avr/io.h>
#include <avr/interrupt.h>
#include <stdlib.h>

volatile uint16_t spiIsr = 0;
ISR(SPI_STC_vect) { spiIsr++; }

static void put(char c) {
  while (!(UCSR0A & _BV(UDRE0))) {}
  UDR0 = c;
}
static void print(const char *s) {
  while (*s) put(*s++);
}

void setup() {
  TIMSK0 = 0;
  UBRR0 = 8;
  UCSR0A = 0;
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);
  UCSR0B = _BV(TXEN0);
  print("BOOT\n");
  DDRB |= _BV(PB0) | _BV(PB1) | _BV(PB2);  // SS (D53), SCK (D52), MOSI (D51)
  SPCR = _BV(SPE) | _BV(MSTR) | _BV(SPIE);
  sei();
  for (uint8_t i = 0; i < 8; i++) {
    const uint16_t before = spiIsr;
    SPDR = 0xA5;
    while (spiIsr == before) {}
  }
  char buf[8];
  utoa(spiIsr, buf, 10);
  print("SPI_ISR:");
  print(buf);
  print("\n");
}

void loop() {}
