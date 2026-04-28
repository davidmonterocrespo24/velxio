import ujson
import uos


STUDENT_FILE="/students.json"
MAX=1000

def load_students():
    try:
        uos.stat(STUDENT_FILE)
    except OSError:
        print("students.json not found , starting fresh.")
        return []
    
    try:
        with open(STUDENT_FILE, "r") as f:
            content=f.read()
        if not content.strip():
            print("File is Empty")
            return []
        data=ujson.loads(content)
        print("Loaded {} students.".format(len(data)))
        return data
    except Exception as e:
        print("Failed to load: ", e)
        return []
def save_students(students):
    try:
        with open(STUDENT_FILE, "w") as f:
            ujson.dump(students, f)
        print("Saved succeesfully")
        return True
    except Exception as e:
        print("Failed to save:" ,e)
        return False
def find_students_index(students, regd_no):
    for i, s in enumerate(students):
        if s.get("regdNo")== regd_no:
            return i
    return -1
def add_student(students, regd_no, name, gpa, branch):
    if len(students)>=MAX:
        return False, "Max limit reached"
    if find_students_index(students, regd_no) !=-1:
        return False, "RegdNo exists"
    students.append({
        "regdNo":regd_no,
        "name": name,
        "gpa": float(gpa),
        "branch": branch
        })
    return True, "Students added!"
def edit_student(students, old_regd_no, new_regd_no, new_name, new_gpa, new_branch):
    idx=find_students_index(students,old_regd_no)
    if idx==-1:
        return False, "Not Found"
    
    students[idx]["regdNo"]=new_regd_no
    students[idx]["name"]=new_name
    students[idx]["gpa"]=float(new_gpa)
    students[idx]["branch"]=new_branch
    return True, "Students updated"
def print_all_students(students):
    if not students:
        print("No students loaded")
        return
    for s in students:
        print(s)
