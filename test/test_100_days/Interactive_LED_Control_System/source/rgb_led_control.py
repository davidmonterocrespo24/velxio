from pyfirmata2 import * # For Arduino communication
from customtkinter import * # For creating modern-looking GUIs
from customtkinter import CTk # Base class for CustomTkinter windows
from CTkColorPicker import * # For a color picker widget in CustomTkinter

# --- Installation Instructions ---

# 1. Install Python:
#   - Ensure you have Python 3.x installed on your system.
#   - If not, download it from python.org and follow the installation instructions.

# 2. Install PyFirmata2:
#   - Open a terminal or command prompt.
#   - Run the following command:
#     pip install pyfirmata2

# 3. Install CustomTkinter:
#   - In the same terminal, run:
#     pip install customtkinter

# 4. Install CTkColorPicker:
#   - In the same terminal, run:
#     pip install CTkColorPicker

#write your port number 
port="COM4"
#initialize the board as Arduino with port
board=Arduino(port)
'''board.get_pin(): This is a method call. It's accessing the get_pin() method of the board object. This method is used to obtain a reference to a specific pin on the Arduino board'''

''''d:13:o': This is a string argument passed to the get_pin() method. It specifies the pin configuration:
    1. d: Indicates that we're dealing with a digital pin.
    2. 13: Specifies the number of the pin on the Arduino board.
    3. p: Indicates that we're dealing with a pin that has pwm capability.'''
led_blue=board.get_pin('d:10:p') 
led_red=board.get_pin('d:6:p')
led_green=board.get_pin('d:11:p')

#Function to convert hexcode color to rgb
def hex_to_rgb(hex_code):
  # Removing  the "#" symbol if present
  hex_code = hex_code.lstrip("#")

  # Check for valid hex code length and format
  if not ((len(hex_code) == 3) or (len(hex_code) == 6)):
    raise ValueError("Invalid hex code length. Must be 3 or 6 characters.")
  if not all(char in set("0123456789ABCDEF") for char in hex_code):
    raise ValueError("Invalid hex code characters. Must be 0-9 or A-F.")
  # Convert each hex pair to integer (base 16)
  rgb_values = tuple(int(hex_code[i:i+2], 16) for i in range(0, len(hex_code), 2))
  return rgb_values


#Function to control blue light
def blue_on():
    led_blue.write(1)
def blue_off():
    led_blue.write(0)
    
#Function to control green light
def green_on():
    led_green.write(1)
    
def green_off():
    led_green.write(0)
#Function to control red light
def red_on():
    led_red.write(1)
    
def red_off():
    led_red.write(0)
    
#multi function 
"""
    Opens a color picker dialog, converts the selected hexadecimal color to RGB,
    and sets the RGB LED values accordingly.
    """
def multi_on():
   my_color=AskColor() #ask the user to choose the colour from the colour spectrum
   c=my_color.get()

   code=hex_to_rgb(c.upper())

   led_red.write(code[0]/255.0)
   led_green.write(code[1]/255.0)
   led_blue.write(code[2]/255.0)



#Function for turning off all the lights
def   all_off():
    led_red.write(0)
    led_green.write(0)
    led_blue.write(0)

#red pulse width modulation
def red_analog_value(value):
    led_red.write(value/255.0)

#green pulse width modulation
def green_analog_value(value):
    led_green.write(value/255.0)

#blue pulse width modulation
def blue_analog_value(value):
    led_blue.write(value/255.0)






window=CTk()
window.geometry("600x300")
# Red LED Control Buttons
red_on_button=CTkButton(window, text_color="black",text="ON",fg_color="#ff0000",corner_radius=5, command=red_on ).grid(row=1, column=2, padx=20, pady=20)
red_off_button=CTkButton(window,text_color="black", text="OFF",fg_color="#ff0000",corner_radius=5, command=red_off).grid(row=1, column=3, padx=20, pady=20)
# Green LED Control Buttons
green_on_button=CTkButton(window,text_color="black", text="ON",fg_color="#00e600",corner_radius=5, command=green_on).grid(row=2, column=2, padx=20, pady=20)
green_off_button=CTkButton(window,text_color="black", text="OFF",fg_color="#00e600",corner_radius=5, command=green_off).grid(row=2, column=3, padx=20, pady=20)
# Blue LED Control Buttons
blue_on_button=CTkButton(window,text_color="black", text="ON",fg_color="#0033cc",corner_radius=5, command=blue_on).grid(row=3, column=2, padx=20, pady=20)
blue_off_button=CTkButton(window,text_color="black", text="OFF",fg_color="#0033cc",corner_radius=5, command=blue_off).grid(row=3, column=3, padx=20, pady=20)
# Multi-Color Control Buttons
multi_on_button=CTkButton(window,text_color="black", text="SET COLOUR",fg_color="#FFFFFF",corner_radius=5, command=multi_on).grid(row=4, column=2, padx=20, pady=20)
multi_off_button=CTkButton(window,text_color="black", text="ALL OFF",fg_color="#FFFFFF",corner_radius=5, command=all_off).grid(row=4, column=3, padx=20, pady=20)
#red_slider
red_slider=CTkSlider(window, from_=0, to=255, fg_color="#ff0000", command=red_analog_value)
red_slider.grid(row=1, column=4)
red_slider.set(0)
#green_slider
green_slider=CTkSlider(window, from_=0, to=255, fg_color="#00e600", command=green_analog_value)
green_slider.grid(row=2, column=4)
green_slider.set(0)
#blue_slider
blue_slider=CTkSlider(window, from_=0, to=255, fg_color="#0033cc", command=blue_analog_value)
blue_slider.grid(row=3, column=4)
blue_slider.set(0)

window.mainloop()
