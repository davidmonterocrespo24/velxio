import json
import logging
import socket
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.qemu_manager import qemu_manager
from app.services.esp_qemu_manager import esp_qemu_manager
from app.services.esp32_lib_manager import esp_lib_manager
from app.services.picow_net_bridge import picow_net_manager


def _find_free_port() -> int:
    """Allocate a free TCP port for WiFi hostfwd."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

router = APIRouter()
logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket

    def disconnect(self, client_id: str):
        self.active_connections.pop(client_id, None)

    async def send(self, client_id: str, message: str):
        ws = self.active_connections.get(client_id)
        if ws:
            await ws.send_text(message)


manager = ConnectionManager()


@router.websocket('/ws/{client_id}')
async def simulation_websocket(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)

    async def qemu_callback(event_type: str, data: dict) -> None:
        if event_type == 'gpio_change':
            logger.debug('[%s] gpio_change pin=%s state=%s', client_id, data.get('pin'), data.get('state'))
        elif event_type == 'system':
            logger.debug('[%s] system event: %s', client_id, data.get('event'))
        elif event_type == 'error':
            logger.error('[%s] error: %s', client_id, data.get('message'))
        elif event_type == 'serial_output':
            text = data.get('data', '')
            logger.debug('[%s] serial_output uart=%s len=%d: %r', client_id, data.get('uart', 0), len(text), text[:80])
        payload = json.dumps({'type': event_type, 'data': data})
        try:
            await manager.send(client_id, payload)
        except Exception as _send_exc:
            logger.debug('[%s] qemu_callback send failed (%s): %s', client_id, event_type, _send_exc)

    def _use_lib() -> bool:
        return esp_lib_manager.is_available()

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type: str = message.get('type', '')
            msg_data: dict = message.get('data', {})

            # ── Raspberry Pi ─────────────────────────────────────────────
            if msg_type == 'start_pi':
                board = msg_data.get('board', 'raspberry-pi-3')
                qemu_manager.start_instance(client_id, board, qemu_callback)

            elif msg_type == 'stop_pi':
                qemu_manager.stop_instance(client_id)

            elif msg_type == 'serial_input':
                raw_bytes: list[int] = msg_data.get('bytes', [])
                if raw_bytes:
                    await qemu_manager.send_serial_bytes(client_id, bytes(raw_bytes))

            elif msg_type in ('gpio_in', 'pin_change'):
                pin   = msg_data.get('pin', 0)
                state = msg_data.get('state', 0)
                qemu_manager.set_pin_state(client_id, pin, state)

            # ── ESP32 lifecycle ──────────────────────────────────────────
            elif msg_type == 'start_esp32':
                board        = msg_data.get('board', 'esp32')
                firmware_b64 = msg_data.get('firmware_b64')
                sensors      = msg_data.get('sensors', [])
                wifi_enabled = bool(msg_data.get('wifi_enabled', False))
                fw_size_kb   = round(len(firmware_b64) * 0.75 / 1024) if firmware_b64 else 0
                lib_available = _use_lib()

                # Allocate a host port for WiFi hostfwd if WiFi is enabled
                wifi_hostfwd_port = _find_free_port() if wifi_enabled else 0

                logger.info('[%s] start_esp32 board=%s firmware=%dKB lib_available=%s sensors=%d wifi=%s hostfwd=%d',
                            client_id, board, fw_size_kb, lib_available, len(sensors),
                            wifi_enabled, wifi_hostfwd_port)
                if lib_available:
                    await esp_lib_manager.start_instance(
                        client_id, board, qemu_callback, firmware_b64, sensors,
                        wifi_enabled=wifi_enabled, wifi_hostfwd_port=wifi_hostfwd_port)
                else:
                    logger.warning('[%s] libqemu-xtensa not available — using subprocess fallback', client_id)
                    esp_qemu_manager.start_instance(
                        client_id, board, qemu_callback, firmware_b64,
                        wifi_enabled=wifi_enabled, wifi_hostfwd_port=wifi_hostfwd_port)

            elif msg_type == 'stop_esp32':
                await esp_lib_manager.stop_instance(client_id)
                esp_qemu_manager.stop_instance(client_id)

            elif msg_type == 'load_firmware':
                firmware_b64 = msg_data.get('firmware_b64', '')
                if firmware_b64:
                    if _use_lib():
                        esp_lib_manager.load_firmware(client_id, firmware_b64)
                    else:
                        esp_qemu_manager.load_firmware(client_id, firmware_b64)

            # ── Pico W (CYW43439) WiFi bridge ────────────────────────────
            # The chip-side gSPI emulator lives in the frontend; this side
            # forwards Layer-2 Ethernet frames to/from the host network.
            # Mirrors the ESP32 path deliberately — see
            # backend/app/services/picow_net_bridge.py for design notes.
            elif msg_type == 'start_picow':
                wifi_enabled = bool(msg_data.get('wifi_enabled', False))
                logger.info('[%s] start_picow wifi=%s', client_id, wifi_enabled)
                await picow_net_manager.start_instance(
                    client_id, qemu_callback, wifi_enabled,
                )

            elif msg_type == 'stop_picow':
                await picow_net_manager.stop_instance(client_id)

            elif msg_type == 'picow_packet_out':
                ether_b64 = msg_data.get('ether_b64', '')
                if ether_b64:
                    await picow_net_manager.deliver_packet_out(client_id, ether_b64)

            # ── ESP32 serial (UART 0 / 1 / 2) ───────────────────────────
            elif msg_type == 'esp32_serial_input':
                raw_bytes = msg_data.get('bytes', [])
                uart_id   = int(msg_data.get('uart', 0))
                if raw_bytes:
                    if _use_lib():
                        await esp_lib_manager.send_serial_bytes(
                            client_id, bytes(raw_bytes), uart_id
                        )
                    else:
                        await esp_qemu_manager.send_serial_bytes(
                            client_id, bytes(raw_bytes)
                        )

            # ── ESP32 GPIO input (from connected component / button) ──────
            elif msg_type == 'esp32_gpio_in':
                pin   = msg_data.get('pin', 0)
                state = msg_data.get('state', 0)
                if _use_lib():
                    esp_lib_manager.set_pin_state(client_id, pin, state)
                else:
                    esp_qemu_manager.set_pin_state(client_id, pin, state)

            # ── ESP32 ADC (analog input from potentiometer, sensor, etc.) ─
            elif msg_type == 'esp32_adc_set':
                # Frontend sends {channel: int, millivolts: int}
                # or {channel: int, raw: int} for direct 12-bit value
                channel = int(msg_data.get('channel', 0))
                if 'millivolts' in msg_data:
                    if _use_lib():
                        esp_lib_manager.set_adc(
                            client_id, channel, int(msg_data['millivolts'])
                        )
                elif 'raw' in msg_data:
                    if _use_lib():
                        esp_lib_manager.set_adc_raw(
                            client_id, channel, int(msg_data['raw'])
                        )

            # ── ESP32 ADC waveform LUT (periodic sampling for AC sources) ──
            # Frontend pushes a 12-bit sample array + period; QEMU interpolates
            # on every MMIO read using its virtual clock. This matches the
            # AVR/RP2040 per-read `onADCRead` hook so ADC samples see the
            # instantaneous SPICE waveform rather than a stale DC scalar.
            elif msg_type == 'esp32_adc_waveform':
                channel = int(msg_data.get('channel', 0))
                samples_b64 = msg_data.get('samples_u12_b64', '')
                period_ns = int(msg_data.get('period_ns', 0))
                if _use_lib() and hasattr(esp_lib_manager, 'set_adc_waveform'):
                    esp_lib_manager.set_adc_waveform(
                        client_id, channel, samples_b64, period_ns
                    )

            # ── ESP32 I2C device simulation ───────────────────────────────
            elif msg_type == 'esp32_i2c_response':
                # Frontend configures what an I2C device at addr returns
                # {addr: int, response: int}
                addr = int(msg_data.get('addr', 0))
                resp = int(msg_data.get('response', 0))
                if _use_lib():
                    esp_lib_manager.set_i2c_response(client_id, addr, resp)

            # ── ESP32 SPI device simulation ───────────────────────────────
            elif msg_type == 'esp32_spi_response':
                # {response: int} — byte to return as MISO
                resp = int(msg_data.get('response', 0xFF))
                if _use_lib():
                    esp_lib_manager.set_spi_response(client_id, resp)

            # ── ESP32 UART 1 / 2 input ────────────────────────────────────
            elif msg_type == 'esp32_uart1_input':
                raw_bytes = msg_data.get('bytes', [])
                if raw_bytes and _use_lib():
                    await esp_lib_manager.send_serial_bytes(
                        client_id, bytes(raw_bytes), uart_id=1
                    )

            elif msg_type == 'esp32_uart2_input':
                raw_bytes = msg_data.get('bytes', [])
                if raw_bytes and _use_lib():
                    await esp_lib_manager.send_serial_bytes(
                        client_id, bytes(raw_bytes), uart_id=2
                    )

            # ── ESP32 sensor protocol offloading (generic) ────────────────
            elif msg_type == 'esp32_sensor_attach':
                sensor_type = msg_data.get('sensor_type', '')
                pin = int(msg_data.get('pin', 0))
                if _use_lib():
                    esp_lib_manager.sensor_attach(client_id, sensor_type, pin, msg_data)
                else:
                    esp_qemu_manager.sensor_attach(client_id, sensor_type, pin, msg_data)

            elif msg_type == 'esp32_sensor_update':
                pin = int(msg_data.get('pin', 0))
                if _use_lib():
                    esp_lib_manager.sensor_update(client_id, pin, msg_data)
                else:
                    esp_qemu_manager.sensor_update(client_id, pin, msg_data)

            elif msg_type == 'esp32_sensor_detach':
                pin = int(msg_data.get('pin', 0))
                if _use_lib():
                    esp_lib_manager.sensor_detach(client_id, pin)
                else:
                    esp_qemu_manager.sensor_detach(client_id, pin)

            # ── ESP32-CAM camera frame injection ───────────────────────────
            # Browser pushes JPEGs from getUserMedia. Backend forwards to the
            # worker which writes them into the I²S camera peripheral.
            # See test/test-esp32-cam/autosearch/04_proposed_architecture.md
            elif msg_type == 'esp32_camera_attach':
                if _use_lib():
                    esp_lib_manager.camera_attach(client_id, msg_data)

            elif msg_type == 'esp32_camera_frame':
                if _use_lib():
                    esp_lib_manager.camera_frame(
                        client_id,
                        msg_data.get('b64', ''),
                        fmt=msg_data.get('fmt', 'jpeg'),
                        width=int(msg_data.get('w', 0)),
                        height=int(msg_data.get('h', 0)),
                    )

            elif msg_type == 'esp32_camera_detach':
                if _use_lib():
                    esp_lib_manager.camera_detach(client_id)

            # ── ESP32 status query ────────────────────────────────────────
            elif msg_type == 'esp32_status':
                if _use_lib():
                    status = esp_lib_manager.get_status(client_id)
                    await manager.send(
                        client_id,
                        json.dumps({'type': 'esp32_status', 'data': status})
                    )

    except WebSocketDisconnect:
        # Guard: only clean up if this coroutine still owns the connection for client_id.
        # A newer simulation_websocket may have already connected and replaced us.
        if manager.active_connections.get(client_id) is websocket:
            manager.disconnect(client_id)
            qemu_manager.stop_instance(client_id)
            await esp_lib_manager.stop_instance(client_id)
            esp_qemu_manager.stop_instance(client_id)
        else:
            logger.info('[%s] old WS session ended; newer session is active — skipping cleanup', client_id)
    except Exception as exc:
        logger.error('WebSocket error for %s: %s', client_id, exc)
        if manager.active_connections.get(client_id) is websocket:
            manager.disconnect(client_id)
            qemu_manager.stop_instance(client_id)
            await esp_lib_manager.stop_instance(client_id)
            esp_qemu_manager.stop_instance(client_id)
