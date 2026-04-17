"""
Backend Test Suite for Arduino Compilation
Tests arduino-cli integration and compilation API endpoint
"""

import asyncio
import subprocess
import sys
import os
from pathlib import Path

# Set UTF-8 encoding for Windows console
if os.name == 'nt':
    import sys
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')

# Test arduino-cli installation and AVR core
def test_arduino_cli_installed():
    """Test that arduino-cli is installed and accessible"""
    print("\n=== Test 1: Arduino CLI Installation ===")
    try:
        result = subprocess.run(
            ["arduino-cli", "version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"✓ arduino-cli is installed")
            print(f"  Version: {result.stdout.strip()}")
            return True
        else:
            print(f"✗ arduino-cli returned error code {result.returncode}")
            print(f"  stderr: {result.stderr}")
            return False
    except FileNotFoundError:
        print("✗ arduino-cli not found in PATH")
        print("  Please install arduino-cli: https://arduino.github.io/arduino-cli/")
        return False
    except Exception as e:
        print(f"✗ Error checking arduino-cli: {e}")
        return False


def test_avr_core_installed():
    """Test that Arduino AVR core is installed"""
    print("\n=== Test 2: AVR Core Installation ===")
    try:
        result = subprocess.run(
            ["arduino-cli", "core", "list"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if "arduino:avr" in result.stdout:
            print("✓ Arduino AVR core is installed")
            # Extract version
            for line in result.stdout.splitlines():
                if "arduino:avr" in line:
                    print(f"  {line.strip()}")
            return True
        else:
            print("✗ Arduino AVR core not installed")
            print("  Run: arduino-cli core install arduino:avr")
            return False
    except Exception as e:
        print(f"✗ Error checking AVR core: {e}")
        return False


async def test_compile_service():
    """Test the ArduinoCLIService compilation"""
    print("\n=== Test 3: Compilation Service ===")
    try:
        # Import the service
        sys.path.insert(0, str(Path(__file__).parent))
        from app.services.arduino_cli import ArduinoCLIService

        # Create service instance
        service = ArduinoCLIService()
        print("✓ ArduinoCLIService instantiated")

        # Test code - simple blink
        test_code = """
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
"""

        print("  Compiling test sketch...")
        result = await service.compile(test_code)

        if result["success"]:
            print("✓ Compilation successful")
            print(f"  HEX size: {len(result['hex_content'])} characters")
            print(f"  HEX preview: {result['hex_content'][:50]}...")

            # Verify HEX format (Intel HEX starts with :)
            if result["hex_content"].startswith(":"):
                print("✓ HEX format valid (starts with ':')")
            else:
                print("✗ HEX format invalid")
                return False

            # Check for end-of-file record
            if ":00000001FF" in result["hex_content"]:
                print("✓ HEX contains EOF record")
            else:
                print("⚠ Warning: HEX missing EOF record")

            return True
        else:
            print("✗ Compilation failed")
            print(f"  Error: {result.get('error', 'Unknown')}")
            print(f"  Stdout: {result.get('stdout', '')}")
            print(f"  Stderr: {result.get('stderr', '')}")
            return False

    except ImportError as e:
        print(f"✗ Failed to import service: {e}")
        print("  Make sure you're running from backend directory")
        return False
    except Exception as e:
        print(f"✗ Error during compilation test: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_api_endpoint():
    """Test the FastAPI compilation endpoint"""
    print("\n=== Test 4: API Endpoint ===")
    try:
        import httpx

        # Test if server is running
        async with httpx.AsyncClient(follow_redirects=True) as client:
            try:
                response = await client.get("http://localhost:8001/api/compile/boards", timeout=5.0)
                if response.status_code == 200:
                    print("✓ Backend server is running")
                    boards = response.json().get("boards", [])
                    print(f"  Available boards: {len(boards)}")
                else:
                    print(f"⚠ Server returned status {response.status_code}")
            except httpx.ConnectError:
                print("✗ Backend server not running")
                print("  Start server: cd backend && uvicorn app.main:app --port 8001")
                return False

            # Test compilation endpoint
            test_code = """
void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
"""

            print("  Testing /api/compile endpoint...")
            response = await client.post(
                "http://localhost:8001/api/compile",
                json={"code": test_code, "board_fqbn": "arduino:avr:uno"},
                timeout=30.0
            )

            if response.status_code == 200:
                data = response.json()
                if data.get("success"):
                    print("✓ API compilation successful")
                    print(f"  HEX size: {len(data.get('hex_content', ''))} characters")
                    return True
                else:
                    print("✗ API compilation failed")
                    print(f"  Error: {data.get('error', 'Unknown')}")
                    return False
            else:
                print(f"✗ API returned status {response.status_code}")
                print(f"  Response: {response.text}")
                return False

    except ImportError:
        print("⚠ httpx not installed, skipping API test")
        print("  Install: pip install httpx")
        return None  # Skip test
    except Exception as e:
        print(f"✗ Error testing API: {e}")
        return False


async def run_all_tests():
    """Run all backend tests"""
    print("=" * 60)
    print("BACKEND TEST SUITE")
    print("=" * 60)

    results = {}

    # Test 1: arduino-cli installation
    results["arduino_cli"] = test_arduino_cli_installed()

    # Test 2: AVR core installation
    results["avr_core"] = test_avr_core_installed()

    # Test 3: Compilation service
    if results["arduino_cli"] and results["avr_core"]:
        results["compile_service"] = await test_compile_service()
    else:
        print("\n⚠ Skipping compilation test (prerequisites not met)")
        results["compile_service"] = None

    # Test 4: API endpoint
    results["api_endpoint"] = await test_api_endpoint()

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)

    passed = sum(1 for v in results.values() if v is True)
    failed = sum(1 for v in results.values() if v is False)
    skipped = sum(1 for v in results.values() if v is None)

    for test_name, result in results.items():
        status = "✓ PASS" if result is True else ("✗ FAIL" if result is False else "⚠ SKIP")
        print(f"{status:10} {test_name}")

    print(f"\nTotal: {passed} passed, {failed} failed, {skipped} skipped")

    if failed > 0:
        print("\n❌ Some tests failed. Please fix the issues above.")
        return False
    elif passed == len(results):
        print("\n✅ All tests passed! Backend is working correctly.")
        return True
    else:
        print("\n⚠ Some tests were skipped. Backend may be partially functional.")
        return True


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
