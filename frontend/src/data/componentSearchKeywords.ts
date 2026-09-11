/**
 * Search-only vocabulary per component id.
 *
 * The scanned metadata gives most parts nothing to search by beyond their
 * own name ("DHT22", tags ["dht22"]), so "temperature" found no sensor and
 * "ultrasonic" found no HC-SR04. These words are what a person reaching for
 * the part would type; they are never displayed. Overlay parts can carry the
 * same thing in `ComponentMetadata.keywords`; entries here are merged with
 * those at search time, so an id listed in both gets both.
 *
 * Keep it English: the query side translates through utils/searchSynonyms.ts
 * ("temperatura" is searched as "temperature").
 */

const KEYWORDS: Record<string, string> = {
  // ── Boards (also the boards row of the picker) ──────────────────────────
  'arduino-uno': 'board microcontroller atmega328p avr uno r3',
  'arduino-nano': 'board microcontroller atmega328p avr nano small',
  'arduino-mega': 'board microcontroller atmega2560 avr mega 2560',
  'esp32-devkit-v1': 'board microcontroller esp32 wifi bluetooth xtensa wroom devkit',
  franzininho: 'board microcontroller attiny85 avr digispark',
  'nano-rp2040-connect': 'board microcontroller arduino nano rp2040 wifi',

  // ── Sensors ─────────────────────────────────────────────────────────────
  dht22: 'temperature humidity sensor dht11 dht weather climate am2302',
  bmp280: 'pressure temperature barometer altitude weather sensor i2c bosch',
  'hc-sr04': 'ultrasonic distance sensor sonar ranging proximity obstacle echo trigger',
  'pir-motion-sensor': 'pir motion sensor presence movement infrared hc-sr501',
  'ntc-temperature-sensor': 'thermistor temperature sensor ntc analog',
  'photoresistor-sensor': 'ldr light sensor photoresistor brightness darkness analog',
  photodiode: 'light sensor photodiode optical analog',
  mpu6050: 'accelerometer gyroscope imu motion tilt orientation 6 axis i2c gy-521',
  'gps-neo6m': 'gps location position satellite nmea serial uart',
  'heart-beat-sensor': 'heart rate pulse sensor bpm ppg ky-039',
  'gas-sensor': 'gas sensor smoke air quality mq2 mq135 mq-2 analog',
  'flame-sensor': 'flame fire sensor infrared detector',
  'tilt-switch': 'tilt switch ball sensor orientation shake',
  'big-sound-sensor': 'sound sensor microphone mic audio noise clap',
  'small-sound-sensor': 'sound sensor microphone mic audio noise clap',
  hx711: 'load cell weight scale amplifier adc strain gauge',
  ds1307: 'rtc real time clock date time i2c battery backup',
  ds3231: 'rtc real time clock date time i2c precision temperature',

  // ── Displays ────────────────────────────────────────────────────────────
  ssd1306: 'oled display screen monochrome 128x64 i2c spi',
  'ssd1306-i2c-4pin': 'oled display screen monochrome 128x64 i2c 4 pin',
  lcd1602: 'lcd display screen character text 16x2 hd44780 liquidcrystal parallel',
  'lcd1602-i2c': 'lcd display screen character text 16x2 hd44780 liquidcrystal i2c',
  lcd2004: 'lcd display screen character text 20x4 hd44780 liquidcrystal parallel',
  'lcd2004-i2c': 'lcd display screen character text 20x4 hd44780 liquidcrystal i2c',
  ili9341: 'tft lcd display screen color spi 240x320 touch 2.8',
  'epaper-1in54-bw': 'epaper e-ink eink display screen',
  'epaper-2in13-bw': 'epaper e-ink eink display screen',
  'epaper-2in13-bwr': 'epaper e-ink eink display screen red',
  'epaper-2in9-bw': 'epaper e-ink eink display screen',
  'epaper-2in9-bwr': 'epaper e-ink eink display screen red',
  'epaper-4in2-bw': 'epaper e-ink eink display screen',
  'epaper-5in65-7c': 'epaper e-ink eink display screen color',
  'epaper-7in5-bw': 'epaper e-ink eink display screen',
  '7segment': 'seven segment display digit number counter',
  'led-bar-graph': 'led bar graph level meter vu indicator',
  'neopixel-matrix': 'neopixel matrix ws2812 rgb led addressable pixels 8x8',
  'led-ring': 'led ring neopixel ws2812 rgb addressable circle',

  // ── Input ───────────────────────────────────────────────────────────────
  pushbutton: 'push button switch tactile momentary input',
  'pushbutton-6mm': 'push button switch tactile momentary small input',
  'slide-switch': 'slide switch toggle spdt on off',
  'dip-switch-8': 'dip switch toggle settings 8 way',
  potentiometer: 'potentiometer pot knob dial variable resistor analog input trimmer volume',
  'slide-potentiometer': 'slider fader potentiometer analog input linear',
  'ky-040': 'rotary encoder knob dial input quadrature',
  'membrane-keypad': 'keypad keyboard matrix buttons 4x4 numeric',
  'analog-joystick': 'joystick gamepad thumbstick xy input analog',
  'rotary-dialer': 'rotary dial phone telephone pulse retro',
  'ir-receiver': 'infrared receiver remote control ir nec',
  'ir-remote': 'infrared remote control handset ir nec',

  // ── Output ──────────────────────────────────────────────────────────────
  led: 'led light diode indicator lamp',
  'rgb-led': 'rgb led color light multicolor',
  neopixel: 'neopixel ws2812 rgb led addressable strip pixel',
  buzzer: 'buzzer speaker piezo sound beep tone audio alarm music',

  // ── Motors and drivers ──────────────────────────────────────────────────
  servo: 'servo motor sg90 pwm angle position',
  'stepper-motor': 'stepper motor 28byj-48 nema steps',
  'biaxial-stepper': 'stepper motor bipolar biaxial',
  a4988: 'stepper motor driver step dir microstepping',
  'motor-driver-l293d': 'motor driver h-bridge dc motor l293d dual',
  relay: 'relay switch coil mains load spdt',
  'ks2e-m-dc5': 'relay dpdt coil switch',

  // ── Storage and connectivity ────────────────────────────────────────────
  'microsd-card': 'sd card microsd storage memory spi files',

  // ── Passive ─────────────────────────────────────────────────────────────
  breadboard: 'breadboard protoboard prototype',
  'breadboard-mini': 'breadboard protoboard prototype small',
  junction: 'junction wire node net',
  resistor: 'resistor ohm custom value',
  capacitor: 'capacitor ceramic custom value',
  'capacitor-electrolytic': 'capacitor electrolytic polarized custom value',
  inductor: 'inductor coil custom value',

  // ── Analog ──────────────────────────────────────────────────────────────
  diode: 'diode rectifier',
  'diode-1n4007': 'rectifier diode power mains',
  'diode-1n4148': 'signal diode switching fast',
  'zener-1n4733': 'zener diode voltage reference regulator',
  'diode-1n5817': 'schottky diode low drop',
  'diode-1n5819': 'schottky diode low drop',
  'bjt-2n2222': 'transistor bjt npn switch amplifier',
  'bjt-2n3055': 'transistor bjt npn power switch amplifier',
  'bjt-2n3906': 'transistor bjt pnp switch amplifier',
  'bjt-bc547': 'transistor bjt npn switch amplifier',
  'bjt-bc557': 'transistor bjt pnp switch amplifier',
  'mosfet-2n7000': 'transistor mosfet fet n channel switch',
  'mosfet-irf540': 'transistor mosfet fet n channel power switch',
  'mosfet-irf9540': 'transistor mosfet fet p channel switch',
  'mosfet-fqp27p06': 'transistor mosfet fet p channel switch',
  'opto-4n25': 'optocoupler optoisolator isolation',
  'opto-pc817': 'optocoupler optoisolator isolation',
  'reg-7805': 'voltage regulator linear power supply 5v',
  'reg-7812': 'voltage regulator linear power supply 12v',
  'reg-7905': 'voltage regulator linear power supply negative 5v',
  'reg-lm317': 'voltage regulator linear adjustable power supply',
  'battery-9v': 'battery power source 9v',
  'battery-aa': 'battery power source aa cell 1.5v',
  'battery-coin-cell': 'battery power source coin cell cr2032 3v',
  'opamp-ideal': 'op amp operational amplifier ideal',
  'opamp-lm324': 'op amp operational amplifier quad',
  'opamp-lm358': 'op amp operational amplifier dual',
  'opamp-lm741': 'op amp operational amplifier',
  'opamp-tl072': 'op amp operational amplifier jfet audio',
  'power-supply': 'power supply psu bench voltage source dc',
  'signal-generator': 'signal function generator waveform sine square oscillator source',

  // ── Logic ───────────────────────────────────────────────────────────────
  'ic-74hc00': 'logic ic chip nand gate 7400',
  'ic-74hc02': 'logic ic chip nor gate 7402',
  'ic-74hc04': 'logic ic chip not inverter 7404',
  'ic-74hc08': 'logic ic chip and gate 7408',
  'ic-74hc14': 'logic ic chip schmitt inverter 7414',
  'ic-74hc32': 'logic ic chip or gate 7432',
  'ic-74hc86': 'logic ic chip xor gate 7486',
  'flip-flop-d': 'flip flop latch register memory',
  'flip-flop-jk': 'flip flop latch memory',
  'flip-flop-t': 'flip flop toggle latch memory',
};

/** Keys use the registry's bare id ("led"), not the element tag ("wokwi-led"). */
export function componentSearchKeywords(id: string): string {
  const bare = id.replace(/^(wokwi|velxio)-/, '');
  return KEYWORDS[bare] ?? '';
}

/**
 * Board kinds in the picker's boards row are not registry entries; they get
 * a line each here so "rp2040", "riscv" or "wifi" reach the right card.
 */
const BOARD_KEYWORDS: Record<string, string> = {
  'arduino-uno': 'arduino avr atmega328p uno',
  'arduino-nano': 'arduino avr atmega328p nano',
  'arduino-mega': 'arduino avr atmega2560 mega',
  'raspberry-pi-pico': 'raspberry pi pico rp2040 micropython arm cortex m0',
  'pi-pico-w': 'raspberry pi pico w rp2040 wifi wireless micropython',
  'raspberry-pi-zero': 'raspberry pi zero linux python',
  'raspberry-pi-1': 'raspberry pi 1 linux python',
  'raspberry-pi-2': 'raspberry pi 2 linux python',
  'raspberry-pi-3': 'raspberry pi 3 linux python wifi',
  'raspberry-pi-4': 'raspberry pi 4 linux python wifi',
  'raspberry-pi-5': 'raspberry pi 5 linux python wifi',
  esp32: 'esp32 espressif wifi bluetooth xtensa wroom devkit',
  'esp32-devkit-c-v4': 'esp32 espressif wifi bluetooth xtensa wroom devkit',
  'esp32-cam': 'esp32 espressif camera wifi ov2640',
  'wemos-lolin32-lite': 'esp32 espressif wifi bluetooth wemos lolin',
  'esp32-s3': 'esp32 s3 espressif wifi bluetooth xtensa usb',
  'xiao-esp32-s3': 'esp32 s3 seeed xiao espressif wifi bluetooth small',
  'arduino-nano-esp32': 'arduino nano esp32 s3 espressif wifi bluetooth',
  'esp32-c3': 'esp32 c3 espressif wifi bluetooth riscv risc-v',
  'xiao-esp32-c3': 'esp32 c3 seeed xiao espressif wifi bluetooth riscv small',
  'aitewinrobot-esp32c3-supermini': 'esp32 c3 supermini espressif wifi bluetooth riscv small',
  'stm32-bluepill': 'stm32 arm cortex m3 f103 blue pill stmicro',
  'stm32-blackpill': 'stm32 arm cortex m4 f401 f411 black pill stmicro',
  'stm32-bluepill-f103cb': 'stm32 arm cortex m3 f103 blue pill stmicro',
  'stm32-blackpill-f401': 'stm32 arm cortex m4 f401 black pill stmicro',
  'stm32-f4-discovery': 'stm32 arm cortex m4 f407 discovery stmicro',
  'stm32-olimex-h405': 'stm32 arm cortex m4 f405 olimex stmicro',
  'stm32-netduino-plus2': 'stm32 arm cortex m4 netduino stmicro',
  'stm32-netduino2': 'stm32 arm cortex m4 netduino stmicro',
  attiny85: 'attiny avr tiny digispark small',
};

export function boardSearchKeywords(kind: string): string {
  return BOARD_KEYWORDS[kind] ?? '';
}
