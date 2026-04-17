# ESP32-C3 WiFi & Bluetooth Emulation

El ESP32-C3 (RISC-V) comparte la misma infraestructura de emulación WiFi/BLE que el ESP32 Xtensa. QEMU ejecuta `qemu-system-riscv32` con el NIC model `esp32c3_wifi` y la misma red slirp aislada.

## Tabla de Contenidos

- [Diferencias con ESP32 Xtensa](#diferencias-con-esp32-xtensa)
- [Arquitectura](#arquitectura)
- [Boards Soportados](#boards-soportados)
- [Cómo Usar](#cómo-usar)
- [Ejemplos](#ejemplos)
  - [1. WiFi Scan](#1-wifi-scan)
  - [2. WiFi Connect](#2-wifi-connect)
  - [3. HTTP WebServer](#3-http-webserver)
  - [4. BLE Advertise](#4-ble-advertise)
- [Configuración de Red](#configuración-de-red)
- [Limitaciones](#limitaciones)
- [Archivos Relevantes](#archivos-relevantes)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Diferencias con ESP32 Xtensa

| Aspecto | ESP32 (Xtensa) | ESP32-C3 (RISC-V) |
|---------|----------------|---------------------|
| Arquitectura CPU | Xtensa LX6 dual-core | RISC-V RV32IMC single-core |
| QEMU binary | `qemu-system-xtensa` | `qemu-system-riscv32` |
| QEMU machine | `esp32-picsimlab` | `esp32c3-picsimlab` |
| Shared library | `libqemu-xtensa` | `libqemu-riscv32` |
| NIC model | `esp32_wifi` | `esp32c3_wifi` |
| GPIO count | 40 | 22 |
| Bluetooth | BLE 4.2 + Classic BT | BLE 5.0 solamente (sin Classic BT) |
| FQBN | `esp32:esp32:esp32` | `esp32:esp32:esp32c3` |
| WiFi API | Idéntica | Idéntica |
| Red virtual | 192.168.4.0/24 | 192.168.4.0/24 |
| SSID | Velxio-GUEST | Velxio-GUEST |

**Lo que es igual**: SSID, red, AP list, WiFi API (ESP-IDF), serial log format, IoT Gateway, status UI icons.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND                              │
│                                                         │
│  Esp32Bridge('board-c3', 'esp32-c3')                    │
│    → wifiEnabled = true (auto-detected)                 │
│    → start_esp32 { board: 'esp32-c3', wifi_enabled: true } │
│    → onWifiStatus / onBleStatus callbacks               │
└────────────────────┬────────────────────────────────────┘
                     │ WebSocket
┌────────────────────┼────────────────────────────────────┐
│                BACKEND                                   │
│                    │                                     │
│  simulation.py → esp32_worker.py                         │
│    → qemu-system-riscv32 -M esp32c3-picsimlab            │
│    → -nic user,model=esp32c3_wifi,net=192.168.4.0/24    │
│    → hostfwd=tcp::{port}-192.168.4.15:80                 │
│                    │                                     │
│  wifi_status_parser.py (same ESP-IDF log format)         │
│  iot_gateway.py (board-agnostic proxy)                   │
└────────────────────┼────────────────────────────────────┘
                     │
┌────────────────────┼────────────────────────────────────┐
│         QEMU (qemu-system-riscv32)                       │
│                                                          │
│  esp32c3_wifi.c → DMA WiFi MAC layer (C3-specific regs) │
│  esp32_wifi_ap.c → Shared AP list:                       │
│    • Velxio-GUEST (ch 6, -20 dBm)                       │
│    • PICSimLabWifi, Espressif, MasseyWifi                │
│                                                          │
│  Slirp NAT: 192.168.4.0/24, ESP32-C3 = 192.168.4.15     │
└──────────────────────────────────────────────────────────┘
```

---

## Boards Soportados

| Board | BoardKind | FQBN |
|-------|-----------|------|
| ESP32-C3 DevKit | `esp32-c3` | `esp32:esp32:esp32c3` |
| XIAO ESP32-C3 | `xiao-esp32-c3` | `esp32:esp32:XIAO_ESP32C3` |
| ESP32-C3 SuperMini | `aitewinrobot-esp32c3-supermini` | `esp32:esp32:esp32c3` |

Todos los variantes se mapean a `'esp32-c3'` internamente para QEMU.

---

## Cómo Usar

1. **Selecciona un board ESP32-C3** en el selector de boards
2. **Escribe tu sketch** usando `#include <WiFi.h>` con SSID `"Velxio-GUEST"`
3. **Presiona Run** — WiFi se activa automáticamente al detectar el include
4. **Mira el Serial Monitor** — verás los logs ESP-IDF de conexión WiFi
5. **Observa el ícono WiFi** en el canvas (verde cuando conectado)

La API WiFi de Arduino/ESP-IDF es **idéntica** entre ESP32 y ESP32-C3. El mismo código funciona en ambos.

---

## Ejemplos

### 1. WiFi Scan

Escanea redes WiFi disponibles. Verás "Velxio-GUEST" en los resultados.

```cpp
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  int n = WiFi.scanNetworks();
  Serial.printf("Found %d networks:\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  %d: %s (%d dBm)\n", i+1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  }
}

void loop() { delay(10000); setup(); }
```

### 2. WiFi Connect

Conecta a Velxio-GUEST y muestra la IP asignada.

```cpp
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  Serial.print("Connecting to Velxio-GUEST");
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" Connected!");
  Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
}

void loop() { delay(5000); }
```

### 3. HTTP WebServer

Servidor web accesible desde el navegador vía IoT Gateway.

```cpp
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void setup() {
  Serial.begin(115200);
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) delay(100);

  server.on("/", []() {
    server.send(200, "text/html", "<h1>Hello from ESP32-C3!</h1>");
  });
  server.begin();
  Serial.printf("Server at: http://%s/\n", WiFi.localIP().toString().c_str());
}

void loop() { server.handleClient(); }
```

### 4. BLE Advertise

Inicializa BLE 5.0 y comienza advertising (detección solamente).

```cpp
#include <BLEDevice.h>
#include <BLEServer.h>

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32-C3 supports BLE 5.0 only (no Classic BT)");

  BLEDevice::init("Velxio-ESP32C3");
  BLEServer *pServer = BLEDevice::createServer();
  BLEAdvertising *pAdv = BLEDevice::getAdvertising();
  pAdv->start();
  Serial.println("BLE advertising started");
}

void loop() { delay(2000); }
```

> **Nota**: BLE se inicializa correctamente pero la comunicación real no está emulada.

---

## Configuración de Red

Idéntica al ESP32 Xtensa:

| Parámetro | Valor |
|-----------|-------|
| SSID | `Velxio-GUEST` |
| Contraseña | *(vacía)* |
| Canal | 6 |
| Subred | `192.168.4.0/24` |
| IP ESP32-C3 | `192.168.4.15` |
| Gateway | `192.168.4.2` |

---

## Limitaciones

### WiFi (mismas que ESP32 Xtensa)
- **SSID fijo**: solo `"Velxio-GUEST"` (sin contraseña)
- **Sin ICMP (ping)**: limitación de slirp
- **Sin modo AP**: solo Station (STA)
- **Puerto HTTP 80**: hostfwd solo mapea al puerto 80

### Bluetooth / BLE
- **Solo BLE 5.0**: el ESP32-C3 no tiene Classic Bluetooth (sin SPP, A2DP)
- **Solo detección**: `BLEDevice::init()` funciona, pero no hay comunicación BLE real
- **Sin VHCI**: el fork de QEMU no implementa Virtual HCI

### Específicas de C3
- **22 GPIO** (vs 40 del ESP32): algunos pines no están disponibles
- **Single-core**: no hay `xTaskCreatePinnedToCore()` con core 1
- **`BluetoothSerial.h` no disponible**: C3 no soporta Classic BT

---

## Archivos Relevantes

### QEMU (C3-specific)
- `wokwi-libs/qemu-lcgamboa/hw/misc/esp32c3_wifi.c` — WiFi MAC layer C3 (DMA registers)
- `wokwi-libs/qemu-lcgamboa/include/hw/misc/esp32c3_wifi.h` — C3 register offsets
- `wokwi-libs/qemu-lcgamboa/hw/misc/esp32_wifi_ap.c` — AP list compartida (Velxio-GUEST)
- `wokwi-libs/qemu-lcgamboa/hw/riscv/esp32c3_picsimlab.c` — C3 machine definition

### Backend
- `backend/app/services/esp32_worker.py` — Selecciona `esp32c3_wifi` NIC model
- `backend/app/services/esp_qemu_manager.py` — Mapea `esp32-c3` → `qemu-system-riscv32`
- `backend/app/services/wifi_status_parser.py` — Parser serial (compartido, mismo formato)
- `backend/app/api/routes/iot_gateway.py` — Proxy HTTP (board-agnostic)

### Frontend
- `frontend/src/simulation/Esp32Bridge.ts` — `toQemuBoardType()` mapea C3 variants
- `frontend/src/store/useSimulatorStore.ts` — `ESP32_RISCV_KINDS` set, WiFi auto-detect
- `frontend/src/data/examples.ts` — 4 ejemplos C3 WiFi/BLE

---

## Tests

### Frontend

```bash
cd frontend
npx vitest run src/__tests__/esp32c3-wifi-bluetooth.test.ts
```

**29 tests**: bridge WiFi flag, C3 variant mapping, WiFi/BLE status events, auto-detection, BLE detection, FQBN mapping, QEMU NIC config.

### Backend

```bash
cd backend
python -m pytest tests/test_esp32c3_wifi.py -v
```

**18 tests**: RISC-V binary, C3 machine name, NIC model `esp32c3_wifi`, hostfwd, serial parser, port allocation, QEMU manager mapping.

---

## Troubleshooting

### La compilación falla para ESP32-C3

- **ESP-IDF (producción)**: Los sketches ESP32-C3 se compilan con ESP-IDF 4.4.7 (`IDF_TARGET=esp32c3`). El backend traduce Arduino WiFi/WebServer a ESP-IDF C nativo.
- **Fallback arduino-cli**: `arduino-cli core install esp32:esp32@2.0.17` (incluye soporte C3).

### WiFi no se activa
- Verifica que tu sketch incluya `#include <WiFi.h>`
- Usa SSID `"Velxio-GUEST"` sin contraseña

### `BluetoothSerial.h` no compila
El ESP32-C3 no soporta Classic Bluetooth. Usa `BLEDevice.h` en su lugar.

### Error "qemu-system-riscv32 not found"
El backend necesita `libqemu-riscv32` compilada. Ejecuta `build_libqemu-esp32.sh` para compilar.

### Diferencia de pines con ESP32
El C3 tiene 22 GPIO (0-21). Los pines del ESP32 estándar (25-39) no existen en C3. Usa GPIO 8 para LED built-in.
