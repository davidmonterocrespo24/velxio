from __future__ import annotations
"""
WiFi/BLE status parser — extracts connection events from ESP-IDF serial output.

ESP-IDF logs WiFi and BLE lifecycle events to UART0. This module scans
the accumulated serial text and returns structured status events that the
frontend can display as icons / panels.

Typical ESP-IDF WiFi log patterns:
  I (xxx) wifi:wifi sta start
  I (xxx) wifi:new:<SSID>, old:...
  I (xxx) wifi:connected with <SSID>, aid = ...
  I (xxx) esp_netif_handlers: sta ip: 192.168.4.2, ...
  I (xxx) wifi:state: run -> init (0)

Typical BLE log patterns:
  I (xxx) BT_INIT: BT controller compile version ...
  I (xxx) GATTS: ...
  I (xxx) GAP_BLE: ...
"""
import re
from typing import TypedDict


class WifiEvent(TypedDict, total=False):
    status: str       # 'initializing' | 'connected' | 'got_ip' | 'disconnected'
    ssid: str
    ip: str


class BleEvent(TypedDict, total=False):
    status: str       # 'initialized' | 'advertising'


# ── WiFi patterns ────────────────────────────────────────────────────────────

_RE_WIFI_STA_START = re.compile(r'wifi\s*:\s*wifi\s+sta\s+start', re.IGNORECASE)
_RE_WIFI_CONNECTED = re.compile(
    r'wifi\s*:\s*connected\s+with\s+([^,]+)',
    re.IGNORECASE,
)
_RE_WIFI_GOT_IP = re.compile(
    r'sta\s+ip:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})',
    re.IGNORECASE,
)
_RE_WIFI_DISCONNECT = re.compile(
    r'wifi\s*:\s*state:\s*\S+\s*->\s*init\s*\(0\)',
    re.IGNORECASE,
)
# Also catch "WiFi.begin" style Arduino logs
_RE_WIFI_BEGIN = re.compile(r'wifi\s*:\s*new\s*:\s*([^,]+)', re.IGNORECASE)

# ── BLE patterns ─────────────────────────────────────────────────────────────

_RE_BLE_INIT = re.compile(r'BT_INIT.*BT\s+controller\s+compile', re.IGNORECASE)
_RE_BLE_ADV = re.compile(r'(GATTS|GAP_BLE).*advert', re.IGNORECASE)


def parse_wifi_line(line: str) -> WifiEvent | None:
    """Parse a single line for WiFi status. Returns None if no match."""
    if _RE_WIFI_GOT_IP.search(line):
        m = _RE_WIFI_GOT_IP.search(line)
        return WifiEvent(status='got_ip', ip=m.group(1) if m else '')

    if _RE_WIFI_CONNECTED.search(line):
        m = _RE_WIFI_CONNECTED.search(line)
        return WifiEvent(status='connected', ssid=m.group(1).strip() if m else '')

    if _RE_WIFI_BEGIN.search(line):
        m = _RE_WIFI_BEGIN.search(line)
        return WifiEvent(status='connected', ssid=m.group(1).strip() if m else '')

    if _RE_WIFI_STA_START.search(line):
        return WifiEvent(status='initializing')

    if _RE_WIFI_DISCONNECT.search(line):
        return WifiEvent(status='disconnected')

    return None


def parse_ble_line(line: str) -> BleEvent | None:
    """Parse a single line for BLE status. Returns None if no match."""
    if _RE_BLE_ADV.search(line):
        return BleEvent(status='advertising')

    if _RE_BLE_INIT.search(line):
        return BleEvent(status='initialized')

    return None


def parse_serial_text(text: str) -> tuple[list[WifiEvent], list[BleEvent]]:
    """
    Parse a block of serial output and return all WiFi and BLE events found.

    Returns (wifi_events, ble_events).
    """
    wifi_events: list[WifiEvent] = []
    ble_events: list[BleEvent] = []

    for line in text.splitlines():
        we = parse_wifi_line(line)
        if we:
            wifi_events.append(we)
        be = parse_ble_line(line)
        if be:
            ble_events.append(be)

    return wifi_events, ble_events
