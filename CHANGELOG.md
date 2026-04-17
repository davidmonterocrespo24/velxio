# Changelog

All notable changes to Velxio will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.1] - 2026-04-17

### Added
- Added ATtiny85 support with examples and simulation tests
- Added BMP280 sensor component with circuit preview and SVG representation
- Added example detail pages with improved SEO and sitemap generation
- Added MicroPython support for RP2040 (Pico), ESP32, ESP32-S3, and ESP32-C3 boards
- Added ability to upload precompiled firmware files (.hex, .bin, .elf) directly into the emulator
- Added ability to remove boards from workspace with confirmation dialog
- Added I2C sensor support with slave emulation for MPU6050, BMP280, DS1307, and DS3231 sensors
- Added ESP32 WiFi/BLE emulation with ESP-IDF compilation pipeline
- Added VS Code extension skeleton for local simulation
- Added comprehensive documentation for ESP32 GPIO sensor simulation, Docker infrastructure, and MicroPython implementation
- Added auto-compile feature that triggers compilation when pressing Play if code changed or no firmware loaded
- Added share functionality for projects and examples with visibility toggle
- Added component metadata overrides and enhanced property controls
- Added new CI/CD workflows for backend unit tests, end-to-end tests, and automated Discord release notifications
- Added Docker multi-architecture support (amd64 + arm64) and pre-built ESP-IDF toolchain image

### Changed
- Enhanced auto-compile to use board's file group for WiFi detection instead of legacy global files
- Updated CircuitPreview component and implemented ShareModal using createPortal
- Enhanced Arduino pin tracing in DynamicComponent and updated LittleFS WASM initialization
- Enhanced ESP-IDF compiler library resolution logic and added support for dynamic library detection
- Enhanced wire connection handling and GND checks for components
- Enhanced logging for library loading and WiFi progress
- Updated Docker build processes with optimized build contexts and multi-architecture support
- Changed WiFi SSID normalization to match QEMU access points for reliable ESP32 WiFi connection
- Refactored I2C slave tests for ESP32 with improved event handling and ACK/NACK responses

### Fixed
- Fixed container restart issue by monitoring both backend and nginx processes
- Fixed project saving to use active board files/kind and improved error messages
- Fixed ESP32 boot stability with deterministic instruction counting
- Fixed ESP32 Run button to auto-compile and recover firmware after page refresh
- Fixed LED ground check to require cathode wired to GND (or LOW GPIO) to light up
- Fixed MPU6050Slave I2C handling with improved WHO_AM_I read tracking
- Fixed ESP32 WiFi SSID/channel alignment with QEMU access_points array
- Fixed RISC-V toolchain paths for ESP32-C3 compilation
- Fixed ESP-IDF Python requirements installation in Docker
- Fixed SaveProjectModal to prevent saving to `/api/projects/none` when project ID is invalid
- Fixed ESP32 compilation by adding missing dependencies (cmake, ninja-build, git, packaging, libusb)

[2.0.1]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v2.0.1
