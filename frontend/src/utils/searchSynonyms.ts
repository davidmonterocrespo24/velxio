/**
 * Vocabulary for searchMatch.ts: stopwords and a synonym table.
 *
 * Part names, tags and example titles are English, but the UI ships in nine
 * languages and people type in their own: "temperatura", "pantalla",
 * "bouton", "Taster". Each concept below lists the English words the
 * catalogue actually uses (`en`) and the words people type for it in any
 * language, abbreviations included ("btn", "pot", "mic"). A synonym hit
 * scores slightly below a direct hit, so a part whose name really is the
 * typed word still comes first.
 *
 * Words are matched after normalizeSearchText(): lower-case, no accents.
 * Keep them single words; the query is split before lookup, so a phrase like
 * "paso a paso" is three lookups and "paso" alone reaches "stepper". A word
 * may appear under several concepts; the lookups merge.
 *
 * Latin-script locales only (es, pt-br, fr, de, it). The CJK and Cyrillic
 * locales search part numbers, which read the same in every language.
 */

/**
 * Words that are never required to match: "sensor DE temperatura" must not
 * fail on "de". They still add score when they do match, so the AND gate is
 * findable as "and gate" ("gate" is required, "and" is a bonus) and a query
 * made only of stopwords ("and", "or") is searched as typed.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // en
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'for',
  'with',
  'to',
  'in',
  'on',
  'at',
  'by',
  'my',
  // es
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'en',
  'con',
  'para',
  'por',
  'al',
  'mi',
  // pt
  'da',
  'do',
  'das',
  'dos',
  'um',
  'uma',
  'e',
  'com',
  'no',
  'na',
  'nos',
  'nas',
  'ao',
  // fr
  'le',
  'les',
  'des',
  'du',
  'et',
  'une',
  'pour',
  'avec',
  'au',
  'aux',
  'sur',
  // de
  'der',
  'die',
  'das',
  'und',
  'mit',
  'fur',
  'ein',
  'eine',
  'einen',
  'einem',
  'zum',
  'zur',
  'im',
  // it
  'il',
  'lo',
  'gli',
  'di',
  'per',
  'della',
  'dello',
  'delle',
  'degli',
  'dei',
  'nel',
  'nella',
]);

interface Concept {
  /** What the catalogue calls it (single words or short phrases). */
  en: string[];
  /** What people type for it, in any supported language. */
  words: string[];
}

const CONCEPTS: Concept[] = [
  // ── Physical quantities ─────────────────────────────────────────────────
  {
    en: ['temperature'],
    words: [
      'temp',
      'thermo',
      'thermometer',
      'temperatura',
      'termometro',
      'thermometre',
      'temperatur',
      'termometer',
    ],
  },
  {
    en: ['humidity'],
    words: [
      'humid',
      'moisture',
      'humedad',
      'umidade',
      'humidite',
      'feuchtigkeit',
      'luftfeuchtigkeit',
      'umidita',
    ],
  },
  {
    en: ['pressure'],
    words: [
      'barometer',
      'altitude',
      'presion',
      'barometro',
      'pressao',
      'pression',
      'druck',
      'luftdruck',
      'pressione',
    ],
  },
  {
    en: ['weather', 'temperature', 'humidity', 'pressure'],
    words: ['clima', 'meteorologica', 'meteo', 'wetter', 'wetterstation', 'tempo'],
  },
  {
    en: ['light'],
    words: ['lux', 'brightness', 'luz', 'luces', 'lumiere', 'licht', 'luce', 'luci'],
  },
  {
    en: ['light', 'night'],
    words: ['dark', 'darkness', 'noche', 'oscuridad', 'noite', 'escuro', 'nuit', 'nacht', 'notte'],
  },
  {
    en: ['distance', 'ultrasonic'],
    words: ['range', 'proximity', 'distancia', 'distancia', 'abstand', 'entfernung', 'distanza'],
  },
  {
    en: ['ultrasonic'],
    words: [
      'ultrasound',
      'sonar',
      'ultrasonido',
      'ultrasonidos',
      'ultrasonico',
      'ultrassonico',
      'ultrassom',
      'ultrason',
      'ultrasons',
      'ultraschall',
      'ultrasuoni',
      'ultrasuono',
    ],
  },
  {
    en: ['sound'],
    words: ['audio', 'noise', 'sonido', 'sonidos', 'som', 'son', 'ton', 'klang', 'suono'],
  },
  {
    en: ['microphone', 'sound'],
    words: ['mic', 'microfono', 'microfone', 'mikrofon'],
  },
  {
    en: ['motion', 'pir'],
    words: [
      'presence',
      'movement',
      'movimiento',
      'presencia',
      'movimento',
      'presenca',
      'mouvement',
      'bewegung',
      'bewegungsmelder',
      'presenza',
    ],
  },
  {
    en: ['weight', 'load cell', 'scale'],
    words: [
      'peso',
      'bascula',
      'balanza',
      'balanca',
      'poids',
      'balance',
      'gewicht',
      'waage',
      'bilancia',
    ],
  },
  {
    en: ['color', 'rgb'],
    words: [
      'colour',
      'colores',
      'cor',
      'cores',
      'couleur',
      'couleurs',
      'farbe',
      'farben',
      'colore',
      'colori',
    ],
  },
  {
    en: ['gas', 'smoke'],
    words: ['co2', 'humo', 'fumaca', 'fumee', 'rauch', 'fumo'],
  },
  {
    en: ['flame', 'fire'],
    words: ['llama', 'fuego', 'chama', 'fogo', 'flamme', 'feuer', 'fiamma', 'fuoco'],
  },
  {
    en: ['infrared', 'ir'],
    words: [
      'infrarrojo',
      'infrarrojos',
      'infravermelho',
      'infrarouge',
      'infrarot',
      'infrarosso',
      'infrarossi',
    ],
  },
  {
    en: ['heart', 'pulse'],
    words: [
      'heartbeat',
      'bpm',
      'corazon',
      'pulso',
      'latido',
      'coracao',
      'batimento',
      'coeur',
      'pouls',
      'herz',
      'puls',
      'cuore',
      'battito',
    ],
  },
  {
    en: ['accelerometer', 'gyroscope'],
    words: [
      'imu',
      'accel',
      'gyro',
      'acelerometro',
      'giroscopio',
      'accelerometre',
      'beschleunigung',
      'beschleunigungssensor',
      'gyroskop',
      'accelerometro',
    ],
  },
  { en: ['tilt'], words: ['vibration', 'inclinacion', 'neigung', 'inclinazione'] },
  {
    en: ['water', 'level', 'soil', 'plant'],
    words: [
      'agua',
      'suelo',
      'tierra',
      'planta',
      'plantas',
      'nivel',
      'solo',
      'eau',
      'sol',
      'plante',
      'niveau',
      'wasser',
      'boden',
      'pflanze',
      'pegel',
      'acqua',
      'terreno',
      'pianta',
      'livello',
    ],
  },

  // ── Parts ───────────────────────────────────────────────────────────────
  { en: ['sensor'], words: ['sensores', 'capteur', 'capteurs', 'sensoren', 'sensore', 'sensori'] },
  {
    en: ['display', 'screen'],
    words: [
      'monitor',
      'pantalla',
      'pantallas',
      'tela',
      'telas',
      'ecran',
      'ecrans',
      'afficheur',
      'affichage',
      'bildschirm',
      'anzeige',
      'anzeigen',
      'schermo',
      'schermi',
    ],
  },
  { en: ['oled', 'ssd1306'], words: ['pantallita'] },
  { en: ['tft', 'ili9341', 'display'], words: ['tft'] },
  { en: ['lcd', 'display'], words: ['lcd'] },
  { en: ['epaper', 'e ink'], words: ['eink', 'epaper', 'papel', 'tinta'] },
  {
    en: ['7segment', 'seven segment', 'display'],
    words: [
      'segment',
      'seven',
      'digit',
      'segmentos',
      'segmento',
      'siebensegment',
      'ziffer',
      'cifra',
    ],
  },
  {
    en: ['button', 'pushbutton'],
    words: [
      'btn',
      'buttons',
      'boton',
      'botones',
      'pulsador',
      'pulsadores',
      'botao',
      'botoes',
      'bouton',
      'boutons',
      'poussoir',
      'taste',
      'taster',
      'knopf',
      'pulsante',
      'pulsanti',
      'bottone',
    ],
  },
  {
    en: ['switch'],
    words: ['interruptor', 'interruptores', 'chave', 'interrupteur', 'schalter', 'interruttore'],
  },
  {
    en: ['potentiometer'],
    words: [
      'pot',
      'potenciometro',
      'potenciometros',
      'potentiometre',
      'poti',
      'drehregler',
      'potenziometro',
    ],
  },
  { en: ['potentiometer', 'encoder'], words: ['knob', 'dial', 'perilla', 'manopola'] },
  { en: ['encoder', 'rotary'], words: ['codificador', 'codeur', 'drehgeber'] },
  {
    en: ['led', 'light'],
    words: ['lamp', 'bulb', 'lampara', 'bombilla', 'lampada', 'lampe', 'ampoule', 'gluhbirne'],
  },
  {
    en: ['photoresistor', 'light'],
    words: ['ldr', 'photocell', 'fotoresistencia', 'fotoresistor'],
  },
  {
    en: ['buzzer', 'speaker'],
    words: [
      'piezo',
      'beeper',
      'altavoz',
      'zumbador',
      'bocina',
      'parlante',
      'altoparlante',
      'campainha',
      'buzina',
      'hautparleur',
      'lautsprecher',
      'summer',
      'piepser',
      'cicalino',
    ],
  },
  {
    en: ['resistor'],
    words: [
      'res',
      'resistencia',
      'resistencias',
      'resistores',
      'resistance',
      'resistances',
      'widerstand',
      'widerstande',
      'resistenza',
      'resistenze',
    ],
  },
  {
    en: ['capacitor'],
    words: [
      'cap',
      'condensador',
      'condensadores',
      'capacitores',
      'condensateur',
      'condensateurs',
      'kondensator',
      'kondensatoren',
      'condensatore',
      'condensatori',
    ],
  },
  {
    en: ['inductor', 'coil'],
    words: ['bobina', 'indutor', 'inductance', 'bobine', 'spule', 'induttore'],
  },
  { en: ['diode'], words: ['diodo', 'diodos', 'diodi'] },
  { en: ['transistor', 'bjt', 'mosfet'], words: ['fet', 'transistores', 'transistori'] },
  {
    en: ['op amp', 'amplifier'],
    words: ['opamp', 'amp', 'amplificador', 'amplificateur', 'verstarker', 'amplificatore'],
  },
  {
    en: ['voltage regulator', 'regulator'],
    words: ['regulador', 'regulateur', 'regler', 'regolatore'],
  },
  {
    en: ['battery'],
    words: [
      'batt',
      'bateria',
      'baterias',
      'pila',
      'pilas',
      'pilha',
      'pilhas',
      'batterie',
      'batteries',
      'batterien',
      'batteria',
    ],
  },
  {
    en: ['power supply', 'power', 'source'],
    words: [
      'psu',
      'fuente',
      'alimentacion',
      'fonte',
      'alimentation',
      'netzteil',
      'stromversorgung',
      'alimentatore',
    ],
  },
  {
    en: ['motor'],
    words: ['motores', 'moteur', 'moteurs', 'motore', 'motori'],
  },
  {
    en: ['stepper', 'motor'],
    words: ['paso', 'pasos', 'passo', 'pas', 'schrittmotor', 'schritt', 'passopasso'],
  },
  { en: ['servo'], words: ['servomotor', 'sg90'] },
  { en: ['h bridge', 'motor driver', 'driver'], words: ['hbridge', 'puente', 'ponte', 'brucke'] },
  { en: ['relay'], words: ['rele', 'reles', 'relevador', 'relais', 'rele'] },
  {
    en: ['keypad', 'keyboard'],
    words: ['keys', 'pad', 'teclado', 'teclas', 'clavier', 'tastatur', 'tastiera'],
  },
  { en: ['joystick'], words: ['gamepad', 'thumbstick', 'palanca', 'manette'] },
  {
    en: ['remote', 'ir remote', 'infrared'],
    words: ['mando', 'telecommande', 'fernbedienung', 'telecomando'],
  },
  {
    en: ['rtc', 'clock', 'time'],
    words: [
      'date',
      'reloj',
      'hora',
      'relogio',
      'horloge',
      'heure',
      'uhr',
      'zeit',
      'orologio',
      'ora',
    ],
  },
  {
    en: ['microsd', 'sd card', 'storage', 'memory'],
    words: [
      'sd',
      'sdcard',
      'memoria',
      'almacenamiento',
      'cartao',
      'memoire',
      'speicher',
      'speicherkarte',
      'tarjeta',
    ],
  },
  {
    en: ['neopixel', 'led'],
    words: ['neopixels', 'ws2812', 'ws2812b', 'addressable', 'strip', 'tira'],
  },
  {
    en: ['wire'],
    words: [
      'cable',
      'cables',
      'jumper',
      'fio',
      'fios',
      'fil',
      'fils',
      'kabel',
      'draht',
      'filo',
      'fili',
      'cavo',
    ],
  },
  {
    en: ['board', 'microcontroller'],
    words: [
      'pcb',
      'mcu',
      'micro',
      'placa',
      'placas',
      'carte',
      'cartes',
      'platine',
      'scheda',
      'schede',
    ],
  },
  { en: ['ic', 'chip'], words: ['chip', 'integrado', 'circuito integrado'] },
  {
    en: ['gps', 'position'],
    words: ['location', 'satellite', 'ubicacion', 'posicion', 'satelite'],
  },
  {
    en: ['wifi', 'wireless', 'esp32'],
    words: ['inalambrico', 'sansfil', 'drahtlos', 'senzafili', 'wireless'],
  },
  { en: ['ble', 'bluetooth', 'esp32'], words: ['bluetooth'] },
  { en: ['camera', 'cam'], words: ['camara', 'camera', 'kamera', 'telecamera', 'fotocamera'] },
  {
    en: ['gate', 'logic'],
    words: [
      'gates',
      'compuerta',
      'compuertas',
      'puerta',
      'puertas',
      'porta',
      'portas',
      'porte',
      'portes',
      'gatter',
    ],
  },
  { en: ['flip flop'], words: ['flipflop', 'latch', 'ff', 'biestable'] },
  { en: ['counter'], words: ['contador', 'compteur', 'zahler', 'contatore'] },
  { en: ['timer'], words: ['temporizador', 'minuteur', 'timer'] },
  { en: ['serial', 'uart'], words: ['serie', 'seriell', 'seriale'] },
  { en: ['analog'], words: ['adc', 'analogico', 'analogica', 'analogique', 'analogico'] },
  { en: ['pwm', 'analog'], words: ['pwm'] },

  // ── Gallery categories, difficulties, themes ────────────────────────────
  {
    en: ['games', 'game'],
    words: [
      'juego',
      'juegos',
      'jogo',
      'jogos',
      'jeu',
      'jeux',
      'spiel',
      'spiele',
      'gioco',
      'giochi',
    ],
  },
  { en: ['robotics', 'robot'], words: ['robotica', 'robo', 'robotique', 'roboter'] },
  {
    en: ['basics', 'beginner'],
    words: ['basic', 'basico', 'basicos', 'easy', 'simple', 'starter', 'grundlagen', 'base'],
  },
  { en: ['beginner'], words: ['principiante', 'iniciante', 'debutant', 'anfanger', 'einsteiger'] },
  { en: ['intermediate'], words: ['intermedio', 'intermediario', 'intermediaire', 'intermedio'] },
  { en: ['advanced'], words: ['avanzado', 'avancado', 'avance', 'fortgeschritten', 'avanzato'] },
  {
    en: ['communication'],
    words: ['comms', 'comunicacion', 'comunicacao', 'kommunikation', 'comunicazione'],
  },
  { en: ['circuits', 'circuit'], words: ['circuito', 'circuitos', 'schaltung', 'circuito'] },
  {
    en: ['blink'],
    words: [
      'hello',
      'parpadeo',
      'parpadear',
      'piscar',
      'pisca',
      'clignoter',
      'clignotant',
      'blinken',
      'lampeggio',
      'lampeggiare',
    ],
  },
  { en: ['traffic light'], words: ['semaforo', 'ampel', 'feu'] },
  { en: ['alarm'], words: ['alarma', 'alarme', 'allarme'] },
  { en: ['fan'], words: ['ventilador', 'ventilateur', 'lufter', 'ventola'] },
  {
    en: ['door', 'lock'],
    words: ['cerradura', 'fechadura', 'serrure', 'schloss', 'tur', 'serratura'],
  },
  { en: ['matrix'], words: ['matriz', 'matrice'] },
  { en: ['dice'], words: ['dado', 'dados', 'wurfel'] },
  {
    en: ['music', 'melody', 'buzzer'],
    words: ['musica', 'melodia', 'musique', 'melodie', 'musik'],
  },
  { en: ['car', 'robot'], words: ['coche', 'carro', 'vehiculo', 'voiture', 'auto', 'macchina'] },
  { en: ['arm', 'servo'], words: ['brazo', 'bras', 'braccio'] },
  { en: ['example'], words: ['ejemplo', 'ejemplos', 'exemple', 'beispiel', 'esempio', 'esempi'] },
];

const LOOKUP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const { en, words } of CONCEPTS) {
    for (const w of words) {
      const list = m.get(w) ?? [];
      for (const e of en) if (e !== w && !list.includes(e)) list.push(e);
      m.set(w, list);
    }
  }
  return m;
})();

/** Plural forms people type ("botones", "sensores", "resistors"). */
function stemVariants(token: string): string[] {
  const out: string[] = [];
  if (token.length > 4 && token.endsWith('es')) out.push(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s')) out.push(token.slice(0, -1));
  return out;
}

/**
 * The forms a query token is searched under: the token itself first, then
 * every synonym of it and of its singular. Synonyms of several words ("op
 * amp") are kept as phrases: they match as substrings of the field text.
 */
export function expandSearchToken(token: string): string[] {
  const forms: string[] = [token];
  const push = (w: string) => {
    if (!forms.includes(w)) forms.push(w);
  };
  for (const key of [token, ...stemVariants(token)]) {
    for (const s of LOOKUP.get(key) ?? []) push(s);
  }
  return forms;
}
