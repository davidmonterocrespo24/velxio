# ===== EEPROM Simulation (File-based) =====

EEPROM_FILE = "eeprom.dat"
EEPROM_SIZE = 512

def eeprom_init():
    try:
        with open(EEPROM_FILE, "rb"):
            print("EEPROM exists")
    except:
        print("Creating EEPROM...")
        with open(EEPROM_FILE, "wb") as f:
            f.write(bytearray(EEPROM_SIZE))


def eeprom_read_byte(addr):
    with open(EEPROM_FILE, "rb") as f:
        f.seek(addr)
        return f.read(1)[0]


def eeprom_write_byte(addr, val):
    with open(EEPROM_FILE, "r+b") as f:
        f.seek(addr)
        f.write(bytes([val]))


# ===== String Functions (Arduino Style) =====

def save_string(address, text):
    for i, ch in enumerate(text):
        if eeprom_read_byte(address + i) != ord(ch):
            eeprom_write_byte(address + i, ord(ch))

    # null terminator
    if eeprom_read_byte(address + len(text)) != 0:
        eeprom_write_byte(address + len(text), 0)


def read_string(address):
    result = ""
    while address < EEPROM_SIZE:
        b = eeprom_read_byte(address)
        if b == 0:
            break
        result += chr(b)
        address += 1
    return result


# ===== Main Logic =====
while True:
    eeprom_init()

    print("\nEnter a string to save in EEPROM:")
    text_to_save = input()

    stored_text = read_string(0)

    if text_to_save != stored_text:
        save_string(0, text_to_save)
        print("String saved in EEPROM.")
    else:
        print("String is same as previous one.")

    print("Stored Text in EEPROM:", read_string(0))
