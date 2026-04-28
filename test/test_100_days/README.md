# test_100_days

Generated tests for the **78 projects** in `wokwi-libs/100_Days_100_IoT_Projects/`, mapped against Velxio's current emulation capabilities.

- ✅ Velxio can run: **49**
- ❌ Cannot run as-is: **29**

Each per-project sub-folder contains:
- `source/` — verbatim copy of the project's user code
- `test_project.py` — the test (static analysis + optional live backend handshake)
- `NOT_SUPPORTED.md` (only when the project cannot be emulated) — explains exactly which Velxio capability is missing and what would be needed to add it

## How to run

```bash
# Static analysis only (no backend required) — fast, works offline:
python -m pytest test/test_100_days -v

# Include live backend smoke checks:
cd backend && uvicorn app.main:app --port 8001  # in another terminal
VELXIO_BACKEND_URL=http://localhost:8001 \\
  python -m pytest test/test_100_days -v
```

Re-generate after pulling new projects:

```bash
python test/test_100_days/_generate.py
```

## Capability matrix used for classification

| Capability | Velxio support |
|---|---|
| Arduino UNO / Nano / Mega (AVR) | ✅ avr8js |
| Raspberry Pi Pico / Pico W | ✅ rp2040js |
| ESP32 / ESP32-S3 / ESP32-C3 | ✅ Espressif QEMU |
| ATtiny85 | ✅ avr8js |
| **ESP8266** | ❌ no QEMU/firmware |
| MicroPython on Pico | ✅ MicroPythonLoader |
| MicroPython on ESP32 family | ✅ Esp32MicroPythonLoader |
| WiFi (TCP/UDP through host) | ✅ slirp NIC |
| **ESP-NOW (peer-to-peer 802.11)** | ❌ no virtual 802.11 hub |
| **BLE GATT** | ⚠️ status events only |
| Tkinter / Flask / Matplotlib (host-side) | ❌ host-only |

## Project index

| # | Project | Status | Board | Features |
|---:|---|---|---|---|
| 1 | [AQI_ESP](./AQI_ESP/) | ✅ | `esp32` | wifi, flask, i2c_oled, dht, http_server |
| 2 | [Auto_Night_Light_using_LDR_(ESP32_+_MicroPython)](./Auto_Night_Light_using_LDR_ESP32_plus_MicroPython/) | ✅ | `esp32` | ldr |
| 3 | [Basic_RTC_Clock_(_Serial_Monitor_Display_)](./Basic_RTC_Clock_Serial_Monitor_Display/) | ❌ | `esp8266` | rtc |
| 4 | [Battery_Monitor_with_Blynk_IoT](./Battery_Monitor_with_Blynk_IoT/) | ✅ | `esp32` | wifi, blynk, blynk_cloud |
| 5 | [Bidirectional_ESP_NOW_Communication_with_Dual_Sensor_Nodes](./Bidirectional_ESP_NOW_Communication_with_Dual_Sensor_Nodes/) | ❌ | `esp8266` | wifi, esp_now, i2c_oled, dht, ota |
| 6 | [Bluetooth_Based_Wireless_LED_Control_System](./Bluetooth_Based_Wireless_LED_Control_System/) | ✅ | `esp32` | ble |
| 7 | [Blynk_Based_IoT_Relay_Control_(MicroPython)](./Blynk_Based_IoT_Relay_Control_MicroPython/) | ✅ | `rp2040` | wifi, blynk, blynk_cloud |
| 8 | [Blynk_Controlled_DC_Brushless_Fan](./Blynk_Controlled_DC_Brushless_Fan/) | ✅ | `esp32` | wifi, blynk, blynk_cloud |
| 9 | [Clap_Toggle_Switch_using_ESP32_&_Digital_Sound_Sensor_(MicroPython)](./Clap_Toggle_Switch_using_ESP32_and_Digital_Sound_Sensor_MicroPython/) | ✅ | `esp32` | — |
| 10 | [ClimaPixel_Mini_Weather_Display](./ClimaPixel_Mini_Weather_Display/) | ❌ | `esp8266` | i2c_oled, dht |
| 11 | [DC_Motor_Speed_Control_(Web_Slider)](./DC_Motor_Speed_Control_Web_Slider/) | ✅ | `esp32` | wifi, servo |
| 12 | [DHT11_LCD_Display_using_ESP8266_&_MicroPython](./DHT11_LCD_Display_using_ESP8266_and_MicroPython/) | ❌ | `esp8266` | dht, lcd |
| 13 | [DHT11_Web_Server_using_ESP32_&_MicroPython](./DHT11_Web_Server_using_ESP32_and_MicroPython/) | ✅ | `esp32` | wifi, dht |
| 14 | [Dimmer_LED_using_Potentiometer_(MicroPython)](./Dimmer_LED_using_Potentiometer_MicroPython/) | ✅ | `esp32` | servo |
| 15 | [Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts](./Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts/) | ✅ | `esp32` | wifi, telegram |
| 16 | [EEPROM_Simulation_using_MicroPython_on_ESP32_(Wokwi)](./EEPROM_Simulation_using_MicroPython_on_ESP32_Wokwi/) | ✅ | `esp32` | — |
| 17 | [ESP32_BLE_LED_Control](./ESP32_BLE_LED_Control/) | ✅ | `esp32` | ble |
| 18 | [ESP32_Hotspot_(Access_Point)_Setup_MicroPython](./ESP32_Hotspot_Access_Point_Setup_MicroPython/) | ✅ | `esp32` | wifi |
| 19 | [ESP32_IR_Sensor_Telegram_Alert_(MicroPython)](./ESP32_IR_Sensor_Telegram_Alert_MicroPython/) | ✅ | `esp32` | wifi, telegram |
| 20 | [ESP32_OLED_Smart_UI_Eyes_Animation_Time_&_Weather_(MicroPython)](./ESP32_OLED_Smart_UI_Eyes_Animation_Time_and_Weather_MicroPython/) | ✅ | `esp32` | wifi, i2c_oled |
| 21 | [ESP32_Student_Management_System](./ESP32_Student_Management_System/) | ❌ | `esp8266` | i2c_oled, ota |
| 22 | [ESP8266_DHT11_Live_Graph_(MicroPython_+_Matplotlib)](./ESP8266_DHT11_Live_Graph_MicroPython_plus_Matplotlib/) | ❌ | `esp8266` | matplotlib, dht |
| 23 | [ESP8266_LED_CONTROL_BY_PUSH_BUTTON_ESP_NOW](./ESP8266_LED_CONTROL_BY_PUSH_BUTTON_ESP_NOW/) | ❌ | `esp8266` | wifi, esp_now |
| 24 | [ESP8266_NTP_Digital_Clock_MicroPython](./ESP8266_NTP_Digital_Clock_MicroPython/) | ❌ | `esp8266` | wifi, tm1637 |
| 25 | [ESP8266_TM1637_Button_Press_Counter_(MicroPython)](./ESP8266_TM1637_Button_Press_Counter_MicroPython/) | ❌ | `esp8266` | tm1637 |
| 26 | [ESP8266_Touch_Sensor_LED_Control_(MicroPython)](./ESP8266_Touch_Sensor_LED_Control_MicroPython/) | ❌ | `esp8266` | — |
| 27 | [ESP_NOW_HOME_AUTOMATION](./ESP_NOW_HOME_AUTOMATION/) | ❌ | `esp32` | wifi, esp_now |
| 28 | [ESP_NOW_HOME_AUTOMATION_WITH_TEMP_MONITORING_WITH_OLED](./ESP_NOW_HOME_AUTOMATION_WITH_TEMP_MONITORING_WITH_OLED/) | ❌ | `esp32` | wifi, esp_now, i2c_oled, dht |
| 29 | [ESP_NOW_RFID_Display](./ESP_NOW_RFID_Display/) | ❌ | `esp8266` | wifi, esp_now, i2c_oled, rfid, ota |
| 30 | [Flask_Server_Based_LED_Control_using_MicroPython](./Flask_Server_Based_LED_Control_using_MicroPython/) | ✅ | `esp32` | wifi, flask, http_server |
| 31 | [Interactive_LED_Control_System](./Interactive_LED_Control_System/) | ❌ | `?` | pyfirmata, tkinter |
| 32 | [IoT_Atmospheric_Monitoring_System_using_ESP32,_wowki_&_Blynk](./IoT_Atmospheric_Monitoring_System_using_ESP32_wowki_and_Blynk/) | ✅ | `esp32` | wifi, blynk, blynk_cloud |
| 33 | [IoT_Based_DSM_Smart_Metering](./IoT_Based_DSM_Smart_Metering/) | ✅ | `esp32` | wifi, blynk, blynk_cloud, ota |
| 34 | [IoT_Based_Soil_&_Weather_Monitoring_using_ESP8266_and_ThingSpeak](./IoT_Based_Soil_and_Weather_Monitoring_using_ESP8266_and_ThingSpeak/) | ❌ | `esp8266` | wifi, thingspeak, dht |
| 35 | [IoT_Button_Counter_using_ESP8266_&_MicroPython](./IoT_Button_Counter_using_ESP8266_and_MicroPython/) | ❌ | `esp8266` | wifi |
| 36 | [IoT_Environment_Monitoring_With_Anomaly_Detection](./IoT_Environment_Monitoring_With_Anomaly_Detection/) | ✅ | `esp32` | wifi, thingspeak, dht, ldr |
| 37 | [IoT_Relay_Control_Web_Server_(Raspberry_Pi_Pico_2W)](./IoT_Relay_Control_Web_Server_Raspberry_Pi_Pico_2W/) | ✅ | `pico-w` | wifi |
| 38 | [IoT_Smart_Irrigation_System](./IoT_Smart_Irrigation_System/) | ✅ | `esp32` | wifi, blynk, blynk_cloud |
| 39 | [Joystick_Controlled_Servo](./Joystick_Controlled_Servo/) | ✅ | `esp32` | servo |
| 40 | [Joystick_Direction_Display_with_OLED](./Joystick_Direction_Display_with_OLED/) | ✅ | `rp2040` | i2c_oled |
| 41 | [Led_ON_OFF_By_Input_from_one_ESP8266](./Led_ON_OFF_By_Input_from_one_ESP8266/) | ❌ | `esp8266` | wifi, esp_now |
| 42 | [MQ4_Gas_Leak_Detection_System_using_ESP32_and_MicroPython](./MQ4_Gas_Leak_Detection_System_using_ESP32_and_MicroPython/) | ✅ | `esp32` | — |
| 43 | [MQ7_CO_Gas_Detection_ESP32](./MQ7_CO_Gas_Detection_ESP32/) | ✅ | `esp32` | — |
| 44 | [MQ_135_Gas_Sensor_with_ESP32_(MicroPython)](./MQ_135_Gas_Sensor_with_ESP32_MicroPython/) | ✅ | `esp32` | ota |
| 45 | [MicroPython_Based_8×8_LED_Matrix_Animation_Display_using_ESP8266](./MicroPython_Based_8_8_LED_Matrix_Animation_Display_using_ESP8266/) | ❌ | `esp8266` | max7219 |
| 46 | [MicroPython_Watch](./MicroPython_Watch/) | ✅ | `esp32` | wifi, i2c_oled |
| 47 | [NTP_Synchronized_Digital_Clock_using_ESP32_&_MAX7219](./NTP_Synchronized_Digital_Clock_using_ESP32_and_MAX7219/) | ✅ | `esp32` | wifi, max7219 |
| 48 | [OTA_Update_Pico2W](./OTA_Update_Pico2W/) | ✅ | `rp2040` | wifi, ota |
| 49 | [PIR_Motion_Detector_using_Raspberry_Pi_Pico_2W_&_MicroPython](./PIR_Motion_Detector_using_Raspberry_Pi_Pico_2W_and_MicroPython/) | ✅ | `pico-w` | — |
| 50 | [Password_Lock_System_using_ESP32](./Password_Lock_System_using_ESP32/) | ✅ | `esp32` | lcd |
| 51 | [Pico_2_W_Dht11_Http_Csv_Logger](./Pico_2_W_Dht11_Http_Csv_Logger/) | ✅ | `rp2040` | wifi, flask, dht, http_server |
| 52 | [Pico_W_Async_LED_Control_(MicroPython)](./Pico_W_Async_LED_Control_MicroPython/) | ✅ | `pico-w` | wifi |
| 53 | [Pico_W_Web_Servo_Controller](./Pico_W_Web_Servo_Controller/) | ✅ | `pico-w` | wifi, servo, ota |
| 54 | [Potentiometer_Visualizer](./Potentiometer_Visualizer/) | ✅ | `esp32` | — |
| 55 | [Pulse_Monitor](./Pulse_Monitor/) | ✅ | `esp32` | i2c_oled |
| 56 | [RFID_Attendance_Logger](./RFID_Attendance_Logger/) | ❌ | `esp8266` | wifi, rfid, ota |
| 57 | [RFID_Basic_Access_Control_System](./RFID_Basic_Access_Control_System/) | ❌ | `esp8266` | rfid, ota |
| 58 | [RFID_Relay_Control_System](./RFID_Relay_Control_System/) | ❌ | `esp8266` | rfid, ota |
| 59 | [RGB_Color_Mixer_using_Potentiometers_(ESP32_+_MicroPython)](./RGB_Color_Mixer_using_Potentiometers_ESP32_plus_MicroPython/) | ✅ | `esp32` | servo |
| 60 | [Rain_Detection_System_using_ESP8266_(Analog_Mode)](./Rain_Detection_System_using_ESP8266_Analog_Mode/) | ❌ | `esp8266` | — |
| 61 | [Raspberry_Pi_Pico_2_W_ThingsBoard_IoT](./Raspberry_Pi_Pico_2_W_ThingsBoard_IoT/) | ✅ | `pico-w` | wifi, mqtt, dht |
| 62 | [Servo_Motor_Control_with_Raspberry_Pi_Pico_2_W_(MicroPython)](./Servo_Motor_Control_with_Raspberry_Pi_Pico_2_W_MicroPython/) | ✅ | `pico-w` | servo |
| 63 | [Single_Digit_Seven_Segment_Display_with_Raspberry_Pi-Pico_(MicroPython)](./Single_Digit_Seven_Segment_Display_with_Raspberry_Pi_Pico_MicroPython/) | ✅ | `rp2040` | — |
| 64 | [Smart_Cooling_System_using_ESP8266_DHT11_&_Relay](./Smart_Cooling_System_using_ESP8266_DHT11_and_Relay/) | ❌ | `esp8266` | dht |
| 65 | [Smart_Home_Automation_System](./Smart_Home_Automation_System/) | ✅ | `esp32` | wifi, blynk, blynk_cloud, dht |
| 66 | [Smart_IR_Object_Detection_System](./Smart_IR_Object_Detection_System/) | ❌ | `esp8266` | — |
| 67 | [Smart_Indoor_Security_System](./Smart_Indoor_Security_System/) | ✅ | `esp32` | wifi |
| 68 | [Smart_IoT_Gas_Monitoring_System](./Smart_IoT_Gas_Monitoring_System/) | ✅ | `esp32` | wifi, flask, matplotlib, dht, http_server |
| 69 | [Soil_Moisture_Sensor_DryWet_Detection_(ESP8266_MicroPython)](./Soil_Moisture_Sensor_DryWet_Detection_ESP8266_MicroPython/) | ❌ | `esp8266` | — |
| 70 | [Stepper_Motor_Control_using_ESP32_&_A4988_(MicroPython)](./Stepper_Motor_Control_using_ESP32_and_A4988_MicroPython/) | ✅ | `esp32` | stepper |
| 71 | [Temperature_Based_LED_Indicator_(MicroPython_ESP32)](./Temperature_Based_LED_Indicator_MicroPython_ESP32/) | ✅ | `esp32` | wifi, servo |
| 72 | [Ultrasonic_LED_Distance_Indicator_ESP32_MicroPython](./Ultrasonic_LED_Distance_Indicator_ESP32_MicroPython/) | ✅ | `esp32` | ultrasonic |
| 73 | [Voice_Activated_LED_Control_System](./Voice_Activated_LED_Control_System/) | ❌ | `?` | pyfirmata |
| 74 | [WebSocket_LED_Control_using_Raspberry_Pi_Pico_W](./WebSocket_LED_Control_using_Raspberry_Pi_Pico_W/) | ✅ | `pico-w` | wifi, websocket |
| 75 | [Wi_Fi_Controlled_4WD_Robot_Car](./Wi_Fi_Controlled_4WD_Robot_Car/) | ✅ | `esp32` | wifi |
| 76 | [XIAO_ESP32_4_LED_Control_using_CustomTkinter_&_MicroPython](./XIAO_ESP32_4_LED_Control_using_CustomTkinter_and_MicroPython/) | ❌ | `xiao-esp32` | tkinter |
| 77 | [microclawup_AI_Powered_ESP32_GPIO_Controller_(MicroPython)](./microclawup_AI_Powered_ESP32_GPIO_Controller_MicroPython/) | ❌ | `esp32` | — |
| 78 | [micropidash_MicroPython_IoT_Dashboard_Library](./micropidash_MicroPython_IoT_Dashboard_Library/) | ❌ | `?` | — |

---

Generated by `_generate.py` — do not edit by hand.
