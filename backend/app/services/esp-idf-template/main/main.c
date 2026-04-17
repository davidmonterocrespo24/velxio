/**
 * Pure ESP-IDF main entry point (no Arduino component).
 *
 * Used when ARDUINO_ESP32_PATH is not set.  The build system generates
 * a translated sketch (sketch_translated.c) from the user's Arduino code,
 * converting common Arduino API calls to ESP-IDF equivalents.
 *
 * This file is only compiled when Arduino-as-component is unavailable.
 */
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_http_server.h"
#include "driver/gpio.h"
#include "lwip/ip4_addr.h"

/* User-translated sketch is included here */
#include "sketch_translated.c"
