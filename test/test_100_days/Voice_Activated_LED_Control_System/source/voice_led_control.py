import speech_recognition as sr # Import the speech recognition library
import pyttsx3 # Import the text-to-speech library
import pyfirmata2 # Import the library for Arduino communication

recognixer=sr.Recognizer() # Create a speech recognizer object
engine=pyttsx3.init() # Initialize the text-to-speech engine
voices = engine.getProperty('voices')       # Get the available voices

engine.setProperty('rate', 125)     # Set the speech rate
engine.setProperty('voice', voices[1].id)  # Set the voice (1 for female)

# Define the serial port for Arduino communication
port="COM4"
board=pyfirmata2.Arduino(port)# Initialize the Arduino board

# Get pin objects for each LED
yellow_led_pin=board.get_pin('d:8:o') # Digital pin 8, output mode
green_led_pin=board.get_pin('d:5:o') # Digital pin 5, output mode
blue_led_pin=board.get_pin('d:7:o') # Digital pin 7, output mode
red_led_pin=board.get_pin('d:6:o') # Digital pin 6, output mode


def speak(text):
    """Converts the given text to speech."""
    engine.say(text)
    # engine.setProperty('voice', voices[0].id)   #changing index, changes voices. 1 for female
    engine.runAndWait()

def takeCommand():
    """Listens for voice commands and returns the recognized text."""
    r=sr.Recognizer() # Create a speech recognizer object
    with sr.Microphone() as source:  # Use the microphone as the audio source
        
        print("Listening..........")
        audio=r.listen(source) # Listen for audio input
        try:
            print("Recognizing......")
            query=r.recognize_google(audio, language='en-in')# Recognize speech using Google's API
        except Exception as e:
            print("Try again")
            return "None" # Return "None" if recognition fails
        return query # Return the recognized text
    
if __name__=="__main__":
    while True: # Loop indefinitely
        query=takeCommand().lower() # Get voice command and convert to lowercase
        # Check for specific voice commands and control LEDs accordingly
        if "on the yellow light" in query:
            print("Light is on")
            speak("Turning on the yellow light") # Turn on the yellow LED
            yellow_led_pin.write(1)
        elif "on the red light" in query:
            print("Light is on")
            speak("Turning on the red light") # Turn on the red LED
            red_led_pin.write(1)
        elif "on the green light" in query:
            print("Light is on")
            speak("Turning on the green light") # Turn on the green LED
            green_led_pin.write(1)
        elif "on the blue light" in query:
            print("Light is on")
            speak("Turning on the blue light") # Turn on the blue LED
            blue_led_pin.write(1)
        elif "light off" in query:
            # Turn off all LEDs

            print("light off")
            speak("Turning of all the lights")
        
            yellow_led_pin.write(0)
            red_led_pin.write(0)
            green_led_pin.write(0)
            blue_led_pin.write(0)
        
        

        elif "thank you" in query:
            break # Exit the loop if "thank you" is spoken
        
