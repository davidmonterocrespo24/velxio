import sys
import time
from machine import Pin, SoftI2C
from sh1106 import SH1106_I2C
from students import(load_students, save_students, add_student, edit_student, print_all_students)

sda=21
scl=22
sw=128
sh=64

students=[]
curr_index=0
mode="list"

def oled_message(oled, lines):
    oled.fill(0)
    for i, line in enumerate(lines):
        oled.text(line[:16], 0, i*10)
    oled.show()
def display_list(oled):
    oled.fill(0)
    count=len(students)
    if count==0:
        oled.text("No students", 0, 0)
        oled.text("Use 'add' cmd,",0, 10)
        oled.show()
        return 
    idx1=curr_index
    idx2=(curr_index+1)%count
    
    oled.rect(0,0, sw, 30,1)
    
    name1 = students[idx1]["name"][:14]
    regd1 = students[idx1]["regdNo"][:14]
    oled.text("N:" + name1, 4, 6)
    oled.text("R:" + regd1, 4, 17)
    if count > 1:
        oled.rect(0, 33, sw, 30, 1)
        name2 = students[idx2]["name"][:14]
        regd2 = students[idx2]["regdNo"][:14]
        oled.text("N:" + name2, 4, 39)
        oled.text("R:" + regd2, 4, 50)
    else:
        oled.text("-- End of List --", 4, 42)
    oled.show()
def show_temp_message(oled, lines, delay_ms=2000):
    oled_message(oled, lines)
    time.sleep_ms(delay_ms)
    display_list(oled)
def handle_add(oled, command):
    global students
    parts=command.split(" ", 4)
    if len(parts)<5:
        print("Invalid add format. Use: add <regdNo> <name> <gpa> <branch>")
        show_temp_message(oled, ["Invalid", "add format!"])
        return
    _, regd_no, name, gpa_str, branch=parts
    try:
        float(gpa_str)
    except ValueError:
        print("GPA must be number")
        show_temp_message(oled, ["GPA must", "be a number!"])
        return
    ok, msg=add_student(students, regd_no, name, gpa_str, branch)
    print(msg)
    if ok:
        save_students(students)
        print_all_students(students)
        display_list(oled)
    else:
        show_temp_message(oled, [msg])
def handle_edit(oled, command):
    global students
    parts = command.split(" ", 5)
    if len(parts) < 6:
        print("Invalid edit format. Use: edit <oldRegdNo> <newRegdNo> <name> <gpa> <branch>")
        show_temp_message(oled, ["Invalid", "edit format!"])
        return

    _, old_regd, new_regd, new_name, new_gpa_str, new_branch = parts
    try:
        float(new_gpa_str)
    except ValueError:
        print("GPA must be a number.")
        show_temp_message(oled, ["GPA must", "be a number!"])
        return

    ok, msg = edit_student(students, old_regd, new_regd, new_name, new_gpa_str, new_branch)
    print(msg)
    if ok:
        save_students(students)
        display_list(oled)
    else:
        show_temp_message(oled, [msg])

def display_detail(oled, index):
    oled.fill(0)
    s = students[index]
    oled.rect(2, 2, sw-4, sh-4, 1)
    oled.text("R:" + s["regdNo"][:13],  6, 8)
    oled.text("N:" + s["name"][:13],    6, 20)
    oled.text("G:" + str(s["gpa"])[:13],6, 32)
    oled.text("B:" + s["branch"][:13],  6, 44)
    oled.show()
def handle_command(oled, command):
    
    global curr_index, mode

    # 'add' always allowed
    if command.startswith("add "):
        handle_add(oled, command)
        return

    # All other commands need at least one student
    if len(students) == 0:
        print("No students. Use 'add' command first.")
        oled_message(oled, ["No students.", "Use 'add' cmd."])
        return

    if command == "ok":
        mode = "detail"
        display_detail(oled, curr_index)

    elif command == "back":
        mode = "list"
        display_list(oled)

    elif command == "down":
        curr_index = (curr_index + 1) % len(students)
        mode = "list"
        display_list(oled)

    elif command == "up":
        curr_index = (curr_index - 1 + len(students)) % len(students)
        mode = "list"
        display_list(oled)

    elif command.startswith("edit "):
        handle_edit(oled, command)

    else:
        print("Unknown command:", command)
        print("Valid commands: add, edit, ok, back, up, down")


def main():
    global students

    # Initialize I2C and OLED
    i2c = SoftI2C(scl=Pin(scl), sda=Pin(sda))
    oled = SH1106_I2C(sw, sh, i2c, None, 0x3c)

    # Boot message
    oled_message(oled, ["Student Mgmt", "System v1.0", "Loading..."])
    time.sleep_ms(1500)

    # Load students from flash
    students = load_students()
    print("System ready. {} students loaded.".format(len(students)))
    print("Commands: add / edit / ok / back / up / down")

    # Show initial display
    display_list(oled)

    # Main loop: read commands from Serial
    buf = ""
    while True:
        if sys.stdin in select_readable():
            char = sys.stdin.read(1)
            if char in ("\n", "\r"):
                cmd = buf.strip()
                buf = ""
                if cmd:
                    print(">> Received:", cmd)
                    handle_command(oled, cmd)
            else:
                buf += char
        time.sleep_ms(10)


def select_readable():
    
    import select
    r, _, _ = select.select([sys.stdin], [], [], 0)
    return r


# Run
main()

    
