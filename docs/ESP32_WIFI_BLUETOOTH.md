# ESP32 WiFi & Bluetooth Emulation

Velxio emula WiFi y Bluetooth (BLE) en el ESP32 usando el fork de QEMU de lcgamboa con soporte de red slirp. Cada instancia de emulación obtiene su propia red NAT aislada — ideal para múltiples usuarios simultáneos.

## Tabla de Contenidos

- [Arquitectura General](#arquitectura-general)
- [Cómo Funciona](#cómo-funciona)
  - [Red WiFi Virtual](#red-wifi-virtual)
  - [Detección Automática de WiFi](#detección-automática-de-wifi)
  - [Flujo de Estado WiFi](#flujo-de-estado-wifi)
  - [IoT Gateway (Servidor HTTP)](#iot-gateway-servidor-http)
  - [Bluetooth Low Energy (BLE)](#bluetooth-low-energy-ble)
- [Cómo Usar](#cómo-usar)
  - [WiFi Básico](#wifi-básico)
  - [Servidor HTTP](#servidor-http)
  - [BLE Advertise](#ble-advertise)
- [Ejemplos Completos](#ejemplos-completos)
  - [1. WiFi Scan](#1-wifi-scan)
  - [2. WiFi Connect](#2-wifi-connect)
  - [3. HTTP WebServer](#3-http-webserver)
  - [4. BLE Advertise](#4-ble-advertise)
- [Indicadores Visuales en el Editor](#indicadores-visuales-en-el-editor)
- [Configuración de Red](#configuración-de-red)
- [Limitaciones](#limitaciones)
- [Archivos Modificados / Creados](#archivos-modificados--creados)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Arquitectura General

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                         │
│                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────┐ │
│  │ Monaco Editor│   │ SimulatorCanvas│  │  Serial Monitor       │ │
│  │ (sketch.ino)│   │ WiFi/BLE icons│  │  (ESP-IDF logs)       │ │
│  └──────┬──────┘   └──────┬───────┘  └──────────┬────────────┘ │
│         │                  │                      │              │
│  ┌──────┴──────────────────┴──────────────────────┴────────────┐ │
│  │              useSimulatorStore (Zustand)                     │ │
│  │  - WiFi auto-detection from sketch content                  │ │
│  │  - wifiStatus / bleStatus per board                         │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         │                                        │
│  ┌──────────────────────┴──────────────────────────────────────┐ │
│  │              Esp32Bridge (WebSocket)                         │ │
│  │  - wifiEnabled flag en start_esp32 payload                  │ │
│  │  - onWifiStatus / onBleStatus callbacks                     │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
└─────────────────────────┼────────────────────────────────────────┘
                          │ WebSocket
┌─────────────────────────┼────────────────────────────────────────┐
│                     BACKEND (FastAPI)                             │
│                         │                                        │
│  ┌──────────────────────┴──────────────────────────────────────┐ │
│  │          simulation.py (WebSocket handler)                   │ │
│  │  - Lee wifi_enabled del payload                              │ │
│  │  - Asigna puerto dinámico para hostfwd                       │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         │                                        │
│  ┌──────────────────────┴──────────────────────────────────────┐ │
│  │     esp32_worker.py / esp_qemu_manager.py                    │ │
│  │  - Lanza QEMU con -nic user,model=esp32_wifi,...             │ │
│  │  - Captura serial output (UART0)                             │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         │                                        │
│  ┌──────────────────────┴──────────┐  ┌────────────────────────┐ │
│  │   wifi_status_parser.py         │  │  iot_gateway.py        │ │
│  │  - Parsea logs ESP-IDF          │  │  - Proxy HTTP reverso  │ │
│  │  - Emite wifi_status/ble_status │  │  - Browser → ESP32:80  │ │
│  └─────────────────────────────────┘  └────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────────────────────┐
│                  QEMU (lcgamboa fork)                            │
│                         │                                        │
│  ┌──────────────────────┴──────────────────────────────────────┐ │
│  │  esp32_wifi_ap.c — Access Points emulados:                   │ │
│  │    • "Velxio-GUEST"  (ch 6, -20 dBm, open)                  │ │
│  │    • "PICSimLabWifi" (ch 1, -25 dBm)                        │ │
│  │    • "Espressif"     (ch 5, -30 dBm)                        │ │
│  │    • "MasseyWifi"    (ch 10, -40 dBm)                       │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │  Slirp (user-mode NAT)                                       │ │
│  │    • Red: 192.168.4.0/24                                     │ │
│  │    • ESP32 IP: 192.168.4.15 (static, matches slirp DHCP)      │ │
│  │    • Gateway: 192.168.4.2                                     │ │
│  │    • Internet: acceso completo vía NAT del host              │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cómo Funciona

### Red WiFi Virtual

Cada instancia de QEMU ejecuta su propia red WiFi emulada usando **slirp** (user-mode networking):

- **Sin configuración de red del host** — no requiere TAP, bridge, ni permisos de administrador
- **Aislamiento por usuario** — cada sesión de emulación tiene su propia red `192.168.4.0/24`
- **Acceso a internet** — el ESP32 emulado puede hacer peticiones HTTP, DNS, etc. vía NAT del host
- **SSID principal**: `Velxio-GUEST` (canal 6, abierto, sin contraseña)

QEMU emula la capa MAC 802.11 completa: beacons, scan, asociación y DHCP. El firmware ESP-IDF del ESP32 interactúa con el hardware WiFi emulado exactamente como lo haría con hardware real.

### Detección Automática de WiFi

Cuando presionas "Run" en el editor, Velxio escanea automáticamente tu código buscando patrones WiFi:

```typescript
// Patrones detectados:
'#include <WiFi.h>'
'#include <esp_wifi.h>'
'#include "WiFi.h"'
'WiFi.begin('
```

Si se detecta cualquiera de estos, se activa `wifi_enabled=true` automáticamente — no necesitas configurar nada.

### Flujo de Estado WiFi

```
Sketch ejecuta WiFi.begin("Velxio-GUEST", "")
         │
         ▼
QEMU UART0: "I (432) wifi:wifi sta start"
         │
         ▼
Backend: wifi_status_parser → { status: "initializing" }
         │
         ▼
WebSocket → Frontend: wifi_status event
         │
         ▼
QEMU UART0: "I (800) wifi:connected with Velxio-GUEST, aid = 1"
         │
         ▼
Backend: { status: "connected", ssid: "Velxio-GUEST" }
         │
         ▼
QEMU UART0: "I (1200) esp_netif_handlers: sta ip: 192.168.4.15"
         │
         ▼
Backend: { status: "got_ip", ip: "192.168.4.15" }
         │
         ▼
SimulatorCanvas: ícono WiFi cambia a verde ✓
```

### IoT Gateway (Servidor HTTP)

Cuando tu sketch ejecuta un WebServer en el ESP32, Velxio crea un proxy HTTP reverso para que puedas acceder desde tu navegador:

1. QEMU inicia con `hostfwd=tcp::{puerto}-192.168.4.15:80`
2. El backend asigna un puerto dinámico libre
3. Un proxy en `/api/gateway/{client_id}/` reenvía peticiones al ESP32
4. Tu navegador puede interactuar con el servidor del ESP32

```
Browser → http://localhost:8001/api/gateway/board-1/
       → Proxy → http://127.0.0.1:{hostfwd_port}/
       → QEMU → ESP32 WebServer (192.168.4.15:80)
       → "<h1>Hola desde ESP32 🚀</h1>"
```

### Bluetooth Low Energy (BLE)

Velxio detecta el uso de BLE en tu sketch y muestra el estado de inicialización:

```typescript
// Patrones BLE detectados:
'#include <BLEDevice.h>'
'#include <esp_bt.h>'
'BLEDevice::init('
```

El estado BLE se muestra en el canvas del simulador (ícono Bluetooth azul).

> **Nota**: BLE es solo detección — el firmware inicializa BLE correctamente pero la comunicación BLE real (scan, connect, notify) no está emulada. Esto se debe a que el fork de QEMU de lcgamboa no implementa VHCI (Virtual HCI controller).

---

## Cómo Usar

### WiFi Básico

1. **Escribe tu sketch** usando `#include <WiFi.h>`
2. **Usa el SSID `Velxio-GUEST`** (sin contraseña)
3. **Presiona Run** — WiFi se activa automáticamente
4. **Observa el Serial Monitor** — verás los logs de conexión ESP-IDF
5. **Mira el ícono WiFi** en el canvas del simulador

```cpp
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.begin("Velxio-GUEST", "");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConectado!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  delay(1000);
}
```

**Salida esperada en Serial Monitor:**
```
I (432) wifi:wifi sta start
I (500) wifi:new:Velxio-GUEST, old: , ASSOC
I (800) wifi:connected with Velxio-GUEST, aid = 1, channel 6
I (1200) esp_netif_handlers: sta ip: 192.168.4.15, mask: 255.255.255.0
...
Conectado!
IP: 192.168.4.15
```

### Servidor HTTP

```cpp
#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Velxio-GUEST";
const char* password = "";

WebServer server(80);

void handleRoot() {
  server.send(200, "text/html", "<h1>Hola desde ESP32 🚀</h1>");
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  Serial.print("Conectando");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConectado!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Servidor HTTP iniciado");
}

void loop() {
  server.handleClient();
}
```

Una vez que el Serial Monitor muestre "Servidor HTTP iniciado", puedes acceder al servidor del ESP32 a través del IoT Gateway.

### BLE Advertise

```cpp
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

void setup() {
  Serial.begin(115200);
  BLEDevice::init("Velxio-ESP32");
  BLEServer *pServer = BLEDevice::createServer();
  BLEAdvertising *pAdv = BLEDevice::getAdvertising();
  pAdv->start();
  Serial.println("BLE advertising started");
}

void loop() {
  delay(2000);
}
```

> BLE se inicializa correctamente, pero no hay comunicación BLE real emulada.

---

## Ejemplos Completos

Velxio incluye 4 ejemplos pre-cargados accesibles desde la galería de ejemplos:

### 1. WiFi Scan

Escanea las redes WiFi disponibles en el entorno emulado.

```cpp
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  int n = WiFi.scanNetworks();
  Serial.println("Networks found:");
  for (int i = 0; i < n; i++) {
    Serial.printf("%d: %s (%d dBm)\n", i+1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  }
}

void loop() { delay(10000); }
```

**Salida esperada:**
```
Networks found:
1: Velxio-GUEST (-20 dBm)
2: PICSimLabWifi (-25 dBm)
3: Espressif (-30 dBm)
4: MasseyWifi (-40 dBm)
```

### 2. WiFi Connect

Conecta a `Velxio-GUEST` y muestra la información de red.

```cpp
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  Serial.print("Connecting to WiFi");
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    Serial.print(".");
  }
  Serial.println(" Connected!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void loop() { delay(1000); }
```

### 3. HTTP WebServer

Servidor web completo accesible desde el navegador vía IoT Gateway.

```cpp
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void setup() {
  Serial.begin(115200);
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) delay(100);
  server.on("/", []() {
    server.send(200, "text/html", "<h1>Hello from ESP32!</h1>");
  });
  server.begin();
  Serial.print("Server at: ");
  Serial.println(WiFi.localIP());
}

void loop() { server.handleClient(); }
```

### 4. BLE Advertise

Inicializa BLE y comienza advertising (detección solamente).

```cpp
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

void setup() {
  Serial.begin(115200);
  BLEDevice::init("Velxio-ESP32");
  BLEServer *pServer = BLEDevice::createServer();
  BLEAdvertising *pAdv = BLEDevice::getAdvertising();
  pAdv->start();
  Serial.println("BLE advertising started");
}

void loop() { delay(2000); }
```

---

## Indicadores Visuales en el Editor

El canvas del simulador muestra íconos de estado para WiFi y BLE junto al board ESP32:

### Ícono WiFi

| Color | Estado | Significado |
|-------|--------|-------------|
| Gris | — | WiFi no activo (sketch sin WiFi) |
| Naranja (pulsante) | `initializing` | WiFi inicializándose |
| Naranja | `connected` | Conectado al AP, esperando IP |
| Verde | `got_ip` | Conectado con IP asignada |
| Gris | `disconnected` | Desconectado |

**Tooltip**: muestra SSID e IP cuando está conectado.

### Ícono BLE

| Color | Estado | Significado |
|-------|--------|-------------|
| Gris | — | BLE no activo |
| Azul | `initialized` | BLE controlador inicializado |
| Índigo | `advertising` | BLE advertising activo |

---

## Configuración de Red

| Parámetro | Valor |
|-----------|-------|
| SSID | `Velxio-GUEST` |
| Contraseña | *(vacía — red abierta)* |
| Canal | 6 |
| Seguridad | Open (sin cifrado) |
| Subred | `192.168.4.0/24` |
| IP del ESP32 | `192.168.4.15` |
| Gateway | `192.168.4.2` |
| DNS | Proporcionado por slirp |
| BSSID | `42:13:37:55:aa:01` |
| MAC ESP32 | `24:0a:c4:00:01:10` (default) |

### Redes adicionales visibles en scan

| SSID | Canal | Señal |
|------|-------|-------|
| Velxio-GUEST | 6 | -20 dBm |
| PICSimLabWifi | 1 | -25 dBm |
| Espressif | 5 | -30 dBm |
| MasseyWifi | 10 | -40 dBm |

### Boards soportados

| Board | NIC Model QEMU | FQBN |
|-------|----------------|------|
| ESP32 | `esp32_wifi` | `esp32:esp32:esp32` |
| ESP32-S3 | `esp32_wifi` | `esp32:esp32:esp32s3` |
| ESP32-C3 | `esp32c3_wifi` | `esp32:esp32:esp32c3` |

---

## Limitaciones

### WiFi

| Limitación | Detalle |
|------------|---------|
| **SSID fijo** | Debes usar `"Velxio-GUEST"` (sin contraseña). No puedes crear tu propio AP ni usar otro SSID para conectar. |
| **Sin WPA/WPA2** | La red es abierta. El firmware puede intentar cifrado pero no se verificará. |
| **Sin ICMP (ping)** | `ping` no funciona — es una limitación de slirp. Usa TCP/HTTP para verificar conectividad. |
| **MAC fija** | Todas las instancias usan `24:0a:c4:00:01:10` por defecto. Configurable vía eFuse emulado pero no expuesto en UI. |
| **Sin modo AP** | El ESP32 no puede crear su propio Access Point — solo modo Station (STA). |
| **Sin ESP-NOW** | Comunicación peer-to-peer entre ESP32s no soportada. |
| **Sin mDNS funcional** | `mDNS.begin("esp32")` puede compilar pero no resuelve nombres en la red emulada. |
| **Puerto HTTP 80 solamente** | El hostfwd solo mapea al puerto 80 del ESP32. Servidores en otros puertos no son accesibles vía IoT Gateway. |

### Bluetooth / BLE

| Limitación | Detalle |
|------------|---------|
| **Solo detección** | BLE se inicializa correctamente (el firmware ejecuta `BLEDevice::init()`, crea servicios y characteristics) pero no hay comunicación real. |
| **Sin VHCI** | El fork de QEMU de lcgamboa no implementa Virtual HCI. No hay transporte BLE real entre host y emulador. |
| **Sin scan BLE** | `BLEScan` no encontrará dispositivos. |
| **Sin notify/indicate** | Las characteristics se crean pero los callbacks de notify/indicate no se disparan. |
| **Sin Classic Bluetooth** | Solo BLE es detectado. Bluetooth Classic (SPP, A2DP, etc.) no está soportado. |

### Generales

| Limitación | Detalle |
|------------|---------|
| **Requiere rebuild QEMU** | Para cambiar los APs disponibles o la configuración de red, necesitas recompilar `libqemu-xtensa` con `build_libqemu-esp32.sh`. |
| **Un servidor HTTP por instancia** | Cada sesión de emulación soporta un solo servidor HTTP (puerto 80). |
| **Latencia de red** | Las peticiones HTTP a través del IoT Gateway tienen latencia adicional por el doble proxy (browser → backend → QEMU → ESP32). |

---

## Archivos Modificados / Creados

### QEMU (C)

| Archivo | Cambio |
|---------|--------|
| `wokwi-libs/qemu-lcgamboa/hw/misc/esp32_wifi_ap.c` | Añadido SSID "Velxio-GUEST" al array de access points |

### Backend (Python)

| Archivo | Cambio |
|---------|--------|
| `backend/app/services/espidf_compiler.py` | **NUEVO** — Compilador ESP-IDF: traduce sketches Arduino WiFi/WebServer a ESP-IDF C nativo, compila con cmake+ninja, merge flash image |
| `backend/app/services/esp-idf-template/` | **NUEVO** — Template ESP-IDF (CMakeLists.txt, sdkconfig.defaults, main.c/cpp, partitions.csv) |
| `backend/app/api/routes/compile.py` | Ruta ESP32 boards a ESP-IDF compiler cuando disponible |
| `backend/app/services/esp32_worker.py` | Añadidos args `-nic` WiFi al lanzar QEMU, IP estática 192.168.4.15 |
| `backend/app/services/esp32_lib_manager.py` | Parámetros `wifi_enabled`/`wifi_hostfwd_port` en `start_instance()`, integración del parser serial |
| `backend/app/services/esp_qemu_manager.py` | Parámetros WiFi en `start_instance()` y `_boot()`, args `-nic` en subprocess |
| `backend/app/api/routes/simulation.py` | Handler WebSocket extrae `wifi_enabled`, asigna puerto dinámico, `_find_free_port()` |
| `backend/app/api/routes/iot_gateway.py` | **NUEVO** — Proxy HTTP reverso para servidores ESP32 |
| `backend/app/services/wifi_status_parser.py` | **NUEVO** — Parser de logs ESP-IDF para eventos WiFi/BLE |
| `backend/app/main.py` | Registrado router del IoT Gateway |

### Frontend (TypeScript/React)

| Archivo | Cambio |
|---------|--------|
| `frontend/src/simulation/Esp32Bridge.ts` | Interfaces `WifiStatus`/`BleStatus`, propiedad `wifiEnabled`, callbacks `onWifiStatus`/`onBleStatus` |
| `frontend/src/store/useSimulatorStore.ts` | Auto-detección WiFi, estado `wifiStatus`/`bleStatus` por board |
| `frontend/src/components/simulator/SimulatorCanvas.tsx` | Íconos SVG de WiFi/BLE con estados y tooltips |
| `frontend/src/components/simulator/SimulatorCanvas.css` | Estilos CSS para badges WiFi/BLE |
| `frontend/src/types/board.ts` | Interfaces `WifiStatus`/`BleStatus`, campos en `BoardInstance` |
| `frontend/src/data/examples.ts` | 4 ejemplos nuevos: WiFi Scan, WiFi Connect, HTTP Server, BLE Advertise |

---

## Tests

### Frontend (Vitest)

| Test File | Tests | Descripción |
|-----------|-------|-------------|
| `esp32-wifi-bluetooth.test.ts` | 14 | Esp32Bridge WiFi flag, status events, auto-detección, BLE detection |
| `esp32-wifi-compile.test.ts` | 11 | Validación de sketches ejemplo, FQBN mapping |
| `esp32-wifi-webserver-integration.test.ts` | 31 | Pipeline completo: sketch → auto-detect → bridge → status → serial → gateway |
| `esp32c3-wifi-bluetooth.test.ts` | 29 | ESP32-C3 bridge, variant mapping, WiFi/BLE status, QEMU NIC config |

**Ejecutar:**

```bash
cd frontend
npm test -- --run src/__tests__/esp32-wifi-bluetooth.test.ts
npm test -- --run src/__tests__/esp32-wifi-compile.test.ts
npm test -- --run src/__tests__/esp32-wifi-webserver-integration.test.ts
npm test -- --run src/__tests__/esp32c3-wifi-bluetooth.test.ts
```

### Backend (pytest)

| Test File | Tests | Descripción |
|-----------|-------|-------------|
| `test_esp32_wifi.py` | 17 | NIC arg injection, EspQemuManager params, free port allocation |
| `test_esp32c3_wifi.py` | 18 | RISC-V binary, C3 machine, NIC model, hostfwd, serial parser |
| `test_wifi_status_parser.py` | 14 | Parser WiFi/BLE: sta_start, connected, got_ip, disconnect, BLE init/advertising |
| `test_esp32_wifi_webserver.py` | 23 | Integration: sketch structure, auto-detect, NIC args, serial parsing, gateway URL |

**Ejecutar:**

```bash
cd backend
python -m pytest tests/test_esp32_wifi.py tests/test_esp32c3_wifi.py tests/test_wifi_status_parser.py tests/test_esp32_wifi_webserver.py -v
```

### Total: 157 tests específicos de WiFi/BLE

---

## Troubleshooting

### El ícono WiFi no aparece
- Verifica que tu board sea ESP32, ESP32-S3 o ESP32-C3
- Asegúrate de que tu sketch incluya `#include <WiFi.h>` o use `WiFi.begin(`

### WiFi se queda en "initializing"
- El firmware debe usar el SSID `"Velxio-GUEST"` — otros SSIDs no funcionarán
- No uses contraseña: `WiFi.begin("Velxio-GUEST", "")`
- Verifica en el Serial Monitor que QEMU muestra los logs ESP-IDF de WiFi

### No puedo acceder al servidor HTTP del ESP32
- Espera a que el Serial Monitor muestre "Server at:" o similar
- El IoT Gateway solo funciona con servidores en puerto 80
- Accede vía `/api/gateway/{client_id}/` no directamente al IP 192.168.4.15

### BLE no funciona completamente
- BLE solo es detección — la inicialización funciona pero no hay comunicación real
- El ícono BLE se pondrá azul cuando `BLEDevice::init()` se ejecute
- Para BLE real necesitarías un QEMU con soporte VHCI (no disponible en lcgamboa fork)

### ping no funciona
- Es una limitación de slirp — usa `HTTPClient` o `WiFiClient` para verificar conectividad
- Ejemplo: `http.begin("http://httpbin.org/get")` funciona, `ping google.com` no

### La compilación falla
- **ESP-IDF (producción)**: Los sketches ESP32 se compilan ahora con ESP-IDF 4.4.7 en lugar de arduino-cli. El backend traduce automáticamente Arduino WiFi/WebServer a ESP-IDF C nativo. Verifica que `IDF_PATH` esté configurado.
- **Fallback arduino-cli**: Si ESP-IDF no está disponible, se usa arduino-cli. Instala el core:
  ```bash
  arduino-cli core install esp32:esp32@2.0.17
  ```
- El FQBN correcto es `esp32:esp32:esp32` (no `esp32:esp32:esp32dev`)
