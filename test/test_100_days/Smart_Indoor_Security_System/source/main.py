import machine, utime, network, urequests, ujson



# ─── Favoriot Credentials ───────────────────────
API_KEY   = '..'
USERNAME  = ''
DEVICE_ID = 'SmartSecurityr'+USERNAME
URL       = 'https://apiv2.favoriot.com/v2/streams'

#import machine, utime, network, urequests, ujson

# ─── WiFi Credentials ───────────────────────────
SSID     = 'Wokwi-GUEST'
PASSWORD = ''



# ─── Pin Setup ──────────────────────────────────
pir  = machine.Pin(14, machine.Pin.IN)

ROW_PINS = [19, 18, 5, 17]
COL_PINS = [16,  4, 2, 15]
KEYS = [
    ['1','2','3','A'],
    ['4','5','6','B'],
    ['7','8','9','C'],
    ['*','0','#','D']
]

rows = [machine.Pin(p, machine.Pin.OUT) for p in ROW_PINS]
cols = [machine.Pin(p, machine.Pin.IN, machine.Pin.PULL_DOWN) for p in COL_PINS]

# ─── Settings ───────────────────────────────────
CORRECT_PASSWORD = '1234'
TIMEOUT_MS       = 30000

# ─── WiFi Connect ───────────────────────────────
def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(SSID, PASSWORD)
    print('Connecting to WiFi', end='')
    for _ in range(20):
        if wlan.isconnected():
            break
        print('.', end='')
        utime.sleep(0.5)
    if wlan.isconnected():
        print(' Connected! IP:', wlan.ifconfig()[0])
    else:
        print(' WiFi Failed - running without Favoriot')

# ─── Keypad ─────────────────────────────────────
def get_key():
    for r, row in enumerate(rows):
        row.value(1)
        for c, col in enumerate(cols):
            if col.value() == 1:
                row.value(0)
                # Wait for button release
                while col.value() == 1:
                    utime.sleep_ms(10)
                utime.sleep_ms(50)
                return KEYS[r][c]
        row.value(0)
    return None
# ─── Favoriot ───────────────────────────────────
def send_to_favoriot(event, status, access):
    print('>>> FAVORIOT | event:', event, '| status:', status, '| access:', access)
    wlan = network.WLAN(network.STA_IF)
    if not wlan.isconnected():
        print('No WiFi - skipping Favoriot')
        return
    try:
        headers = {
            'Content-Type': 'application/json',
            'apikey': API_KEY,
            'username': USERNAME
        }
        body = ujson.dumps({
            'device_developer_id': DEVICE_ID,
            'data': {
                'event': event,
                'status': status,
                'access': str(access)
            }
        })
        r = urequests.post(URL, headers=headers, data=body)
        print('Favoriot Response:', r.status_code)
        r.close()
    except Exception as e:
        print('Favoriot Error:', e)

# ─── Main ───────────────────────────────────────
connect_wifi()
print('System Ready - Waiting for motion...')

while True:
    if pir.value() == 1:
        print('Motion Detected!')
        send_to_favoriot('MOTION_DETECTED', 'WAITING', 0)

        entered = ''
        start = utime.ticks_ms()

        while utime.ticks_diff(utime.ticks_ms(), start) < TIMEOUT_MS:
            key = get_key()
            if key:
                if key == '#':
                    if entered == CORRECT_PASSWORD:
                        print('Access Granted!')
                        send_to_favoriot('ACCESS_GRANTED', 'SAFE', 1)
                    else:
                        print('Wrong Password!')
                        send_to_favoriot('WRONG_PASSWORD', 'ALARM', 0)
                    break
                elif key == '*':
                    entered = ''
                    print('Cleared')
                else:
                    entered += key
                    print('*', end='')
        else:
            print('Timeout - Alarm!')
            send_to_favoriot('TIMEOUT_ALARM', 'ALARM', 0)

    utime.sleep_ms(100)