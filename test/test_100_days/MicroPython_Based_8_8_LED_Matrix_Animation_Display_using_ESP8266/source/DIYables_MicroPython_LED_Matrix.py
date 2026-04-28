"""
This MicroPython library is designed for any hardware plaform that supports MicroPython such as Raspberry Pi Pico, ESP32, Micro:bit... to work with the LED Matrix. It is created by DIYables to work with DIYables LED Matrix, but also work with other brand LED Matrix. Please consider purchasing products from DIYables to support our work.

Product Link:
- [LED Matrix 8x8](https://diyables.io/products/dot-matrix-display-fc16-8x8-led)
- [LED Matrix 32x8](https://diyables.io/products/dot-matrix-display-fc16-4-in-1-32x4-led)


Copyright (c) 2024, DIYables.io. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.

- Neither the name of the DIYables.io nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY DIYABLES.IO "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL DIYABLES.IO BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
"""

from machine import Pin, SPI

class Font:
    def __init__(self):
        self.font = self._generate_font()

    def get_char(self, char):
        """Retrieve the bitmap for a given character."""
        return self.font.get(char, [0b00000000] * 8)  # Return empty 8x8 matrix if char not found

    def _generate_font(self):
        """Generate ASCII and degree symbol font."""
        font = {
            ' ': [ 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '!': [ 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00000000, 0b00000000, 0b00011000, 0b00000000 ],
            '"': [ 0b01100110, 0b01100110, 0b01100110, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '#': [ 0b01100110, 0b01100110, 0b11111111, 0b01100110, 0b11111111, 0b01100110, 0b01100110, 0b00000000 ],
            '$': [ 0b00011000, 0b00111110, 0b01100000, 0b00111100, 0b00000110, 0b01111100, 0b00011000, 0b00000000 ],
            '%': [ 0b01100010, 0b01100110, 0b00001100, 0b00011000, 0b00110000, 0b01100110, 0b01000110, 0b00000000 ],
            '&': [ 0b00111100, 0b01100110, 0b00111100, 0b00111000, 0b01100111, 0b01100110, 0b00111111, 0b00000000 ],
            '\'': [ 0b00000110, 0b00001100, 0b00011000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '(': [ 0b00001100, 0b00011000, 0b00110000, 0b00110000, 0b00110000, 0b00011000, 0b00001100, 0b00000000 ],
            ')': [ 0b00110000, 0b00011000, 0b00001100, 0b00001100, 0b00001100, 0b00011000, 0b00110000, 0b00000000 ],
            '*': [ 0b00000000, 0b01100110, 0b00111100, 0b11111111, 0b00111100, 0b01100110, 0b00000000, 0b00000000 ],
            '+': [ 0b00000000, 0b00011000, 0b00011000, 0b01111110, 0b00011000, 0b00011000, 0b00000000, 0b00000000 ],
            ',': [ 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00011000, 0b00011000, 0b00110000 ],
            '-': [ 0b00000000, 0b00000000, 0b00000000, 0b01111110, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '.': [ 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00011000, 0b00011000, 0b00000000 ],
            '/': [ 0b00000000, 0b00000011, 0b00000110, 0b00001100, 0b00011000, 0b00110000, 0b01100000, 0b00000000 ],
            '0': [ 0b00111100, 0b01100110, 0b01101110, 0b01110110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            '1': [ 0b00011000, 0b00011000, 0b00111000, 0b00011000, 0b00011000, 0b00011000, 0b01111110, 0b00000000 ],
            '2': [ 0b00111100, 0b01100110, 0b00000110, 0b00001100, 0b00110000, 0b01100000, 0b01111110, 0b00000000 ],
            '3': [ 0b00111100, 0b01100110, 0b00000110, 0b00011100, 0b00000110, 0b01100110, 0b00111100, 0b00000000 ],
            '4': [ 0b00000110, 0b00001110, 0b00011110, 0b01100110, 0b01111111, 0b00000110, 0b00000110, 0b00000000 ],
            '5': [ 0b01111110, 0b01100000, 0b01111100, 0b00000110, 0b00000110, 0b01100110, 0b00111100, 0b00000000 ],
            '6': [ 0b00111100, 0b01100110, 0b01100000, 0b01111100, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            '7': [ 0b01111110, 0b01100110, 0b00001100, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00000000 ],
            '8': [ 0b00111100, 0b01100110, 0b01100110, 0b00111100, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            '9': [ 0b00111100, 0b01100110, 0b01100110, 0b00111110, 0b00000110, 0b01100110, 0b00111100, 0b00000000 ],
            ':': [ 0b00000000, 0b00000000, 0b00011000, 0b00000000, 0b00000000, 0b00011000, 0b00000000, 0b00000000 ],
            ';': [ 0b00000000, 0b00000000, 0b00011000, 0b00000000, 0b00000000, 0b00011000, 0b00011000, 0b00110000 ],
            '<': [ 0b00001110, 0b00011000, 0b00110000, 0b01100000, 0b00110000, 0b00011000, 0b00001110, 0b00000000 ],
            '=': [ 0b00000000, 0b00000000, 0b01111110, 0b00000000, 0b01111110, 0b00000000, 0b00000000, 0b00000000 ],
            '>': [ 0b01110000, 0b00011000, 0b00001100, 0b00000110, 0b00001100, 0b00011000, 0b01110000, 0b00000000 ],
            '?': [ 0b00111100, 0b01100110, 0b00000110, 0b00001100, 0b00011000, 0b00000000, 0b00011000, 0b00000000 ],
            '@': [ 0b00111100, 0b01100110, 0b01101110, 0b01101110, 0b01100000, 0b01100010, 0b00111100, 0b00000000 ],
            'A': [ 0b00011000, 0b00111100, 0b01100110, 0b01111110, 0b01100110, 0b01100110, 0b01100110, 0b00000000 ],
            'B': [ 0b01111100, 0b01100110, 0b01100110, 0b01111100, 0b01100110, 0b01100110, 0b01111100, 0b00000000 ],
            'C': [ 0b00111100, 0b01100110, 0b01100000, 0b01100000, 0b01100000, 0b01100110, 0b00111100, 0b00000000 ],
            'D': [ 0b01111000, 0b01101100, 0b01100110, 0b01100110, 0b01100110, 0b01101100, 0b01111000, 0b00000000 ],
            'E': [ 0b01111110, 0b01100000, 0b01100000, 0b01111000, 0b01100000, 0b01100000, 0b01111110, 0b00000000 ],
            'F': [ 0b01111110, 0b01100000, 0b01100000, 0b01111000, 0b01100000, 0b01100000, 0b01100000, 0b00000000 ],
            'G': [ 0b00111100, 0b01100110, 0b01100000, 0b01101110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            'H': [ 0b01100110, 0b01100110, 0b01100110, 0b01111110, 0b01100110, 0b01100110, 0b01100110, 0b00000000 ],
            'I': [ 0b00111100, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00111100, 0b00000000 ],
            'J': [ 0b00011110, 0b00001100, 0b00001100, 0b00001100, 0b00001100, 0b01101100, 0b00111000, 0b00000000 ],
            'K': [ 0b01100110, 0b01101100, 0b01111000, 0b01110000, 0b01111000, 0b01101100, 0b01100110, 0b00000000 ],
            'L': [ 0b01100000, 0b01100000, 0b01100000, 0b01100000, 0b01100000, 0b01100000, 0b01111110, 0b00000000 ],
            'M': [ 0b01100011, 0b01110111, 0b01111111, 0b01101011, 0b01100011, 0b01100011, 0b01100011, 0b00000000 ],
            'N': [ 0b01100110, 0b01110110, 0b01111110, 0b01111110, 0b01101110, 0b01100110, 0b01100110, 0b00000000 ],
            'O': [ 0b00111100, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            'P': [ 0b01111100, 0b01100110, 0b01100110, 0b01111100, 0b01100000, 0b01100000, 0b01100000, 0b00000000 ],
            'Q': [ 0b00111100, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00001110, 0b00000000 ],
            'R': [ 0b01111100, 0b01100110, 0b01100110, 0b01111100, 0b01111000, 0b01101100, 0b01100110, 0b00000000 ],
            'S': [ 0b00111100, 0b01100110, 0b01100000, 0b00111100, 0b00000110, 0b01100110, 0b00111100, 0b00000000 ],
            'T': [ 0b01111110, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00000000 ],
            'U': [ 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            'V': [ 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00011000, 0b00000000 ],
            'W': [ 0b01100011, 0b01100011, 0b01100011, 0b01101011, 0b01111111, 0b01110111, 0b01100011, 0b00000000 ],
            'X': [ 0b01100110, 0b01100110, 0b00111100, 0b00011000, 0b00111100, 0b01100110, 0b01100110, 0b00000000 ],
            'Y': [ 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00011000, 0b00011000, 0b00011000, 0b00000000 ],
            'Z': [ 0b01111110, 0b00000110, 0b00001100, 0b00011000, 0b00110000, 0b01100000, 0b01111110, 0b00000000 ],
            '[': [ 0b00111100, 0b00110000, 0b00110000, 0b00110000, 0b00110000, 0b00110000, 0b00111100, 0b00000000 ],
            '\\': [ 0b00000000, 0b01100000, 0b00110000, 0b00011000, 0b00001100, 0b00000110, 0b00000011, 0b00000000 ],
            ']': [ 0b00111100, 0b00001100, 0b00001100, 0b00001100, 0b00001100, 0b00001100, 0b00111100, 0b00000000 ],
            '^': [ 0b00000000, 0b00011000, 0b00111100, 0b01100110, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '_': [ 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b11111111, 0b11111111 ],
            '`': [ 0b00110000, 0b00011000, 0b00001100, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            'a': [ 0b00000000, 0b00000000, 0b00111100, 0b00000110, 0b00111110, 0b01100110, 0b00111110, 0b00000000 ],
            'b': [ 0b01100000, 0b01100000, 0b01111100, 0b01100110, 0b01100110, 0b01100110, 0b01111100, 0b00000000 ],
            'c': [ 0b00000000, 0b00000000, 0b00111100, 0b01100110, 0b01100000, 0b01100110, 0b00111100, 0b00000000 ],
            'd': [ 0b00000110, 0b00000110, 0b00111110, 0b01100110, 0b01100110, 0b01100110, 0b00111110, 0b00000000 ],
            'e': [ 0b00000000, 0b00000000, 0b00111100, 0b01100110, 0b01111110, 0b01100000, 0b00111110, 0b00000000 ],
            'f': [ 0b00011100, 0b00110110, 0b00110000, 0b01111000, 0b00110000, 0b00110000, 0b00110000, 0b00000000 ],
            'g': [ 0b00000000, 0b00000000, 0b00111110, 0b01100110, 0b01100110, 0b00111110, 0b00000110, 0b01111100 ],
            'h': [ 0b01100000, 0b01100000, 0b01111100, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00000000 ],
            'i': [ 0b00011000, 0b00000000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00000000 ],
            'j': [ 0b00000110, 0b00000000, 0b00000110, 0b00000110, 0b00000110, 0b00000110, 0b01100110, 0b00111100 ],
            'k': [ 0b01100000, 0b01100000, 0b01100110, 0b01101100, 0b01111000, 0b01111100, 0b01100110, 0b00000000 ],
            'l': [ 0b00111000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00111100, 0b00000000 ],
            'm': [ 0b00000000, 0b00000000, 0b01100011, 0b01110111, 0b01111111, 0b01101011, 0b01100011, 0b00000000 ],
            'n': [ 0b00000000, 0b00000000, 0b01111100, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00000000 ],
            'o': [ 0b00000000, 0b00000000, 0b00111100, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            'p': [ 0b00000000, 0b00000000, 0b01111100, 0b01100110, 0b01100110, 0b01111100, 0b01100000, 0b01100000 ],
            'q': [ 0b00000000, 0b00000000, 0b00111110, 0b01100110, 0b01100110, 0b00111110, 0b00000110, 0b00000110 ],
            'r': [ 0b00000000, 0b00000000, 0b01111100, 0b01100110, 0b01100000, 0b01100000, 0b01100000, 0b00000000 ],
            's': [ 0b00000000, 0b00000000, 0b00111100, 0b01100000, 0b00111100, 0b00000110, 0b01111100, 0b00000000 ],
            't': [ 0b00110000, 0b00110000, 0b11111100, 0b00110000, 0b00110000, 0b00110110, 0b00011100, 0b00000000 ],
            'u': [ 0b00000000, 0b00000000, 0b01100110, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00000000 ],
            'v': [ 0b00000000, 0b00000000, 0b01100110, 0b01100110, 0b01100110, 0b00111100, 0b00011000, 0b00000000 ],
            'w': [ 0b00000000, 0b00000000, 0b01100011, 0b01101011, 0b01111111, 0b00110110, 0b00100010, 0b00000000 ],
            'x': [ 0b00000000, 0b00000000, 0b01100110, 0b00111100, 0b00011000, 0b00111100, 0b01100110, 0b00000000 ],
            'y': [ 0b00000000, 0b00000000, 0b01100110, 0b01100110, 0b01100110, 0b00111110, 0b00000110, 0b01111100 ],
            'z': [ 0b00000000, 0b00000000, 0b01111110, 0b00001100, 0b00011000, 0b00110000, 0b01111110, 0b00000000 ],
            '{': [ 0b00001110, 0b00011000, 0b00011000, 0b01110000, 0b00011000, 0b00011000, 0b00001110, 0b00000000 ],
            '|': [ 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00011000 ],
            '}': [ 0b01110000, 0b00011000, 0b00011000, 0b00001110, 0b00011000, 0b00011000, 0b01110000, 0b00000000 ],
            '~': [ 0b00111011, 0b01101110, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000 ],
            '°': [0b00011000, 0b00100100, 0b00100100, 0b00011000, 0b00000000, 0b00000000, 0b00000000, 0b00000000]  # Degree symbol
        }
        return font




class Max7219:
    def __init__(self, spi, cs, num_matrices=4):
        self.spi = spi
        self.cs = cs
        self.num_matrices = num_matrices
        self.display_width = num_matrices * 8
        self.display_height = 8
        self.display_buffer = [0] * self.display_height  # 8 rows, each with num_matrices * 8 columns
        self.font = Font()  # Use the Font class for font lookup

        self.cs.init(Pin.OUT)
        self.initialize_max7219()

    # Function to send data to the MAX7219s
    def send_command_all(self, register, data):
        self.cs.off()
        for _ in range(self.num_matrices):
            self.spi.write(bytearray([register, data]))
        self.cs.on()

    # Function to initialize the MAX7219s
    def initialize_max7219(self):
        self.send_command_all(0x0C, 0x01)  # Exit shutdown mode
        self.send_command_all(0x09, 0x00)  # Disable decode mode
        self.send_command_all(0x0A, 0x0F)  # Set intensity (0x00 to 0x0F)
        self.send_command_all(0x0B, 0x07)  # Set scan limit (0 to 7, i.e., all 8 rows)
        self.send_command_all(0x0F, 0x00)  # Disable display test mode

    # Function to clear the display
    def clear(self):
        self.display_buffer = [0] * self.display_height  # Clear the buffer

    # Function to write the buffer to the display
    def show(self):
        for row in range(self.display_height):
            self.cs.off()
            # Send row data to all cascaded matrices
            for matrix in range(self.num_matrices):
                # Extract the correct 8-bit segment for this matrix from the display buffer row
                data_byte = (self.display_buffer[row] >> (8 * (self.num_matrices - 1 - matrix))) & 0xFF
                # Send the row address and the corresponding data byte
                self.spi.write(bytearray([row + 1, data_byte]))
            self.cs.on()

    # Function to trim a character bitmap
    def trim_character(self, bitmap):
        left, right = 7, 0
        for col in range(8):  # Iterate through each column
            # Check if any pixel is set in the current column across all rows
            column_has_pixel = False
            for row in range(8):
                if bitmap[row] & (1 << (7 - col)):  # Check pixel in the current column
                    column_has_pixel = True
                    break  # No need to check further if we find a set pixel in this column
            
            # Update left and right bounds based on the first and last columns with pixels
            if column_has_pixel:
                left = min(left, col)
                right = max(right, col)

        # Ensure we don't trim a character to zero width (add minimum width if needed)
        if right < left:
            left, right = 0, 0

        return left, right

    # Function to set the brightness
    def set_brightness(self, brightness):
        if 0 <= brightness <= 15:
            self.send_command_all(0x0A, brightness)
        else:
            raise ValueError("Brightness must be between 0 (min) and 15 (max)")

    # Function to display a character at a specific column
    def print_bitmap(self, bitmap, start_col = 0):
        left, right = self.trim_character(bitmap)
        char_width = right - left + 1

        for row in range(8):
            for col in range(left, right + 1):
                if start_col + (col - left) < self.display_width:
                    self.display_buffer[row] |= ((bitmap[row] >> (7 - col)) & 0x01) << (self.display_width - 1 - (start_col + (col - left)))

        return char_width

    def print_char(self, char, start_col = 0):
        bitmap = self.font.get_char(char)
        return self.print_bitmap(bitmap, start_col)

    # Function to render text with a 2-pixel gap
    def print(self, text, spacing=2, col = 0):
        current_col = col
        for char in text:
            char_width = self.print_char(char, current_col)
            current_col += char_width + spacing
            if current_col >= self.display_width:
                break

    # Function to display a character at a specific column
    def print_custom_char(self, bitmap, col = 0):
        char_width =  self.print_bitmap(bitmap, col)
        return char_width
