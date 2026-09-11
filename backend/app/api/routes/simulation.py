import json
import logging
import socket
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.esp_qemu_manager import esp_qemu_manager
from app.services.board_access import PRO_BOARD_MESSAGE
from app.services.esp32_lib_manager import esp_lib_manager
from app.core.hooks import dispatch_ws_sim_message, dispatch_ws_sim_disconnect




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

            # ── QEMU board lane: Raspberry Pi Linux + STM32 ──────────────
            # Both families are paid-only (velxio.dev with a paid plan, or
            # Velxio Desktop with a paid licence), so their emulators are not
            # part of the open-source image at all: qemu_manager, boot_images
            # and stm32_lib_manager live in an optional `app.pro_boards`
            # package that registers itself through register_ws_sim_handler.
            # With no extension installed these messages are ignored and the
            # boards never start, which is the intent — the frontend already
            # frames them as a Pro feature (board_access.PRO_BOARD_MESSAGE).
            #
            # `serial_input`, `gpio_in` and `pin_change` read as generic but
            # have only ever driven the Linux guests; the ESP32 and Pico lanes
            # use their own prefixed message names.
            if msg_type in (
                'start_pi', 'stop_pi', 'serial_input', 'gpio_in', 'pin_change',
                'pi_sensor_state', 'pi_uart_rx', 'pi_attach_slave', 'pi_detach_slave',
                'pi_bus_reply', 'pi_bus_topology', 'pi_bus_regs',
                'start_stm32', 'stop_stm32', 'stm32_load_firmware', 'stm32_gpio_in',
                'stm32_serial_input', 'stm32_sensor_attach', 'stm32_sensor_update',
                'stm32_sensor_detach',
            ):
                handled = await dispatch_ws_sim_message(
                    websocket, client_id, msg_type, msg_data, qemu_callback,
                )
                if not handled and msg_type in ('start_pi', 'start_stm32'):
                    # No extension installed: say so instead of going quiet.
                    # Silence here reads as a hung Run button — the user gets
                    # no error, no serial output and no stop. Only the two
                    # start messages answer; the rest of the lane's traffic
                    # would just repeat the same line.
                    await qemu_callback('error', {'message': PRO_BOARD_MESSAGE})

            # ── ESP32 lifecycle ──────────────────────────────────────────
            elif msg_type == 'start_esp32':
                board        = msg_data.get('board', 'esp32')
                firmware_b64 = msg_data.get('firmware_b64')
                sensors      = msg_data.get('sensors', [])
                wifi_enabled = bool(msg_data.get('wifi_enabled', False))
                sd_card      = msg_data.get('sd_card')  # {'image_b64': ...} when a microSD is wired
                fw_size_kb   = round(len(firmware_b64) * 0.75 / 1024) if firmware_b64 else 0
                lib_available = _use_lib()

                # Allocate a host port for WiFi hostfwd if WiFi is enabled
                wifi_hostfwd_port = _find_free_port() if wifi_enabled else 0

                sd_kb = round(len(sd_card['image_b64']) * 0.75 / 1024) if sd_card and sd_card.get('image_b64') else 0
                logger.info('[%s] start_esp32 board=%s firmware=%dKB lib_available=%s sensors=%d wifi=%s hostfwd=%d sd=%dKB',
                            client_id, board, fw_size_kb, lib_available, len(sensors),
                            wifi_enabled, wifi_hostfwd_port, sd_kb)
                if lib_available:
                    await esp_lib_manager.start_instance(
                        client_id, board, qemu_callback, firmware_b64, sensors,
                        wifi_enabled=wifi_enabled, wifi_hostfwd_port=wifi_hostfwd_port,
                        sd_card=sd_card)
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

            # ── Pico W (CYW43439) WiFi bridge — overlay-provided ─────────
            # The chip-side gSPI emulator lives in the frontend; the userspace
            # network stack AND the paid-plan gate live in the velxio-prod
            # overlay (registered via register_ws_sim_handler). OSS has no
            # handler, so these messages are ignored and a Pico W has no WiFi.
            elif msg_type in ('start_picow', 'stop_picow', 'picow_packet_out'):
                await dispatch_ws_sim_message(
                    websocket, client_id, msg_type, msg_data, qemu_callback,
                )

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

            # ── Cross-board I2C proxy: register a peer board's device on QEMU ──
            # Used when an ESP32 is wired to another board's I2C bus (Uno, Pico,
            # …) and that peer board has a virtual device the ESP32 firmware
            # should be able to read.  The frontend snapshots the device's
            # register state and pushes it here; the worker installs a
            # ProxySlave at the address.
            elif msg_type == 'esp32_proxy_i2c_register':
                addr = int(msg_data.get('addr', 0)) & 0x7F
                regs_b64 = msg_data.get('regs_b64', '')
                if _use_lib():
                    esp_lib_manager.proxy_i2c_register(client_id, addr, regs_b64)

            elif msg_type == 'esp32_proxy_i2c_update':
                addr = int(msg_data.get('addr', 0)) & 0x7F
                regs_b64 = msg_data.get('regs_b64', '')
                if _use_lib():
                    esp_lib_manager.proxy_i2c_update(client_id, addr, regs_b64)

            elif msg_type == 'esp32_proxy_i2c_unregister':
                addr = int(msg_data.get('addr', 0)) & 0x7F
                if _use_lib():
                    esp_lib_manager.proxy_i2c_unregister(client_id, addr)

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
            # Tear down whatever an extension started for this client (a Pi
            # guest is a real QEMU child holding 1-2 GB, so this must run).
            await dispatch_ws_sim_disconnect(client_id)
            await esp_lib_manager.stop_instance(client_id)
            esp_qemu_manager.stop_instance(client_id)
        else:
            logger.info('[%s] old WS session ended; newer session is active — skipping cleanup', client_id)
    except Exception as exc:
        logger.error('WebSocket error for %s: %s', client_id, exc)
        if manager.active_connections.get(client_id) is websocket:
            manager.disconnect(client_id)
            # Tear down whatever an extension started for this client (a Pi
            # guest is a real QEMU child holding 1-2 GB, so this must run).
            await dispatch_ws_sim_disconnect(client_id)
            await esp_lib_manager.stop_instance(client_id)
            esp_qemu_manager.stop_instance(client_id)
