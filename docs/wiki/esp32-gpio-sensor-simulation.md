# ESP32 GPIO Sensor Simulation — DHT22 & HC-SR04

> **Scope**: Documentación completa del proceso de investigación, fallos y solución final
> para hacer funcionar los sensores DHT22 y HC-SR04 en la simulación ESP32 de Velxio.
> Cubre **todo** lo que se intentó, **por qué falló** cada enfoque, y **por qué funciona**
> la solución actual.
>
> Audiencia: mantenedores que necesiten entender o extender la lógica de sensores GPIO.

---

## Tabla de contenidos

1. [Contexto — cómo funciona la emulación ESP32](#1-contexto)
2. [El callback `_on_dir_change(-1, -1)` — pieza clave](#2-el-callback-_on_dir_change-1--1)
3. [DHT22 — Problema, diagnóstico y solución](#3-dht22)
4. [HC-SR04 — Problema, todos los enfoques fallidos y solución](#4-hc-sr04)
5. [Arquitectura final — `_sync_handlers`](#5-arquitectura-final)
6. [Tests end-to-end](#6-tests-end-to-end)
7. [Cómo añadir un nuevo sensor GPIO-timed](#7-cómo-añadir-un-nuevo-sensor)
8. [Referencia rápida de constantes y tiempos](#8-referencia-rápida)

---

## 1. Contexto

La simulación ESP32 de Velxio corre sobre el [fork lcgamboa de QEMU](https://github.com/lcgamboa/qemu).
QEMU expone una serie de hooks C llamados **picsimlab hooks** que el backend Python usa para:

- Detectar cambios de estado en pines GPIO → `_on_pin_change(slot, value)`
- Detectar cambios de dirección (INPUT/OUTPUT) → `_on_dir_change(slot, direction)`
- Inyectar niveles en pines desde Python → `lib.qemu_picsimlab_set_pin(slot, value)`

### Pinmap (identity map)

```
slot = gpio_num + 1
```

Ejemplo: GPIO18 (TRIG) = slot 19, GPIO19 (ECHO) = slot 20, GPIO4 (DHT22 DATA) = slot 5.

### Tiempo virtual vs tiempo real

Un hallazgo crítico de esta investigación:

> **El tiempo virtual de QEMU corre aproximadamente 1:1 con el tiempo de pared (wall-clock).**

Confirmado empíricamente: `pulseIn(ECHO_PIN, HIGH, 30000UL)` (timeout de 30 000 µs virtuales)
expira exactamente a los **30 ms de pared**. Esto significa que "esperar N µs virtuales"
equivale a esperar N µs reales.

Sin embargo, **las instrucciones que leen registros de hardware** son órdenes de magnitud
más lentas de lo esperado:

| Operación | Tiempo virtual esperado | Tiempo real en QEMU |
|-----------|------------------------|---------------------|
| `delayMicroseconds(10)` | 10 µs | **~3 ms** |
| Una lectura de `esp_timer_get_time()` | ~1 µs | **~0.3 ms** |
| Una llamada a `digitalRead()` / `gpio_get_level()` | ~1 µs | **~0.14 ms** |

Esto se debe a que cada acceso a un registro de hardware QEMU genera un I/O trap que
el host Python debe procesar.

---

## 2. El callback `_on_dir_change(-1, -1)`

Este callback es la **pieza más importante** de toda la arquitectura de sensores GPIO.

### Cuándo se dispara

```
_on_dir_change(slot=-1, direction=-1)
```

Se llama **cada vez que el firmware hace una lectura de `GPIO_IN_REG`** — el registro
del que `gpio_get_level()` lee el estado de los pines. Esto incluye:

- `digitalRead(pin)` — Arduino API
- `gpio_get_level(pin)` — ESP-IDF API (usado internamente por `pulseIn()`)

### Por qué es útil

Cuando este callback se dispara, la CPU QEMU está **bloqueada en ese trap** — no puede
continuar ejecutando firmware hasta que el callback Python retorne. Esto nos da una
ventana para cambiar el estado de un pin **antes de que la CPU lea su valor**.

Es decir: si en `_on_dir_change(-1, -1)` llamamos a `qemu_picsimlab_set_pin(slot, 1)`,
la próxima instrucción de firmware que lea ese pin **verá el valor 1**. Es completamente
síncrono, sin carreras de datos.

### El dispatcher genérico

```python
# en _on_dir_change:
if slot == -1 and direction == -1:
    if _sync_handlers:
        _sync_handlers[:] = [h for h in _sync_handlers if not h.step()]
    return
```

La lista `_sync_handlers` contiene instancias de clases con método `step() -> bool`.
Cada vez que el firmware hace un `digitalRead()` o `gpio_get_level()`, se llama `step()`
en todos los handlers activos. Cuando `step()` devuelve `True`, el handler se elimina.

Esta arquitectura fue diseñada para **DHT22** y extendida a **HC-SR04** después de
descartar varios enfoques alternativos.

---

## 3. DHT22

### 3.1 El problema original

El sensor DHT22 usa un protocolo one-wire personalizado:
1. El firmware pone el pin en LOW durante ~20 ms (señal de inicio)
2. Suelta el pin (INPUT / pull-up → HIGH)
3. El sensor responde: ~80 µs LOW, ~80 µs HIGH, luego 40 bits de datos
4. Cada bit: ~50 µs LOW + (26 µs HIGH = 0, 70 µs HIGH = 1)
5. El firmware usa `expectPulse()` (Adafruit DHT) que llama a `digitalRead()` en un bucle
   y cuenta iteraciones LOW y HIGH para decodificar bits

Sin respuesta del sensor, el firmware imprimía `"DHT22: waiting for sensor..."` o
`"Failed to read from DHT sensor!"` indefinidamente.

### 3.2 Por qué los enfoques basados en tiempo real fallan

**Intento 1: Background thread con `time.sleep()`**

```python
# FALLIDO
def drive_dht22():
    time.sleep(0.00008)  # 80 µs
    set_pin(slot, 0)
    time.sleep(0.00008)  # 80 µs
    set_pin(slot, 1)
    # ...
```

**Fallo**: En Windows, `time.sleep()` tiene una resolución mínima de ~15.6 ms
(resolución del timer del OS). Los tiempos DHT22 son de decenas de µs — imposible
con `time.sleep()`.

**Intento 2: Busy-wait con `perf_counter_ns`**

```python
# FALLIDO
end = time.perf_counter_ns() + 80_000  # 80 µs
while time.perf_counter_ns() < end:
    pass
set_pin(slot, 0)
```

**Fallo**: El firmware Adafruit DHT usa `expectPulse()` que llama a `digitalRead()` en
un bucle contando iteraciones. Si el pin cambia en tiempo de pared "correcto" pero no
sincronizado con el bucle del firmware, el conteo de iteraciones no tiene sentido para
decodificar bits. El decodificador compara `highCycles` vs `lowCycles` — necesita que
los cambios de pin ocurran **en sincronía con las iteraciones del bucle firmware**.

### 3.3 La solución correcta: sync handler basado en conteo de syncs

La idea clave: **cada llamada a `digitalRead()` en el bucle de `expectPulse()` dispara
`_on_dir_change(-1, -1)`**. En lugar de usar tiempo real, contamos estas llamadas
(syncs) y cambiamos el pin cada N syncs.

La biblioteca Adafruit DHT decodifica bits comparando `highCycles` vs `lowCycles`.
Los valores absolutos en µs no importan — **solo importan los ratios**. Así que podemos
usar los valores de µs del protocolo DHT22 directamente como conteos de syncs:

```python
def _dht22_build_sync_phases(payload: list[int]) -> list[tuple[int, int]]:
    phases = []
    phases.append((1, 0))   # respuesta inicial LOW
    phases.append((80, 1))  # respuesta inicial HIGH (~80 µs → 80 syncs)
    for byte_val in payload:
        for b in range(7, -1, -1):
            bit = (byte_val >> b) & 1
            phases.append((50, 1))              # LOW → drive HIGH
            phases.append((70 if bit else 26, 0))  # HIGH → drive LOW
    return phases
```

Resultado: el bit `1` tiene ratio `HIGH/LOW = 70/50 = 1.4`, el bit `0` tiene `26/50 = 0.52`.
La biblioteca Adafruit DHT decodifica correctamente porque el ratio es el correcto.

### 3.4 Cuándo se arma el handler

```
Firmware:                         Backend:
  pinMode(4, OUTPUT)              _on_dir_change(slot=5, direction=1)
  digitalWrite(4, LOW)            _on_pin_change(slot=5, value=0) → saw_low=True
  delay(20ms)
  pinMode(4, INPUT)               _on_dir_change(slot=5, direction=0)
                                    → saw_low=True && !responding
                                    → build payload + phases
                                    → set_pin(slot=5, 0)   ← primer LOW inmediato
                                    → append DHT22SyncHandler(...)
  digitalRead(4) ← 0              _on_dir_change(-1, -1) → handler.step()
  digitalRead(4) ← 0              _on_dir_change(-1, -1) → handler.step()
  ...                             (handler va cambiando el pin según las fases)
```

### 3.5 Resultado

✅ **DHT22 funciona al 100%** desde esta implementación. El serial monitor muestra:
```
Temp: 28.0 C   Humidity: 65.0 %
```
Y al enviar `esp32_sensor_update` con nuevos valores, los siguientes ciclos reflejan
los valores actualizados.

---

## 4. HC-SR04

Esta es la parte compleja. El sensor HC-SR04 tardó muchos intentos fallidos antes de
encontrar la solución correcta. Se documenta cada intento con exactitud.

### 4.1 El protocolo HC-SR04

```
Firmware:                         Sensor físico:
  digitalWrite(TRIG, HIGH)
  delayMicroseconds(10)           ← sensor detecta pulso TRIG
  digitalWrite(TRIG, LOW)
  pulseIn(ECHO, HIGH, 30000)      ← espera que ECHO suba
                                    sensor: ECHO HIGH durante (distance*58) µs
                                    sensor: ECHO LOW
  ← devuelve duración en µs
  cm = duration * 0.0343 / 2
```

Si `pulseIn()` no detecta el pulso ECHO dentro del timeout (30 000 µs), devuelve 0
y el firmware imprime `"Out of range"`.

### 4.2 La función `pulseIn()` en ESP-IDF/QEMU

`pulseIn(pin, HIGH, timeout)` en ESP32 tiene 3 fases internas:

```
Fase 1: while (gpio_get_level(pin) == HIGH):  // espera a que NO sea HIGH
            if (timeout_exceeded) return 0;    // (no aplica si ECHO ya es LOW)

Fase 2: while (gpio_get_level(pin) != HIGH):  // espera a que sea HIGH
            if (timeout_exceeded) return 0;

Fase 3: startMicros = esp_timer_get_time();
        while (gpio_get_level(pin) == HIGH):  // mide duración HIGH
            if (timeout_exceeded) return 0;
        return esp_timer_get_time() - startMicros;
```

**Hallazgo crítico sobre los tiempos en QEMU:**

- `delayMicroseconds(10)` en el firmware tarda **~3 ms** de pared (10 lecturas de
  `esp_timer_get_time()`, cada una ~0.3 ms)
- El timeout de `pulseIn(ECHO, HIGH, 30000)` expira exactamente a los **30 ms** de pared
- Cada iteración de las fases 1/2/3 tarda **~0.14 ms** de pared (una lectura `gpio_get_level`)
- Los 30 000 µs de timeout = ~214 iteraciones de `gpio_get_level()`

### 4.3 Enfoque 0 — HCSR04SyncHandler con conteo de steps (igual que DHT22)

**Primer intento**: reutilizar exactamente el mismo patrón que DHT22.

```python
class HCSR04SyncHandler:
    _US_PER_STEP = 300  # µs virtuales estimados por gpio_get_level()
    
    def step(self):
        if self._state == 'armed':
            self._total_steps += 1
            if self._total_steps > self._SKIP_COUNT:
                set_pin(echo_slot, 1)  # ECHO HIGH
                self._state = 'high'
        elif self._state == 'high':
            self._high_count += 1
            if self._high_count >= self._target_steps:  # target = echo_us / 300
                set_pin(echo_slot, 0)  # ECHO LOW
                return True
```

**Problema**: Los steps disparan mucho más rápido que 300 µs por step.
Para 40 cm → echo_us=2320 µs → target_steps=7. Esos 7 steps se completaban en <1 ms
de pared. La duración real del pulso ECHO era ~0.7 ms, pero `pulseIn()` necesitaba
medir 2.32 ms. El firmware recibía `"Out of range"` al 100%.

**Diagnóstico confirmado**: El log mostraba `echo_high` y `echo_low` separados por
<1 ms en el timeline de JavaScript, mientras el serial imprimía "Out of range" 30 ms
después.

---

### 4.4 Enfoque 1 — Background thread en TRIG HIGH (¡primer éxito parcial!)

Abandonando el sync handler, se probó un background thread Python lanzado cuando
el firmware hace TRIG HIGH:

```python
elif stype == 'hc-sr04':
    if value == 1 and not sensor.get('responding', False):
        threading.Thread(target=_hcsr04_drive_echo, ...).start()
```

Con `time.sleep(0.001)` en el thread (esperar 1 ms antes de ECHO HIGH):

```python
def _hcsr04_drive_echo(trig_gpio, echo_slot, echo_us):
    time.sleep(0.001)  # 1 ms nominal, ~15.6 ms real en Windows
    set_pin(echo_slot, 1)
    # busy-wait echo_us µs
    end = perf_counter_ns() + echo_us * 1000
    while perf_counter_ns() < end:
        pass
    set_pin(echo_slot, 0)
```

**Resultado**: **6/7 lecturas correctas** en el primer test. ¡Funcionó la mayoría de veces!

**Por qué funcionaba**: `time.sleep(0.001)` en Windows duerme **~15.6 ms reales**
(resolución del timer OS). Esto colocaba ECHO HIGH ~12.6 ms después de que el firmware
hacía TRIG LOW. En ese momento `pulseIn()` llevaba ~12 ms en la fase 2 y el ECHO HIGH
era detectado correctamente.

**Por qué no era fiable**: El 15.6 ms de Windows sleep tiene varianza de ±2-3 ms
dependiendo del scheduler. Además, al lanzar el thread desde TRIG HIGH, el `delayMicroseconds(10)` del firmware (que tarda ~3 ms) ocurría DESPUÉS del thread start,
lo que significaba que a veces el ECHO HIGH llegaba antes de TRIG LOW.

**Falla**: No era determinístico y dependía de los detalles del scheduler de Windows.

---

### 4.5 Enfoque 2 — Background thread en TRIG LOW, 200 µs busy-wait

Para evitar que ECHO llegara antes de TRIG LOW, se movió el trigger al momento de TRIG LOW
y se redujo el delay a 200 µs con busy-wait:

```python
elif value == 0 and sensor.get('_trig_armed'):
    # TRIG LOW: pulseIn() está a punto de empezar
    threading.Thread(target=_hcsr04_drive_echo, ...).start()

def _hcsr04_drive_echo(...):
    # Busy-wait 200 µs
    end = perf_counter_ns() + 200_000  # 200 µs
    while perf_counter_ns() < end:
        pass
    set_pin(echo_slot, 1)  # ECHO HIGH
```

**Resultado**: **100% "Out of range"** — peor que el enfoque anterior.

**Por qué falló**: `delayMicroseconds(10)` en el firmware tarda ~3 ms de pared.
La secuencia temporal era:

```
T+0 ms:    firmware: digitalWrite(TRIG, HIGH)
T+0 ms:    → _on_pin_change: TRIG HIGH, thread armado
T+3 ms:    firmware: delayMicroseconds(10) termina
T+3 ms:    firmware: digitalWrite(TRIG, LOW)
T+3 ms:    → _on_pin_change: TRIG LOW, thread lanzado
T+3 ms:    thread start + 200 µs busy-wait
T+3.2 ms:  set_pin(echo_slot, 1)  ← ECHO HIGH ya en T+3.2 ms
T+3.2 ms:  firmware: pulseIn() todavía inicializándose...
```

El problema: `pulseIn()` empieza **después** de TRIG LOW, pero en QEMU cada instrucción
del setup de `pulseIn()` tarda ~0.3 ms. Con 200 µs de busy-wait, ECHO HIGH llegaba
cuando `pulseIn()` aún no había llegado a la fase 2. La fase 1 de `pulseIn()` (espera
a que ECHO NO sea HIGH) detectaba ECHO=1 y entraba en un bucle esperando que bajara,
consumiendo el pulso completo antes de que la fase 2 pudiera medirlo.

---

### 4.6 Enfoque 3 — QEMU thread en TRIG LOW, 0 ms delay

Para eliminar la latencia de thread start, se movió toda la lógica al propio callback
`_on_pin_change` cuando detecta TRIG LOW:

```python
elif value == 0:
    # Directo desde el QEMU thread: ECHO HIGH inmediatamente
    set_pin(echo_slot, 1)
    # Busy-wait echo_us µs
    ...
    set_pin(echo_slot, 0)
```

**Resultado**: **100% "Out of range"**.

**Por qué falló**: Exactamente el mismo problema que el enfoque anterior pero peor.
ECHO HIGH se ponía **en el mismo instante** que TRIG LOW, absolutamente antes de que
`pulseIn()` empezara. La fase 1 consumía el pulso completo.

**Diagrama del fallo**:
```
TRIG LOW → _on_pin_change → set_pin(ECHO, 1) inmediatamente
                ↓
pulseIn() inicia:
  Fase 1: while(gpio_get_level() == HIGH)  ← ECHO ya es HIGH, entra aquí
    ... espera 2.3 ms a que ECHO baje
  Fase 2: while(gpio_get_level() != HIGH)  ← ECHO ya bajó, espera HIGH
    ... timeout 30 ms → return 0
```

---

### 4.7 Enfoque 4 — Background thread en TRIG LOW, 3 ms busy-wait

Hipótesis: si `delayMicroseconds(10)` tarda ~3 ms y hay ~1-2 ms adicionales de setup
de `pulseIn()`, necesitamos esperar ~4-5 ms después de TRIG LOW para que `pulseIn()`
llegue a la fase 2.

```python
def _hcsr04_drive_echo(...):
    end = perf_counter_ns() + 3_000_000  # 3 ms busy-wait
    while perf_counter_ns() < end:
        pass
    set_pin(echo_slot, 1)
```

**Resultado**: ECHO HIGH llegaba ~4 ms después de TRIG LOW (3 ms busy-wait + ~1 ms
thread start). **Aún 100% "Out of range"**.

**Diagnóstico con el test JS**:
```
GPIO18 (TRIG) → LOW  @ +54069ms
echo_high     @ +54073ms  ← 4ms después
echo_low      @ +54075ms  ← 2ms duración (correcto para 40cm)
UART: Out of range @ +54104ms  ← 35ms después de TRIG
```

El ECHO HIGH llegaba en T+4 ms, dentro de la ventana de 30 ms. Pero `pulseIn()` aún
devolvía 0. ¿Por qué?

**Hipótesis**: Cross-thread pin propagation latency. `qemu_picsimlab_set_pin()` llamado
desde un thread Python no-QEMU podría tener latencia de visibilidad antes de que la CPU
QEMU leyera el valor. El background thread no está sincronizado con el loop principal
de QEMU.

---

### 4.8 Enfoque 5 — Background thread en TRIG LOW, 10 ms busy-wait

Basándose en que el enfoque exitoso anterior (enfoque 1) funcionaba con ~12.6 ms de
delay después de TRIG LOW, se aumentó a 10 ms:

```python
_after_trig_low = time.perf_counter_ns() + 10_000_000  # 10 ms
while time.perf_counter_ns() < _after_trig_low:
    pass
set_pin(echo_slot, 1)
```

**Resultado**: **~33% de éxito** (aprox. 1/3 de las lecturas eran correctas, 2/3 "Out of range").

**Por qué era inconsistente**: El problema fundamental del cross-thread visibility
seguía existiendo. A veces el scheduler de Windows corría el thread Python justo en
el momento correcto (cuando la CPU QEMU estaba leyendo el GPIO), otras veces no.
El 33% de éxito era básicamente ruido estadístico del scheduler del OS.

**Conclusión clave**: **Cualquier enfoque basado en background threads es fundamentalmente
no determinístico** en este contexto. `qemu_picsimlab_set_pin()` no tiene garantías de
visibilidad inmediata cuando se llama desde threads no-QEMU.

---

### 4.9 ¿`_on_dir_change(-1, -1)` se dispara para `pulseIn()`?

Antes de la solución final, había incertidumbre sobre si `_on_dir_change(-1,-1)` se
dispara para las lecturas `gpio_get_level()` dentro de `pulseIn()`.

**Evidencia empírica que confirmó que SÍ se dispara**:

Al reimplementar `HCSR04SyncHandler` con `_SKIP_COUNT=2`, el test JS mostraba:
```
GPIO18 (TRIG) → LOW  @ +46824ms
echo_high     @ +46824ms  ← mismo ms → se dispara inmediatamente
echo_low      @ +46824ms  ← mismo ms → duración casi cero
UART: Out of range
```

El handler se disparaba, pero el pulso duraba <1 ms. Esto confirmaba que
`_on_dir_change(-1,-1)` SÍ se dispara para `pulseIn()`.

El nuevo problema: con `_MAX_GUARD = 300 steps` y steps disparando a ~0.14 ms/step,
300 steps = ~42 ms > 30 ms timeout. Parecía suficiente, pero el error era más sutil:
la fase 'high' se medía con `self._high_count >= self._target_steps` donde
`target_steps = echo_us // 300`. Para 40 cm: `2320 // 300 = 7 steps`. Esos 7 steps
terminaban en <1 ms, mucho menos que los 2.32 ms reales necesarios.

---

### 4.10 La solución correcta — `HCSR04SyncHandler` con guards por tiempo de pared

**Insight final**: Para el comportamiento HIGH, no debemos contar steps — debemos medir
tiempo de pared, igual que haría el firmware midiendo tiempo virtual. Dado que
virtual ≈ wall-clock (confirmado), esperar `echo_us` µs de pared es equivalente a
esperar `echo_us` µs virtuales.

```python
class HCSR04SyncHandler:
    _SKIP_COUNT       = 2         # callbacks pre-fase2 a ignorar
    _ARMED_TIMEOUT_US = 40_000    # 40 ms: guard si nunca entramos en 'high'
    _HIGH_TIMEOUT_US  = 32_000    # 32 ms: guard si ECHO > timeout de pulseIn()
    
    def step(self) -> bool:
        self._total_steps += 1
        
        if self._state == 'armed':
            if self._total_steps <= self._SKIP_COUNT:
                return False  # skip fase-1 + micros() pre-read
            
            arm_us = (perf_counter_ns() - self._arm_start_ns) // 1000
            if arm_us > self._ARMED_TIMEOUT_US:
                # Nunca llegamos a fase 2 → liberar
                return True
            
            # Fase 2 de pulseIn() activa → ECHO HIGH
            set_pin(self._echo_slot, 1)
            self._echo_start_ns = perf_counter_ns()
            self._state = 'high'
            return False
        
        elif self._state == 'high':
            elapsed_us = (perf_counter_ns() - self._echo_start_ns) // 1000
            if elapsed_us >= self._echo_us:
                return self._finish(elapsed_us)  # ECHO LOW
            if elapsed_us >= self._HIGH_TIMEOUT_US:
                set_pin(self._echo_slot, 0)  # safety: nunca bloquear más que pulseIn timeout
                return True
        
        return False
```

**Por qué funciona esta vez**:

1. **Skip de 2 callbacks**: La fase 1 de `pulseIn()` hace 1 llamada `gpio_get_level()`
   (ECHO es LOW → sale inmediatamente). Puede haber 1 lectura adicional de `micros()`.
   Saltamos esas 2 iteraciones para no poner ECHO HIGH demasiado pronto.

2. **ECHO HIGH en el 3er callback**: Ese es el primer `gpio_get_level()` de la fase 2.
   `qemu_picsimlab_set_pin()` es **síncrono con el QEMU thread** (estamos EN el
   QEMU thread, no en un thread externo). La CPU QEMU lee el valor inmediatamente.
   `pulseIn()` ve ECHO=1 y transiciona a la fase 3.

3. **Duración medida en wall-clock**: La fase 3 llama `gpio_get_level()` repetidamente.
   Cada llamada dispara `step()`. Simplemente esperamos `echo_us` µs de pared.
   Como virtual ≈ wall-clock, `pulseIn()` mide exactamente `echo_us` µs virtuales.

4. **Guards por tiempo, no por steps**: Los guards usan `perf_counter_ns()`, no conteos
   de steps. Esto funciona correctamente para cualquier distancia
   (10 cm = 580 µs, 200 cm = 11 600 µs).

---

### 4.11 Resultados de la solución final

Test end-to-end con 4 distancias:

```
sent=40 cm  → received=40 cm  ✓ (delta=0)
sent=40 cm  → received=39 cm  ✓ (delta=1)
sent=40 cm  → received=40 cm  ✓ (delta=0)
sent=100 cm → received=100 cm ✓ (delta=1)
sent=100 cm → received=101 cm ✓ (delta=2)
sent=100 cm → received=100 cm ✓ (delta=1)
sent=10 cm  → received=10 cm  ✓ (delta=0)
sent=10 cm  → received=11 cm  ✓ (delta=1)
sent=10 cm  → received=10 cm  ✓ (delta=0)
sent=200 cm → received=200 cm ✓ (delta=1)
sent=200 cm → received=199 cm ✓ (delta=1)
sent=200 cm → received=200 cm ✓ (delta=1)

✓ PASS — 12/12 lecturas dentro de ±15 cm, 4 distancias, miss rate 0%
```

---

## 5. Arquitectura final

### 5.1 Registro de handlers

```python
_sync_handlers: list = []
```

Lista mutable compartida. Todas las mutaciones ocurren en el QEMU thread
(dentro de `_on_dir_change`). No se necesitan locks.

### 5.2 Dispatcher

```python
# En _on_dir_change(slot=-1, direction=-1):
if _sync_handlers:
    _sync_handlers[:] = [h for h in _sync_handlers if not h.step()]
return
```

La asignación in-place `[:]` muta el mismo objeto lista (seguro para appends
concurrentes desde código de armado). La list comprehension filtra handlers terminados.

### 5.3 DHT22SyncHandler

Maneja la señal one-wire del DHT22 contando syncs por fase:

- `step()` incrementa un contador
- Cuando el contador alcanza el target de la fase actual, cambia el pin y avanza a la siguiente fase
- Los ratios de syncs preservan correctamente la codificación de bits Adafruit DHT

**Armado**: en `_on_dir_change` cuando el pin pasa a INPUT (firmware soltó el bus).

### 5.4 HCSR04SyncHandler

Maneja el pulso ECHO del HC-SR04 usando wall-clock para duración:

- `'armed'`: primeros `_SKIP_COUNT` steps ignorados, luego ECHO HIGH
- `'high'`: ECHO HIGH hasta que `elapsed_us >= echo_us`
- Guards: `_ARMED_TIMEOUT_US` y `_HIGH_TIMEOUT_US` en µs de pared

**Armado**: en `_on_pin_change` cuando TRIG baja (TRIG LOW).

### 5.5 Diagrama de flujo completo HC-SR04

```
Firmware                      Backend (_on_pin_change / _on_dir_change)

digitalWrite(TRIG, HIGH)  →   TRIG HIGH: guarda echo_slot, echo_us en sensor dict
delayMicroseconds(10)         (3ms wall-clock)
digitalWrite(TRIG, LOW)   →   TRIG LOW: append HCSR04SyncHandler → _sync_handlers
                              sensor['responding'] = True

pulseIn(ECHO, HIGH, 30000):
  Fase 1:
    gpio_get_level(ECHO)  →   _on_dir_change(-1,-1) → handler.step()
                              step 1: total_steps=1 ≤ SKIP_COUNT=2 → skip
    (ECHO=0, sale)

  Fase 2:
    gpio_get_level(ECHO)  →   _on_dir_change(-1,-1) → handler.step()
                              step 2: total_steps=2 ≤ SKIP_COUNT=2 → skip
    gpio_get_level(ECHO)  →   _on_dir_change(-1,-1) → handler.step()
                              step 3: total_steps=3 > SKIP_COUNT
                              → qemu_picsimlab_set_pin(echo_slot, 1)  ← ECHO HIGH
                              → state='high', echo_start_ns=now
    (ECHO=1, sale)

  Fase 3 (mide duración HIGH):
    gpio_get_level(ECHO)  →   _on_dir_change(-1,-1) → handler.step()
                              elapsed_us < echo_us → continuar
    gpio_get_level(ECHO)  →   ... (repite)
    ...
    gpio_get_level(ECHO)  →   elapsed_us >= echo_us
                              → qemu_picsimlab_set_pin(echo_slot, 0)  ← ECHO LOW
                              → sensor['responding']=False
                              → step() returns True → handler eliminado
  (ECHO=0, sale)
  return (now - startMicros)  ← duración medida correctamente
```

---

## 6. Tests end-to-end

### 6.1 DHT22 — `backend/test_dht22_simulation.mjs`

```bash
cd backend
node test_dht22_simulation.mjs [--timeout=45] [--backend=http://localhost:8001]
```

**Qué verifica**:
1. Compila el sketch DHT22 vía `POST /api/compile/`
2. Conecta WebSocket y envía `start_esp32` con `sensors: [{sensor_type:'dht22', pin:4, temperature:28, humidity:65}]`
3. Espera líneas `"Temp: 28.0 C   Humidity: 65.0 %"` en serial
4. Envía `esp32_sensor_update` con `{pin:4, temperature:35, humidity:80}`
5. Verifica que las siguientes lecturas muestren 35°C

**Fix importante en el test**: Serial output llega fragmentado (chunked). La primera
implementación del test usaba `text.split('\n')` sobre cada mensaje WebSocket, lo que
nunca encontraba líneas completas. La solución fue acumular en un buffer:

```javascript
let _lineBuf = '';
// En handler de serial_output:
_lineBuf += data?.data ?? '';
let nl;
while ((nl = _lineBuf.indexOf('\n')) !== -1) {
  const line = _lineBuf.slice(0, nl).replace(/\r$/, '');
  _lineBuf = _lineBuf.slice(nl + 1);
  // procesar línea completa...
}
```

### 6.2 HC-SR04 — `backend/test_hcsr04_simulation.mjs`

```bash
cd backend
node test_hcsr04_simulation.mjs [--timeout=60] [--backend=http://localhost:8001]
```

**Qué verifica**:
1. Compila el sketch HC-SR04 vía `POST /api/compile/`
2. Conecta WebSocket y envía `start_esp32` con `sensors: [{sensor_type:'hc-sr04', pin:18, echo_pin:19, distance:40}]`
3. Espera lecturas `"Distance: N cm"` en serial
4. Cicla por 4 distancias: 40 cm, 100 cm, 10 cm, 200 cm
5. Envía `esp32_sensor_update` con `{pin:18, distance:X}` para cada una
6. Verifica que los valores sean correctos (±15 cm de tolerancia)

**Criterio de PASS**: ≥3 lecturas correctas, ≥2 distancias únicas, miss rate ≤30%.

**Fix en el test (bug del timer)**: La primera versión usaba `if (readingsAtCurrent >= 2) scheduleAdvance(800)`.
Como las lecturas llegan cada 500 ms, `scheduleAdvance` se llamaba en cada lectura después
de la 2ª, reiniciando el timer 800 ms continuamente → el avance nunca ocurría.
Fix: `if (readingsAtCurrent === 2) scheduleAdvance(800)` (solo en exactamente la 2ª lectura).

---

## 7. Cómo añadir un nuevo sensor GPIO-timed

Un sensor "GPIO-timed" es cualquier sensor cuya comunicación consiste en cambios de pin
que el firmware detecta con `digitalRead()`, `pulseIn()`, o similar.

### Pasos

**1. Crear la clase handler** (dentro de `main()` en `esp32_worker.py`):

```python
class MiSensorSyncHandler:
    def __init__(self, gpio: int, slot: int, ...params...) -> None:
        self._gpio  = gpio
        self._slot  = slot
        # ... inicializar estado

    def step(self) -> bool:
        """
        Llamado en cada gpio_get_level() del firmware.
        Retorna True cuando el handler ha terminado (se elimina de _sync_handlers).
        """
        # ... lógica de estado
        # Usar lib.qemu_picsimlab_set_pin(self._slot, 0/1) para cambiar el pin
        # Usar time.perf_counter_ns() para medir tiempo de pared
        # Retornar True cuando terminado, False para continuar
        return False
```

**2. Armar el handler** desde `_on_pin_change` o `_on_dir_change`:

```python
elif stype == 'mi-sensor':
    if value == CONDICION_TRIGGER:
        _sync_handlers.append(MiSensorSyncHandler(gpio, slot, ...params...))
        sensor['responding'] = True
```

**3. No tocar `_on_dir_change`**: El dispatcher genérico ya maneja todos los handlers
automáticamente. No hay que cambiar nada más.

### Reglas importantes

- **Siempre usar `time.perf_counter_ns()`** para medir duración, no conteo de steps
  (los steps tienen velocidad variable según carga de QEMU)
- **Siempre tener un guard de timeout** para evitar que el sensor quede bloqueado
  si el firmware no hace más `digitalRead()`
- **`sensor['responding'] = False`** al terminar, para que el siguiente ciclo se procese
- **Toda la lógica de pin-driving es síncrona** con el QEMU thread — no necesita locks

---

## 8. Referencia rápida

### Tiempos empíricos en QEMU (ESP32, lcgamboa fork)

| Operación firmware | Tiempo real (wall-clock) |
|--------------------|--------------------------|
| `delayMicroseconds(10)` | ~3 ms |
| Un `digitalRead()` / `gpio_get_level()` | ~0.14 ms |
| Una lectura `esp_timer_get_time()` | ~0.3 ms |
| `pulseIn(pin, HIGH, 30000)` timeout | exactamente 30 ms |
| Virtual time : wall-clock ratio | ≈ 1:1 |

### Constantes de los handlers

| Handler | Constante | Valor | Significado |
|---------|-----------|-------|-------------|
| HCSR04SyncHandler | `_SKIP_COUNT` | 2 | Callbacks iniciales a ignorar |
| HCSR04SyncHandler | `_ARMED_TIMEOUT_US` | 40 000 µs | Guard: máx espera en estado 'armed' |
| HCSR04SyncHandler | `_HIGH_TIMEOUT_US` | 32 000 µs | Guard: máx duración ECHO HIGH |
| DHT22SyncHandler | — | — | No usa timeouts, solo conteo de syncs |

### Fórmula echo_us

```python
echo_us = max(100, int(distance_cm * 58))
# Ejemplo: 40 cm → 2320 µs, 100 cm → 5800 µs, 200 cm → 11600 µs
```

### Pinmap (slot ↔ GPIO)

```python
slot = gpio_num + 1
# GPIO4  → slot 5  (DHT22 DATA)
# GPIO18 → slot 19 (HC-SR04 TRIG)
# GPIO19 → slot 20 (HC-SR04 ECHO)
```

### Resumen de enfoques HC-SR04 y su resultado

| Enfoque | Resultado | Razón del fallo |
|---------|-----------|-----------------|
| Sync handler + conteo de steps | 0% | Steps demasiado rápidos, pulso dura <1 ms |
| Background thread en TRIG HIGH + 1ms sleep | 6/7 (85%) | `time.sleep(0.001)` → 15.6 ms en Windows, no determinístico |
| QEMU thread en TRIG LOW, 0 ms | 0% | ECHO HIGH antes de que pulseIn() empiece fase 2 |
| Background thread en TRIG LOW + 200 µs busy | 0% | Igual: ECHO HIGH antes de fase 2 (delayMicroseconds dura 3ms) |
| Background thread en TRIG LOW + 3 ms busy | 0% | Cross-thread pin visibility, ECHO no visto por QEMU |
| Background thread en TRIG LOW + 10 ms busy | ~33% | Cross-thread pin visibility, no determinístico |
| **Sync handler + wall-clock en `_sync_handlers`** | **100%** | **Síncrono con QEMU thread, timing preciso** |
