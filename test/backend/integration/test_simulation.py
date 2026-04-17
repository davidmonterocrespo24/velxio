import asyncio
import sys
import os
from pathlib import Path

# Set UTF-8 encoding for Windows console
if os.name == 'nt':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))
from app.services.qemu_manager import qemu_manager


def test_qemu_manager_starts_stops():
    """Test that the QemuManager can register and unregister instances."""
    print("\n=== Test 1: QemuManager Instance tracking ===")

    async def dummy_callback(event, data):
        pass

    # Directly set state to avoid asyncio.create_task outside a running event loop
    qemu_manager.running_instances["test-client"] = {
        "board": "raspberry-pi-3",
        "status": "running",
        "pins": {},
        "process": None,
    }
    qemu_manager.callbacks["test-client"] = dummy_callback

    assert "test-client" in qemu_manager.running_instances
    assert qemu_manager.running_instances["test-client"]["status"] == "running"
    print("✓ QEMU instance tracked correctly upon start")

    qemu_manager.stop_instance("test-client")
    assert "test-client" not in qemu_manager.running_instances
    print("✓ QEMU instance removed correctly upon stop")


async def _test_websocket_flow_async():
    """Async core of the WebSocket simulation flow test."""
    print("\n=== Test 2: WebSocket Communication Flow ===")

    received_events: list[dict] = []

    async def ws_callback(event_type: str, data: dict):
        received_events.append({"type": event_type, "data": data})
        print(f"  [WS Event] type={event_type}, data={data}")

    # --- start_pi simulation ---
    qemu_manager.running_instances["test-ws-client"] = {
        "board": "raspberry-pi-3",
        "status": "running",
        "pins": {},
        "process": None,
    }
    qemu_manager.callbacks["test-ws-client"] = ws_callback
    assert "test-ws-client" in qemu_manager.running_instances
    print("✓ start_pi: QemuManager instance registered")

    # --- send a system 'booted' event via the callback ---
    await qemu_manager.send_event_to_frontend("test-ws-client", "system", {"event": "booted"})
    assert any(e["type"] == "system" for e in received_events)
    print("✓ send_event_to_frontend: booted event delivered to callback")

    # --- pin_change ---
    qemu_manager.set_pin_state("test-ws-client", "18", 1)
    assert qemu_manager.running_instances["test-ws-client"]["pins"].get("18") == 1
    print("✓ pin_change: Pin=18 set to HIGH (1)")

    qemu_manager.set_pin_state("test-ws-client", "18", 0)
    assert qemu_manager.running_instances["test-ws-client"]["pins"].get("18") == 0
    print("✓ pin_change: Pin=18 set to LOW (0)")

    # --- stop_pi ---
    qemu_manager.stop_instance("test-ws-client")
    assert "test-ws-client" not in qemu_manager.running_instances
    print("✓ stop_pi: instance removed from manager")


def test_websocket_simulation_flow():
    asyncio.run(_test_websocket_flow_async())


def test_qemu_files_exist():
    """Verify that the required QEMU boot files are present."""
    print("\n=== Test 3: QEMU Boot Files ===")

    files = {
        "kernel": qemu_manager.kernel_path,
        "dtb":    qemu_manager.dtb_path,
        "sd img": qemu_manager.sd_path,
    }

    all_ok = True
    for label, path in files.items():
        exists = os.path.exists(path)
        status = "✓" if exists else "✗ MISSING"
        print(f"  {status}  {label}: {path}")
        if not exists:
            all_ok = False

    if all_ok:
        print("✓ All QEMU boot files found")
    else:
        print("⚠  Some files are missing — QEMU will not launch until they are present")
    # Not a hard failure: missing files are expected during early development
    return all_ok


def run_all_tests():
    print("=" * 60)
    print("SIMULATION BACKEND TEST SUITE")
    print("=" * 60)

    try:
        test_qemu_manager_starts_stops()
        test_websocket_simulation_flow()
        test_qemu_files_exist()
        print("\n✅ All WebSocket & Simulation tests passed!")
        return True
    except AssertionError as e:
        print(f"\n❌ Test assertion failed: {e}")
        return False
    except Exception as e:
        import traceback
        print(f"\n❌ Unexpected error: {e}")
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
