import { useSimulatorStore, getEsp32Bridge } from '../../store/useSimulatorStore';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ESP32_ADC_PIN_MAP } from '../velxio-components/Esp32Element';
import { ComponentPickerModal } from '../ComponentPickerModal';
import { ComponentPropertyDialog } from './ComponentPropertyDialog';
import { CustomChipDialog } from '../customChips/CustomChipDialog';
import { SensorControlPanel } from './SensorControlPanel';
import { SENSOR_CONTROLS } from '../../simulation/sensorControlConfig';
import { DynamicComponent, createComponentFromMetadata } from '../DynamicComponent';
import { InstrumentComponent } from '../components-instruments/InstrumentComponent';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { getTabSessionId } from '../../simulation/Esp32Bridge';
import { CameraToggle } from './CameraToggle';
import { WireLayer } from './WireLayer';
import type { SegmentHandle, WaypointHandle, AlignmentGuide } from './WireLayer';
import { ElectricalOverlay } from '../analog-ui/ElectricalOverlay';
import { BoardOnCanvas } from './BoardOnCanvas';
import { PartSimulationRegistry } from '../../simulation/parts';
import { PROPERTY_CHANGE_EVENT, type PropertyChangeDetail } from '../../simulation/parts/partUtils';
import { isSpiceMapped } from '../../simulation/spice/componentToSpice';
import { PinOverlay } from './PinOverlay';
import { isBoardComponent, boardPinToNumber } from '../../utils/boardPinMapping';
import { autoWireColor, WIRE_KEY_COLORS } from '../../utils/wireUtils';
import {
  findWireNearPoint,
  findSegmentNearPoint,
  getRenderedPoints,
  getRenderedSegments,
  moveSegment,
  renderedToWaypoints,
  renderedPointsToPath,
  simplifyOrthogonalPath,
  insertWaypointAtSegment,
  collectAlignmentTargets,
  snapToNearest,
} from '../../utils/wireHitDetection';

/** World-units of tolerance for alignment snap (scales with zoom). */
const ALIGN_SNAP_PX = 6;

/** Detect touch-capable device once */
const isTouchDevice =
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
import type { ComponentMetadata } from '../../types/component-metadata';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import {
  trackSelectBoard,
  trackAddComponent,
  trackCreateWire,
  trackToggleSerialMonitor,
} from '../../utils/analytics';
import './SimulatorCanvas.css';

/** Check if a board kind is an ESP32-family board. */
function isEsp32Kind(kind: BoardKind): boolean {
  return (
    kind.startsWith('esp32') ||
    kind === 'xiao-esp32-s3' ||
    kind === 'xiao-esp32-c3' ||
    kind === 'arduino-nano-esp32' ||
    kind === 'aitewinrobot-esp32c3-supermini' ||
    kind === 'esp32-cam' ||
    kind === 'wemos-lolin32-lite' ||
    kind === 'esp32-devkit-c-v4'
  );
}

interface SimulatorCanvasProps {
  /**
   * Optional DOM element to portal the canvas header (board selector,
   * Serial/Scope toggles, zoom controls, Add component button) into. When
   * provided, the header renders into the slot instead of in place — used by
   * EditorPage to merge it with the editor toolbar into a single full-width
   * top bar that doesn't reflow when the editor/canvas splitter moves.
   */
  headerSlot?: HTMLElement | null;
}

export const SimulatorCanvas = ({ headerSlot }: SimulatorCanvasProps = {}) => {
  const {
    boards,
    activeBoardId,
    setBoardPosition,
    addBoard,
    components,
    running,
    pinManager,
    initSimulator,
    updateComponentState,
    addComponent,
    removeComponent,
    removeBoard,
    updateComponent,
    serialMonitorOpen,
    toggleSerialMonitor,
  } = useSimulatorStore();

  // Active board (for WiFi/BLE status display)
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;

  // Legacy derived values for components that still use them
  const boardType = useSimulatorStore((s) => s.boardType);
  const boardPosition = useSimulatorStore((s) => s.boardPosition);

  // Wire management from store
  const startWireCreation = useSimulatorStore((s) => s.startWireCreation);
  const updateWireInProgress = useSimulatorStore((s) => s.updateWireInProgress);
  const addWireWaypoint = useSimulatorStore((s) => s.addWireWaypoint);
  const setWireInProgressColor = useSimulatorStore((s) => s.setWireInProgressColor);
  const finishWireCreation = useSimulatorStore((s) => s.finishWireCreation);
  const cancelWireCreation = useSimulatorStore((s) => s.cancelWireCreation);
  const wireInProgress = useSimulatorStore((s) => s.wireInProgress);
  const recalculateAllWirePositions = useSimulatorStore((s) => s.recalculateAllWirePositions);
  const selectedWireId = useSimulatorStore((s) => s.selectedWireId);
  const setSelectedWire = useSimulatorStore((s) => s.setSelectedWire);
  const removeWire = useSimulatorStore((s) => s.removeWire);
  const updateWire = useSimulatorStore((s) => s.updateWire);
  const wires = useSimulatorStore((s) => s.wires);

  // Oscilloscope
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const toggleOscilloscope = useOscilloscopeStore((s) => s.toggleOscilloscope);

  // ESP32 crash notification
  const esp32CrashBoardId = useSimulatorStore((s) => s.esp32CrashBoardId);
  const dismissEsp32Crash = useSimulatorStore((s) => s.dismissEsp32Crash);

  // Component picker modal
  const [showComponentPicker, setShowComponentPicker] = useState(false);
  const [registry] = useState(() => ComponentRegistry.getInstance());
  const [registryLoaded, setRegistryLoaded] = useState(registry.isLoaded);

  // Wait for registry to finish loading before rendering components
  useEffect(() => {
    if (!registryLoaded) {
      registry.loadPromise.then(() => setRegistryLoaded(true));
    }
  }, [registry, registryLoaded]);

  // Component selection
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);

  // Component property dialog
  const [showPropertyDialog, setShowPropertyDialog] = useState(false);
  const [propertyDialogComponentId, setPropertyDialogComponentId] = useState<string | null>(null);
  /** When non-null, the Custom Chip designer dialog is open for this component. */
  const [customChipComponentId, setCustomChipComponentId] = useState<string | null>(null);
  const [propertyDialogPosition, setPropertyDialogPosition] = useState({ x: 0, y: 0 });

  // Sensor control panel (shown instead of property dialog for sensor components during simulation)
  const [sensorControlComponentId, setSensorControlComponentId] = useState<string | null>(null);
  const [sensorControlMetadataId, setSensorControlMetadataId] = useState<string | null>(null);

  // Board built-in LED states (pin 13 for AVR, GPIO25 for RP2040, etc.)
  // Tracks directly from pinManager — independent of any led-builtin component.
  const [boardLedStates, setBoardLedStates] = useState<Record<string, boolean>>({});

  // Board context menu (right-click)
  const [boardContextMenu, setBoardContextMenu] = useState<{
    boardId: string;
    x: number;
    y: number;
  } | null>(null);
  // Board removal confirmation dialog
  const [boardToRemove, setBoardToRemove] = useState<string | null>(null);

  // Click vs drag detection
  const [clickStartTime, setClickStartTime] = useState<number>(0);
  const [clickStartPos, setClickStartPos] = useState({ x: 0, y: 0 });

  // Component dragging state
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Canvas ref for coordinate calculations
  const canvasRef = useRef<HTMLDivElement>(null);

  // Pan & zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  // Use refs during active pan to avoid setState lag
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);

  // Refs that mirror state/props for use inside touch event closures
  // (touch listeners are added imperatively and can't access current React state)
  const runningRef = useRef(running);
  runningRef.current = running;
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const boardPositionRef = useRef(boardPosition);
  boardPositionRef.current = boardPosition;

  // Wire interaction state (canvas-level hit detection — bypasses SVG pointer-events issues)
  const [hoveredWireId, setHoveredWireId] = useState<string | null>(null);
  const [segmentDragPreview, setSegmentDragPreview] = useState<{
    wireId: string;
    overridePath: string;
  } | null>(null);
  const segmentDragRef = useRef<{
    wireId: string;
    segIndex: number;
    axis: 'horizontal' | 'vertical';
    renderedPts: { x: number; y: number }[];
    isDragging: boolean;
  } | null>(null);
  /** Active waypoint drag (free 2D move of a single bend point). */
  const waypointDragRef = useRef<{
    wireId: string;
    waypointIndex: number;
    originalWaypoints: { x: number; y: number }[];
    isDragging: boolean;
  } | null>(null);
  const [waypointDragPreview, setWaypointDragPreview] = useState<{
    wireId: string;
    waypoints: { x: number; y: number }[];
  } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  /** Set to true during mouseup if a segment/waypoint drag committed, so onClick can skip selection. */
  const segmentDragJustCommittedRef = useRef(false);
  const wiresRef = useRef(wires);
  wiresRef.current = wires;

  // Compute midpoint handles for the selected wire's segments
  const segmentHandles = React.useMemo<SegmentHandle[]>(() => {
    if (!selectedWireId) return [];
    const wire = wires.find((w) => w.id === selectedWireId);
    if (!wire) return [];
    return getRenderedSegments(wire).map((seg, i) => ({
      segIndex: i,
      axis: seg.axis,
      mx: (seg.x1 + seg.x2) / 2,
      my: (seg.y1 + seg.y2) / 2,
    }));
  }, [selectedWireId, wires]);

  // Compute bend-point handles (one per waypoint) for the selected wire
  const waypointHandles = React.useMemo<WaypointHandle[]>(() => {
    if (!selectedWireId) return [];
    const wire = wires.find((w) => w.id === selectedWireId);
    if (!wire) return [];
    // While the user is dragging a waypoint, render handles at the live preview
    // positions so the dot tracks the cursor instead of jumping at commit.
    const activeDrag = waypointDragPreview?.wireId === wire.id ? waypointDragPreview : null;
    const wps = activeDrag ? activeDrag.waypoints : (wire.waypoints ?? []);
    return wps.map((wp, i) => ({ index: i, x: wp.x, y: wp.y }));
  }, [selectedWireId, wires, waypointDragPreview]);

  // Touch-specific state refs (for single-finger drag and pinch-to-zoom)
  const touchDraggedComponentIdRef = useRef<string | null>(null);
  const touchDragOffsetRef = useRef({ x: 0, y: 0 });
  const touchClickStartTimeRef = useRef(0);
  const touchClickStartPosRef = useRef({ x: 0, y: 0 });
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const pinchStartMidRef = useRef({ x: 0, y: 0 });
  const pinchStartPanRef = useRef({ x: 0, y: 0 });

  // Refs for touch-based wire creation, selection, and interactive passthrough
  const wireInProgressRef = useRef(wireInProgress);
  wireInProgressRef.current = wireInProgress;
  const selectedWireIdRef = useRef(selectedWireId);
  selectedWireIdRef.current = selectedWireId;
  const touchPassthroughRef = useRef(false);
  const touchOnPinRef = useRef(false);
  const lastTapTimeRef = useRef(0);

  // Convert viewport coords to world (canvas) coords
  const toWorld = useCallback((screenX: number, screenY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: screenX, y: screenY };
    return {
      x: (screenX - rect.left - panRef.current.x) / zoomRef.current,
      y: (screenY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  // Initialize simulator on mount
  useEffect(() => {
    initSimulator();
  }, [initSimulator]);

  // Runtime parts (pots, switches, sensor panels) emit
  // `velxio:property-change` instead of writing the store directly — one
  // listener here routes every mutation through `updateComponent()`, which
  // is the same path the Property Dialog uses. Keeps parts decoupled from
  // Zustand and guarantees the SPICE netlist memo invalidates on every
  // user-driven property change.
  useEffect(() => {
    const onPropertyChange = (evt: Event) => {
      const { componentId, propName, value } = (evt as CustomEvent<PropertyChangeDetail>).detail;
      const state = useSimulatorStore.getState();
      const comp = state.components.find((c) => c.id === componentId);
      if (!comp) return;
      if (String(comp.properties?.[propName]) === String(value)) return;
      state.updateComponent(componentId, {
        properties: { ...comp.properties, [propName]: value },
      });
    };
    window.addEventListener(PROPERTY_CHANGE_EVENT, onPropertyChange);
    return () => window.removeEventListener(PROPERTY_CHANGE_EVENT, onPropertyChange);
  }, []);

  // Auto-start/stop Pi bridges when simulation state changes
  const startBoard = useSimulatorStore((s) => s.startBoard);
  const stopBoard = useSimulatorStore((s) => s.stopBoard);
  useEffect(() => {
    const remoteBoards = boards.filter(
      (b) =>
        b.boardKind === 'raspberry-pi-3' ||
        b.boardKind === 'esp32' ||
        b.boardKind === 'esp32-s3' ||
        b.boardKind === 'esp32-c3',
    );
    remoteBoards.forEach((b) => {
      if (running && !b.running) startBoard(b.id);
      else if (!running && b.running) stopBoard(b.id);
    });
  }, [running, boards, startBoard, stopBoard]);

  // Attach wheel listener as non-passive so preventDefault() works
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(5, Math.max(0.1, zoomRef.current * factor));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - panRef.current.x) / zoomRef.current;
      const worldY = (my - panRef.current.y) / zoomRef.current;
      const newPan = { x: mx - worldX * newZoom, y: my - worldY * newZoom };
      zoomRef.current = newZoom;
      panRef.current = newPan;
      setZoom(newZoom);
      setPan(newPan);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Attach touch listeners as non-passive so preventDefault() works, enabling
  // single-finger pan, component drag, wire creation/selection, and two-finger pinch-to-zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      // Reset per-gesture flags
      touchOnPinRef.current = false;
      touchPassthroughRef.current = false;
      pinchStartDistRef.current = 0;

      if (e.touches.length === 2) {
        e.preventDefault();
        // Cancel wire in progress on two-finger gesture
        if (wireInProgressRef.current) {
          useSimulatorStore.getState().cancelWireCreation();
        }
        // Cancel any active drag/pan and prepare zoom
        isPanningRef.current = false;
        touchDraggedComponentIdRef.current = null;

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoomRef.current;
        pinchStartPanRef.current = { ...panRef.current };

        const rect = el.getBoundingClientRect();
        pinchStartMidRef.current = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
        };
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      // Identify what element was touched
      const target = document.elementFromPoint(touch.clientX, touch.clientY);

      // ── 1. Pin overlay → let pin's onTouchEnd React handler call handlePinClick ──
      if (target?.closest('[data-pin-overlay]')) {
        e.preventDefault();
        touchOnPinRef.current = true;
        return;
      }

      // ── 1b. Wire segment/waypoint handle → let WireLayer's React handler claim the drag.
      // We must skip the canvas-level pan/drag setup so the handle drag works in isolation.
      if (target?.closest('[data-wire-handle]')) {
        e.preventDefault();
        touchPassthroughRef.current = true;
        return;
      }

      // ── 2. Interactive web component during simulation → let browser synthesize mouse events ──
      //    (potentiometer knobs, button presses, etc. need mousedown/mouseup synthesis)
      //    touch-action:none on .canvas-content already prevents browser scroll/zoom.
      if (runningRef.current) {
        const webComp = target?.closest('.web-component-container');
        if (webComp) {
          touchPassthroughRef.current = true;
          // Don't preventDefault → browser synthesizes mouse events for the component
          return;
        }
      }

      e.preventDefault();

      touchClickStartTimeRef.current = Date.now();
      touchClickStartPosRef.current = { x: touch.clientX, y: touch.clientY };

      // ── 3. Wire in progress → track for waypoint, update preview ──
      if (wireInProgressRef.current) {
        const world = toWorld(touch.clientX, touch.clientY);
        useSimulatorStore.getState().updateWireInProgress(world.x, world.y);
        // Don't start pan/drag — let touchmove update wire preview, touchend add waypoint
        return;
      }

      // ── 4. Component detection ──
      const componentWrapper = target?.closest('[data-component-id]') as HTMLElement | null;
      const boardOverlay = target?.closest('[data-board-overlay]') as HTMLElement | null;

      if (componentWrapper) {
        const componentId = componentWrapper.getAttribute('data-component-id');
        if (componentId) {
          const component = componentsRef.current.find((c) => c.id === componentId);
          if (component) {
            const world = toWorld(touch.clientX, touch.clientY);
            touchDraggedComponentIdRef.current = componentId;
            touchDragOffsetRef.current = {
              x: world.x - component.x,
              y: world.y - component.y,
            };
            setSelectedComponentId(componentId);
          }
        }
      } else if (boardOverlay && !runningRef.current) {
        // ── 5. Board overlay: use multi-board path ──
        const boardId = boardOverlay.getAttribute('data-board-id');
        const storeBoards = useSimulatorStore.getState().boards;
        const boardInstance = boardId ? storeBoards.find((b) => b.id === boardId) : null;
        if (boardInstance) {
          const world = toWorld(touch.clientX, touch.clientY);
          touchDraggedComponentIdRef.current = `__board__:${boardId}`;
          touchDragOffsetRef.current = {
            x: world.x - boardInstance.x,
            y: world.y - boardInstance.y,
          };
        } else {
          // Fallback to legacy single board
          const board = boardPositionRef.current;
          const world = toWorld(touch.clientX, touch.clientY);
          touchDraggedComponentIdRef.current = '__board__';
          touchDragOffsetRef.current = {
            x: world.x - board.x,
            y: world.y - board.y,
          };
        }
      } else {
        // ── 6. Empty canvas → start pan ──
        isPanningRef.current = true;
        panStartRef.current = {
          mouseX: touch.clientX,
          mouseY: touch.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      // Let interactive components handle their own touch (potentiometer drag, etc.)
      if (touchPassthroughRef.current) return;
      // Pin touch: no move processing needed
      if (touchOnPinRef.current) {
        e.preventDefault();
        return;
      }

      e.preventDefault();

      if (e.touches.length === 2 && pinchStartDistRef.current > 0) {
        // ── Two-finger pinch: update zoom ──
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / pinchStartDistRef.current;
        const newZoom = Math.min(5, Math.max(0.1, pinchStartZoomRef.current * scale));

        const mid = pinchStartMidRef.current;
        const startPan = pinchStartPanRef.current;
        const startZoom = pinchStartZoomRef.current;
        const worldX = (mid.x - startPan.x) / startZoom;
        const worldY = (mid.y - startPan.y) / startZoom;
        const newPan = {
          x: mid.x - worldX * newZoom,
          y: mid.y - worldY * newZoom,
        };

        zoomRef.current = newZoom;
        panRef.current = newPan;
        const worldEl = el.querySelector('.canvas-world') as HTMLElement | null;
        if (worldEl) {
          worldEl.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${newZoom})`;
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      // ── Segment drag (wire editing) via touch ──
      if (segmentDragRef.current) {
        const world = toWorld(touch.clientX, touch.clientY);
        const sd = segmentDragRef.current;
        sd.isDragging = true;
        const newValue = sd.axis === 'horizontal' ? world.y : world.x;
        const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
        const overridePath = renderedPointsToPath(newPts);
        setSegmentDragPreview({ wireId: sd.wireId, overridePath });
        return;
      }

      // ── Wire preview: update position as finger moves ──
      if (
        wireInProgressRef.current &&
        !isPanningRef.current &&
        !touchDraggedComponentIdRef.current
      ) {
        const world = toWorld(touch.clientX, touch.clientY);
        useSimulatorStore.getState().updateWireInProgress(world.x, world.y);
        return;
      }

      if (isPanningRef.current) {
        // ── Single finger pan ──
        const dx = touch.clientX - panStartRef.current.mouseX;
        const dy = touch.clientY - panStartRef.current.mouseY;
        const newPan = {
          x: panStartRef.current.panX + dx,
          y: panStartRef.current.panY + dy,
        };
        panRef.current = newPan;
        const worldEl = el.querySelector('.canvas-world') as HTMLElement | null;
        if (worldEl) {
          worldEl.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${zoomRef.current})`;
        }
      } else if (touchDraggedComponentIdRef.current) {
        // ── Single finger component/board drag ──
        const world = toWorld(touch.clientX, touch.clientY);
        const touchId = touchDraggedComponentIdRef.current;
        if (touchId && touchId.startsWith('__board__:')) {
          const boardId = touchId.slice('__board__:'.length);
          setBoardPosition(
            {
              x: world.x - touchDragOffsetRef.current.x,
              y: world.y - touchDragOffsetRef.current.y,
            },
            boardId,
          );
        } else if (touchId === '__board__') {
          setBoardPosition({
            x: world.x - touchDragOffsetRef.current.x,
            y: world.y - touchDragOffsetRef.current.y,
          });
        } else {
          updateComponent(touchDraggedComponentIdRef.current!, {
            x: world.x - touchDragOffsetRef.current.x,
            y: world.y - touchDragOffsetRef.current.y,
          } as any);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      // Let interactive components handle their own touch
      if (touchPassthroughRef.current) {
        touchPassthroughRef.current = false;
        return;
      }
      // Pin touch: let pin's onTouchEnd React handler deal with it
      if (touchOnPinRef.current) {
        touchOnPinRef.current = false;
        e.preventDefault();
        return;
      }

      e.preventDefault();

      // ── Finish pinch zoom: commit values to React state ──
      if (pinchStartDistRef.current > 0 && e.touches.length < 2) {
        setZoom(zoomRef.current);
        setPan({ ...panRef.current });
        pinchStartDistRef.current = 0;
      }

      if (e.touches.length > 0) return; // Still fingers on screen

      // ── Finish segment drag (wire editing) via touch ──
      if (segmentDragRef.current) {
        const sd = segmentDragRef.current;
        if (sd.isDragging) {
          segmentDragJustCommittedRef.current = true;
          const changed = e.changedTouches[0];
          if (changed) {
            const world = toWorld(changed.clientX, changed.clientY);
            const newValue = sd.axis === 'horizontal' ? world.y : world.x;
            const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
            updateWire(sd.wireId, { waypoints: renderedToWaypoints(newPts) });
          }
        }
        segmentDragRef.current = null;
        setSegmentDragPreview(null);
        return;
      }

      // ── Finish panning ──
      let wasPanning = false;
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setPan({ ...panRef.current });
        wasPanning = true;
        // Don't return — fall through so short taps can select wires
      }

      const changed = e.changedTouches[0];
      if (!changed) return;

      const elapsed = Date.now() - touchClickStartTimeRef.current;
      const dx = changed.clientX - touchClickStartPosRef.current.x;
      const dy = changed.clientY - touchClickStartPosRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isShortTap = dist < 20 && elapsed < 400;

      // If we actually panned (moved significantly), don't process as tap
      if (wasPanning && !isShortTap) return;

      // ── Finish component/board drag ──
      if (touchDraggedComponentIdRef.current) {
        const touchId = touchDraggedComponentIdRef.current;

        if (isShortTap) {
          if (touchId.startsWith('__board__:')) {
            // Short tap on board → make it the active board
            const boardId = touchId.slice('__board__:'.length);
            useSimulatorStore.getState().setActiveBoardId(boardId);
          } else if (touchId !== '__board__') {
            // Short tap on component → open property dialog or sensor panel.
            // While the simulator is running, components stay interactive —
            // only sensor panels may open; property editing is disabled.
            const component = componentsRef.current.find((c) => c.id === touchId);
            if (component) {
              if (runningRef.current) {
                if (SENSOR_CONTROLS[component.metadataId] !== undefined) {
                  setSensorControlComponentId(touchId);
                  setSensorControlMetadataId(component.metadataId);
                }
              } else {
                setPropertyDialogComponentId(touchId);
                setPropertyDialogPosition({
                  x: component.x * zoomRef.current + panRef.current.x,
                  y: component.y * zoomRef.current + panRef.current.y,
                });
                setShowPropertyDialog(true);
              }
            }
          }
        }

        recalculateAllWirePositions();
        touchDraggedComponentIdRef.current = null;
        return;
      }

      // ── Wire in progress: short tap adds waypoint ──
      if (wireInProgressRef.current) {
        if (isShortTap) {
          const world = toWorld(changed.clientX, changed.clientY);
          useSimulatorStore.getState().addWireWaypoint(world.x, world.y);
        }
        return;
      }

      // ── Short tap on empty canvas: wire selection + double-tap inserts waypoint ──
      if (isShortTap) {
        const now = Date.now();
        const world = toWorld(changed.clientX, changed.clientY);
        const baseThreshold = isTouchDevice ? 20 : 8;
        const threshold = baseThreshold / zoomRef.current;
        const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);

        // Double-tap on a wire → insert draggable waypoint at the tap location
        const timeSinceLastTap = now - lastTapTimeRef.current;
        if (timeSinceLastTap < 350 && wire) {
          const seg = findSegmentNearPoint(wire, world.x, world.y, threshold);
          if (seg) {
            const newWaypoints = insertWaypointAtSegment(
              wire.waypoints ?? [],
              seg,
              world.x,
              world.y,
            );
            useSimulatorStore.getState().updateWire(wire.id, { waypoints: newWaypoints });
            useSimulatorStore.getState().setSelectedWire(wire.id);
          }
          lastTapTimeRef.current = 0;
          return;
        }
        lastTapTimeRef.current = now;

        if (wire) {
          const curr = selectedWireIdRef.current;
          useSimulatorStore.getState().setSelectedWire(curr === wire.id ? null : wire.id);
        } else {
          useSimulatorStore.getState().setSelectedWire(null);
          setSelectedComponentId(null);
        }
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [toWorld, setBoardPosition, updateComponent, recalculateAllWirePositions]);

  // Recalculate wire positions after web components initialize their pinInfo
  useEffect(() => {
    const timer = setTimeout(() => {
      recalculateAllWirePositions();
    }, 500);
    return () => clearTimeout(timer);
  }, [recalculateAllWirePositions]);

  // Connect components to pin manager
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Returns true if the component has at least one wire connected to a board
    // GND or power-rail pin (boardPinToNumber returns -1 for these).
    // Used to block output components from activating without a ground connection.
    const componentHasGndWire = (component: any): boolean =>
      wires.some((w) => {
        const isSelfStart = w.start.componentId === component.id;
        const isSelfEnd = w.end.componentId === component.id;
        if (!isSelfStart && !isSelfEnd) return false;
        const otherEndpoint = isSelfStart ? w.end : w.start;
        if (!isBoardComponent(otherEndpoint.componentId)) return false;
        const boardInstance = boards.find((b) => b.id === otherEndpoint.componentId);
        const lookupKey = boardInstance ? boardInstance.boardKind : otherEndpoint.componentId;
        return boardPinToNumber(lookupKey, otherEndpoint.pinName) === -1;
      });

    // Helper to add subscription
    // wireConnected: true when this call came from the wire-scanning path (not properties.pin).
    const subscribeComponentToPin = (
      component: any,
      pin: number,
      componentPinName?: string,
      wireConnected = false,
    ) => {
      // Components with attachEvents in PartSimulationRegistry manage their own
      // visual state (e.g. LED, servo, buzzer). Skip generic digital/PWM updates for
      // them — they already handle GND logic internally via getArduinoPinHelper.
      //
      // SPICE-mapped components (every analog/mixed part — resistors, capacitors,
      // diodes, MOSFETs, op-amps, regulators, …) are ALSO treated as self-managed:
      // SPICE is the authoritative source for their electrical state. If we echoed
      // the raw digital pin value back into `components[i].properties.state` on
      // every toggle, the store update would invalidate the solver debounce every
      // ~2 ms under PWM (490 Hz) and the solver would effectively never run — the
      // root cause of the MOSFET-PWM-LED regression. This single rule makes every
      // current and future SPICE mapper immune to that feedback loop.
      const logic = PartSimulationRegistry.get(component.metadataId);
      const spiceOwned = isSpiceMapped(component.metadataId);
      const hasSelfManagedVisuals = !!(logic && logic.attachEvents) || spiceOwned;

      // Generic GND check: for wire-connected output components that don't manage
      // their own state, require at least one GND wire before activating.
      // Skip the check for pin-property components (no GND wire to detect) and for
      // self-managed components (they handle GND themselves via attachEvents).
      const hasGnd =
        !wireConnected || hasSelfManagedVisuals ? true : componentHasGndWire(component);

      const unsubscribe = pinManager.onPinChange(pin, (_pin, state) => {
        if (!hasSelfManagedVisuals) {
          // Update React state — gate on GND for wire-connected components.
          updateComponentState(component.id, hasGnd && state);
        }

        // Delegate to PartSimulationRegistry for custom visual updates
        if (logic && logic.onPinStateChange) {
          const el = document.getElementById(component.id);
          if (el) {
            logic.onPinStateChange(componentPinName || 'A', hasGnd && state, el);
          }
        }
      });
      unsubscribers.push(unsubscribe);
    };

    components.forEach((component) => {
      // 1. Subscribe by explicit pin property (old-style, no wire needed)
      if (component.properties.pin !== undefined) {
        subscribeComponentToPin(component, component.properties.pin as number, 'A', false);
      } else {
        // 2. Subscribe by finding wires connected to arduino
        const connectedWires = wires.filter(
          (w) => w.start.componentId === component.id || w.end.componentId === component.id,
        );

        connectedWires.forEach((wire) => {
          const isStartSelf = wire.start.componentId === component.id;
          const selfEndpoint = isStartSelf ? wire.start : wire.end;
          const otherEndpoint = isStartSelf ? wire.end : wire.start;

          if (isBoardComponent(otherEndpoint.componentId)) {
            // Use the board's actual boardKind (not just its instance ID) so that
            // a board whose ID is 'arduino-uno' but whose kind is 'esp32' gets the
            // correct GPIO mapping ('GPIO4' → 4, not null).
            const boardInstance = boards.find((b) => b.id === otherEndpoint.componentId);
            const lookupKey = boardInstance ? boardInstance.boardKind : otherEndpoint.componentId;
            const pin = boardPinToNumber(lookupKey, otherEndpoint.pinName);
            if (pin !== null && pin >= 0) {
              subscribeComponentToPin(component, pin, selfEndpoint.pinName, true);
            } else if (pin === null) {
              console.warn(
                `[WirePin] Could not resolve pin "${otherEndpoint.pinName}" on ${lookupKey}`,
              );
            }
            // pin === -1 → power/GND pin, skip silently
          }
        });
      }
    });

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [components, wires, boards, pinManager, updateComponentState]);

  // Board built-in LED: subscribe directly to pinManager for the LED pin of each board.
  // This works even when no external led-builtin component exists (e.g. basic Blink example).
  useEffect(() => {
    if (!pinManager) return;
    const unsubs: (() => void)[] = [];

    boards.forEach((board) => {
      // Determine which GPIO pin drives the board's built-in LED
      let ledPin: number;
      switch (board.boardKind) {
        case 'raspberry-pi-pico':
        case 'pi-pico-w':
        case 'nano-rp2040':
          ledPin = 25; // GPIO25
          break;
        default:
          ledPin = 13; // Pin 13 for Arduino Uno/Nano/Mega, ATtiny85, etc.
      }

      unsubs.push(
        pinManager.onPinChange(ledPin, (_pin, state) => {
          setBoardLedStates((prev) => {
            if (prev[board.id] === state) return prev;
            return { ...prev, [board.id]: state };
          });
        }),
      );
    });

    return () => unsubs.forEach((u) => u());
  }, [boards, pinManager]);

  // ESP32 input components: forward button presses and potentiometer values to QEMU
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    components.forEach((component) => {
      const connectedWires = wires.filter(
        (w) => w.start.componentId === component.id || w.end.componentId === component.id,
      );

      connectedWires.forEach((wire) => {
        const isStartSelf = wire.start.componentId === component.id;
        const selfEndpoint = isStartSelf ? wire.start : wire.end;
        const otherEndpoint = isStartSelf ? wire.end : wire.start;

        if (!isBoardComponent(otherEndpoint.componentId)) return;

        const boardId = otherEndpoint.componentId;
        const bridge = getEsp32Bridge(boardId);
        if (!bridge) return; // not an ESP32 board

        const boardInstance = boards.find((b) => b.id === boardId);
        const lookupKey = boardInstance ? boardInstance.boardKind : boardId;
        const gpioPin = boardPinToNumber(lookupKey, otherEndpoint.pinName);
        if (gpioPin === null) return;

        // Delay lookup so the web component has time to render
        const timeout = setTimeout(() => {
          const el = document.getElementById(component.id);
          if (!el) return;
          const tag = el.tagName.toLowerCase();

          // Push-button: forward press/release as GPIO level changes
          if (tag === 'wokwi-pushbutton') {
            const onPress = () => bridge.sendPinEvent(gpioPin, true);
            const onRelease = () => bridge.sendPinEvent(gpioPin, false);
            el.addEventListener('button-press', onPress);
            el.addEventListener('button-release', onRelease);
            cleanups.push(() => {
              el.removeEventListener('button-press', onPress);
              el.removeEventListener('button-release', onRelease);
            });
          }

          // Potentiometer: forward analog value as ADC millivolts
          if (tag === 'wokwi-potentiometer' && selfEndpoint.pinName === 'SIG') {
            const adcInfo = ESP32_ADC_PIN_MAP[gpioPin];
            if (adcInfo) {
              const onInput = (e: Event) => {
                const pct = parseFloat((e.target as any).value ?? '0'); // 0–100
                bridge.setAdc(adcInfo.chn, Math.round((pct / 100) * 3300));
              };
              el.addEventListener('input', onInput);
              cleanups.push(() => el.removeEventListener('input', onInput));
            }
          }
        }, 300);

        cleanups.push(() => clearTimeout(timeout));
      });
    });

    return () => cleanups.forEach((fn) => fn());
  }, [components, wires, boards]);

  // Handle keyboard delete for components and boards
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedComponentId) {
          removeComponent(selectedComponentId);
          setSelectedComponentId(null);
        } else if (activeBoardId) {
          setBoardToRemove(activeBoardId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponentId, removeComponent, activeBoardId]);

  // Handle component selection from modal
  const handleSelectComponent = (metadata: ComponentMetadata) => {
    // Anchor new components to the visible top-left of the canvas, so they
    // appear in the user's current viewport regardless of pan/zoom (instead
    // of growing off-screen at fixed world coords like (400, 100 + row*250)).
    const rect = canvasRef.current?.getBoundingClientRect();
    const z = zoomRef.current || 1;
    const screenMargin = 60; // px on screen — keeps the part off the toolbar/edge
    const worldOrigin = rect
      ? toWorld(rect.left + screenMargin, rect.top + screenMargin)
      : { x: 100, y: 100 };

    // Tile additional drops so they don't stack exactly on top of each other,
    // while still landing inside the viewport.
    const tileStep = 40 / z; // 40 screen-px between successive drops
    const cols = 4;
    const idx = components.length;
    const x = worldOrigin.x + (idx % cols) * tileStep;
    const y = worldOrigin.y + Math.floor(idx / cols) * tileStep;

    const component = createComponentFromMetadata(metadata, x, y);
    trackAddComponent(metadata.id);
    addComponent(component as any);
    setShowComponentPicker(false);

    // Custom Chips need a compile step before they can do anything — open the
    // designer dialog immediately so the user lands in the editor.
    if (metadata.id === 'custom-chip') {
      setCustomChipComponentId(component.id);
    }
  };

  // Component rotation
  const handleRotateComponent = (componentId: string) => {
    const component = components.find((c) => c.id === componentId);
    if (!component) return;

    const currentRotation = (component.properties.rotation as number) || 0;
    updateComponent(componentId, {
      properties: {
        ...component.properties,
        rotation: (currentRotation + 90) % 360,
      },
    } as any);
  };

  // Component dragging handlers
  const handleComponentMouseDown = (componentId: string, e: React.MouseEvent) => {
    if (showPropertyDialog) return;

    e.stopPropagation();
    const component = components.find((c) => c.id === componentId);
    if (!component) return;

    setClickStartTime(Date.now());
    setClickStartPos({ x: e.clientX, y: e.clientY });

    const world = toWorld(e.clientX, e.clientY);
    setDraggedComponentId(componentId);
    setDragOffset({
      x: world.x - component.x,
      y: world.y - component.y,
    });
    setSelectedComponentId(componentId);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    // Handle active panning (ref-based, no setState lag)
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      const newPan = {
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      };
      panRef.current = newPan;
      // Update the transform directly for zero-lag panning
      const world = canvasRef.current?.querySelector('.canvas-world') as HTMLElement | null;
      if (world) {
        world.style.transform = `translate(${newPan.x}px, ${newPan.y}px) scale(${zoomRef.current})`;
      }
      return;
    }

    // Handle component/board dragging
    if (draggedComponentId) {
      const world = toWorld(e.clientX, e.clientY);
      if (draggedComponentId.startsWith('__board__:')) {
        const boardId = draggedComponentId.slice('__board__:'.length);
        setBoardPosition({ x: world.x - dragOffset.x, y: world.y - dragOffset.y }, boardId);
      } else if (draggedComponentId === '__board__') {
        // legacy fallback
        setBoardPosition({ x: world.x - dragOffset.x, y: world.y - dragOffset.y });
      } else {
        updateComponent(draggedComponentId, {
          x: world.x - dragOffset.x,
          y: world.y - dragOffset.y,
        } as any);
      }
    }

    // Handle wire creation preview
    if (wireInProgress) {
      const world = toWorld(e.clientX, e.clientY);
      updateWireInProgress(world.x, world.y);
      return;
    }

    // Handle segment handle dragging
    if (segmentDragRef.current) {
      const world = toWorld(e.clientX, e.clientY);
      const sd = segmentDragRef.current;
      sd.isDragging = true;
      const threshold = ALIGN_SNAP_PX / zoomRef.current;
      const targets = collectAlignmentTargets(wiresRef.current, sd.wireId);
      const guides: AlignmentGuide[] = [];
      let newValue = sd.axis === 'horizontal' ? world.y : world.x;
      const snap = snapToNearest(
        newValue,
        sd.axis === 'horizontal' ? targets.ys : targets.xs,
        threshold,
      );
      if (snap) {
        newValue = snap.snapped;
        guides.push({ axis: sd.axis === 'horizontal' ? 'y' : 'x', value: snap.target });
      }
      setAlignmentGuides(guides);
      const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
      const overridePath = renderedPointsToPath(simplifyOrthogonalPath(newPts));
      setSegmentDragPreview({ wireId: sd.wireId, overridePath });
      return;
    }

    // Handle waypoint handle dragging (free 2D move)
    if (waypointDragRef.current) {
      const world = toWorld(e.clientX, e.clientY);
      const wd = waypointDragRef.current;
      wd.isDragging = true;
      const wire = wiresRef.current.find((w) => w.id === wd.wireId);
      if (wire) {
        const threshold = ALIGN_SNAP_PX / zoomRef.current;
        const targets = collectAlignmentTargets(wiresRef.current, wd.wireId);
        const guides: AlignmentGuide[] = [];
        let snappedX = world.x;
        let snappedY = world.y;
        const snapX = snapToNearest(world.x, targets.xs, threshold);
        if (snapX) {
          snappedX = snapX.snapped;
          guides.push({ axis: 'x', value: snapX.target });
        }
        const snapY = snapToNearest(world.y, targets.ys, threshold);
        if (snapY) {
          snappedY = snapY.snapped;
          guides.push({ axis: 'y', value: snapY.target });
        }
        setAlignmentGuides(guides);
        const newWaypoints = wd.originalWaypoints.map((wp, i) =>
          i === wd.waypointIndex ? { x: snappedX, y: snappedY } : { ...wp },
        );
        setWaypointDragPreview({ wireId: wd.wireId, waypoints: newWaypoints });
        // Reflect the moved bend point in the rendered path live
        const stored = [
          { x: wire.start.x, y: wire.start.y },
          ...newWaypoints,
          { x: wire.end.x, y: wire.end.y },
        ];
        const expanded: { x: number; y: number }[] = [stored[0]];
        for (let i = 1; i < stored.length; i++) {
          const prev = stored[i - 1];
          const curr = stored[i];
          if (prev.x !== curr.x && prev.y !== curr.y) {
            expanded.push({ x: curr.x, y: prev.y });
          }
          expanded.push(curr);
        }
        const overridePath = renderedPointsToPath(simplifyOrthogonalPath(expanded));
        setSegmentDragPreview({ wireId: wd.wireId, overridePath });
      }
      return;
    }

    // Wire hover detection (when not dragging anything)
    if (!draggedComponentId) {
      const world = toWorld(e.clientX, e.clientY);
      const threshold = 8 / zoomRef.current;
      const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
      setHoveredWireId(wire ? wire.id : null);
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    // Finish panning — commit ref value to state so React knows the final pan
    if (isPanningRef.current) {
      isPanningRef.current = false;
      setPan({ ...panRef.current });
      return;
    }

    // Commit segment handle drag
    if (segmentDragRef.current) {
      const sd = segmentDragRef.current;
      if (sd.isDragging) {
        segmentDragJustCommittedRef.current = true;
        const world = toWorld(e.clientX, e.clientY);
        const threshold = ALIGN_SNAP_PX / zoomRef.current;
        const targets = collectAlignmentTargets(wiresRef.current, sd.wireId);
        let newValue = sd.axis === 'horizontal' ? world.y : world.x;
        const snap = snapToNearest(
          newValue,
          sd.axis === 'horizontal' ? targets.ys : targets.xs,
          threshold,
        );
        if (snap) newValue = snap.snapped;
        const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
        updateWire(sd.wireId, { waypoints: renderedToWaypoints(newPts) });
      }
      segmentDragRef.current = null;
      setSegmentDragPreview(null);
      setAlignmentGuides([]);
      return;
    }

    // Commit waypoint handle drag
    if (waypointDragRef.current) {
      const wd = waypointDragRef.current;
      if (wd.isDragging) {
        segmentDragJustCommittedRef.current = true;
        const world = toWorld(e.clientX, e.clientY);
        const wire = wiresRef.current.find((w) => w.id === wd.wireId);
        if (wire) {
          const threshold = ALIGN_SNAP_PX / zoomRef.current;
          const targets = collectAlignmentTargets(wiresRef.current, wd.wireId);
          let snappedX = world.x;
          let snappedY = world.y;
          const snapX = snapToNearest(world.x, targets.xs, threshold);
          if (snapX) snappedX = snapX.snapped;
          const snapY = snapToNearest(world.y, targets.ys, threshold);
          if (snapY) snappedY = snapY.snapped;
          const newWaypoints = wd.originalWaypoints.map((wp, i) =>
            i === wd.waypointIndex ? { x: snappedX, y: snappedY } : { ...wp },
          );
          // Run through expand → simplify so collinear waypoints get cleaned up
          const stored = [
            { x: wire.start.x, y: wire.start.y },
            ...newWaypoints,
            { x: wire.end.x, y: wire.end.y },
          ];
          const expanded: { x: number; y: number }[] = [stored[0]];
          for (let i = 1; i < stored.length; i++) {
            const prev = stored[i - 1];
            const curr = stored[i];
            if (prev.x !== curr.x && prev.y !== curr.y) {
              expanded.push({ x: curr.x, y: prev.y });
            }
            expanded.push(curr);
          }
          updateWire(wd.wireId, { waypoints: renderedToWaypoints(expanded) });
        }
      }
      waypointDragRef.current = null;
      setWaypointDragPreview(null);
      setSegmentDragPreview(null);
      setAlignmentGuides([]);
      return;
    }

    if (draggedComponentId) {
      const timeDiff = Date.now() - clickStartTime;
      const posDiff = Math.sqrt(
        Math.pow(e.clientX - clickStartPos.x, 2) + Math.pow(e.clientY - clickStartPos.y, 2),
      );

      if (posDiff < 5 && timeDiff < 300) {
        if (draggedComponentId.startsWith('__board__:')) {
          // Click on a board — make it the active board (editor switches to its code)
          const boardId = draggedComponentId.slice('__board__:'.length);
          useSimulatorStore.getState().setActiveBoardId(boardId);
        } else if (draggedComponentId !== '__board__') {
          const component = components.find((c) => c.id === draggedComponentId);
          if (component) {
            if (running) {
              // During simulation only sensor panels open on click — every
              // other component is interactive (pushbutton, switch, pot, …)
              // and must handle its own clicks, so we suppress the property
              // dialog entirely.
              if (SENSOR_CONTROLS[component.metadataId] !== undefined) {
                setSensorControlComponentId(draggedComponentId);
                setSensorControlMetadataId(component.metadataId);
              }
            } else if (component.metadataId === 'custom-chip') {
              // Custom Chips have their own designer (C editor + chip.json + Compile).
              setCustomChipComponentId(draggedComponentId);
            } else {
              setPropertyDialogComponentId(draggedComponentId);
              setPropertyDialogPosition({
                x: component.x * zoomRef.current + panRef.current.x,
                y: component.y * zoomRef.current + panRef.current.y,
              });
              setShowPropertyDialog(true);
            }
          }
        }
      }

      recalculateAllWirePositions();
      setDraggedComponentId(null);
    }
  };

  // Start panning on middle-click or right-click
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
    }
  };

  // Handle mousedown on a segment handle circle (called from WireLayer)
  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, segIndex: number) => {
      e.stopPropagation();
      e.preventDefault();
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      const segments = getRenderedSegments(wire);
      const seg = segments[segIndex];
      if (!seg) return;
      const expandedPts = getRenderedPoints(wire);
      segmentDragRef.current = {
        wireId: wire.id,
        segIndex,
        axis: seg.axis,
        renderedPts: expandedPts,
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle touchstart on a segment handle circle (mobile wire editing)
  const handleHandleTouchStart = useCallback(
    (e: React.TouchEvent, segIndex: number) => {
      e.stopPropagation();
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      const segments = getRenderedSegments(wire);
      const seg = segments[segIndex];
      if (!seg) return;
      const expandedPts = getRenderedPoints(wire);
      segmentDragRef.current = {
        wireId: wire.id,
        segIndex,
        axis: seg.axis,
        renderedPts: expandedPts,
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle mousedown on a waypoint (bend-point) handle: free 2D drag
  const handleWaypointMouseDown = useCallback(
    (e: React.MouseEvent, waypointIndex: number) => {
      e.stopPropagation();
      e.preventDefault();
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      waypointDragRef.current = {
        wireId: wire.id,
        waypointIndex,
        originalWaypoints: (wire.waypoints ?? []).map((wp) => ({ ...wp })),
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Handle touchstart on a waypoint handle (mobile)
  const handleWaypointTouchStart = useCallback(
    (e: React.TouchEvent, waypointIndex: number) => {
      e.stopPropagation();
      if (!selectedWireId) return;
      const wire = wiresRef.current.find((w) => w.id === selectedWireId);
      if (!wire) return;
      waypointDragRef.current = {
        wireId: wire.id,
        waypointIndex,
        originalWaypoints: (wire.waypoints ?? []).map((wp) => ({ ...wp })),
        isDragging: false,
      };
    },
    [selectedWireId],
  );

  // Zoom centered on cursor
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(5, Math.max(0.1, zoomRef.current * factor));

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Keep the world point under the cursor fixed
    const worldX = (mx - panRef.current.x) / zoomRef.current;
    const worldY = (my - panRef.current.y) / zoomRef.current;
    const newPan = {
      x: mx - worldX * newZoom,
      y: my - worldY * newZoom,
    };

    zoomRef.current = newZoom;
    panRef.current = newPan;
    setZoom(newZoom);
    setPan(newPan);
  };

  const handleResetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Wire creation via pin clicks
  const handlePinClick = (componentId: string, pinName: string, x: number, y: number) => {
    // Close property dialog when starting wire creation
    if (showPropertyDialog) {
      setShowPropertyDialog(false);
    }

    if (wireInProgress) {
      // Finish wire: connect to this pin
      finishWireCreation({ componentId, pinName, x, y });
      trackCreateWire();
    } else {
      // Start wire: auto-detect color from pin name
      startWireCreation({ componentId, pinName, x, y }, autoWireColor(pinName));
    }
  };

  // Keyboard handlers for wires
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape → cancel in-progress wire
      if (e.key === 'Escape' && wireInProgress) {
        cancelWireCreation();
        return;
      }
      // Delete / Backspace → remove selected wire
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWireId) {
        removeWire(selectedWireId);
        return;
      }
      // Color shortcuts (0-9, c, l, m, p, y) — Wokwi style
      const key = e.key.toLowerCase();
      if (key in WIRE_KEY_COLORS) {
        if (wireInProgress) {
          setWireInProgressColor(WIRE_KEY_COLORS[key]);
        } else if (selectedWireId) {
          updateWire(selectedWireId, { color: WIRE_KEY_COLORS[key] });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    wireInProgress,
    cancelWireCreation,
    selectedWireId,
    removeWire,
    setWireInProgressColor,
    updateWire,
  ]);

  // Recalculate wire positions when components change (e.g., when loading an example)
  useEffect(() => {
    // Wait for components to render and pinInfo to be available
    // Use multiple retries to ensure pinInfo is ready
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Try at 100ms, 300ms, and 500ms to ensure all components have rendered
    timers.push(setTimeout(() => recalculateAllWirePositions(), 100));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 300));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 500));

    return () => timers.forEach((t) => clearTimeout(t));
  }, [components, recalculateAllWirePositions]);

  // Auto-pan to keep the board and all components visible after a project import/load.
  // We track the previous component count and only re-center when the count
  // jumps (indicating the user loaded a new circuit, not just added one part).
  const prevComponentCountRef = useRef(-1);
  useEffect(() => {
    const prev = prevComponentCountRef.current;
    const curr = components.length;
    prevComponentCountRef.current = curr;

    // Only re-center when the component list transitions from empty/different
    // project to a populated one (i.e., a load/import event).
    const isLoad = curr > 0 && (prev <= 0 || Math.abs(curr - prev) > 2);
    if (!isLoad) return;

    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const currentZoom = zoomRef.current;

      // Compute the centroid of all world-space elements (board + extra components)
      // so that the auto-pan keeps everything visible, not just the board.
      const allX = [boardPositionRef.current.x, ...componentsRef.current.map((c) => c.x)];
      const allY = [boardPositionRef.current.y, ...componentsRef.current.map((c) => c.y)];
      const minX = Math.min(...allX);
      const maxX = Math.max(...allX);
      const minY = Math.min(...allY);
      const maxY = Math.max(...allY);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      const newPan = {
        x: rect.width / 2 - centerX * currentZoom,
        y: rect.height / 2 - centerY * currentZoom,
      };
      panRef.current = newPan;
      setPan(newPan);
    }, 150);

    return () => clearTimeout(timer);
  }, [components.length]);

  // Render component using dynamic renderer
  const renderComponent = (component: any) => {
    // SPICE probes are React components, not web components — render them
    // directly and let PinOverlay read the pinInfo we attach in the wrapper.
    if (component.metadataId === 'instr-voltmeter' || component.metadataId === 'instr-ammeter') {
      const isSelected = selectedComponentId === component.id;
      return (
        <React.Fragment key={component.id}>
          <InstrumentComponent
            id={component.id}
            metadataId={component.metadataId}
            x={component.x}
            y={component.y}
            isSelected={isSelected}
            onMouseDown={(e) => handleComponentMouseDown(component.id, e)}
          />
          {!running && (
            <PinOverlay
              componentId={component.id}
              componentX={component.x}
              componentY={component.y}
              onPinClick={handlePinClick}
              showPins={true}
              zoom={zoom}
              wrapperOffsetX={0}
              wrapperOffsetY={0}
            />
          )}
        </React.Fragment>
      );
    }

    const metadata = registry.getById(component.metadataId);
    if (!metadata) {
      console.warn(`Metadata not found for component: ${component.metadataId}`);
      return null;
    }

    const isSelected = selectedComponentId === component.id;
    // Always show pins for better UX when creating wires
    const showPinsForComponent = true;

    return (
      <React.Fragment key={component.id}>
        <DynamicComponent
          id={component.id}
          metadata={metadata}
          properties={component.properties}
          x={component.x}
          y={component.y}
          isSelected={isSelected}
          onMouseDown={(e) => {
            handleComponentMouseDown(component.id, e);
          }}
        />

        {/* Pin overlay for wire creation - hide when running */}
        {!running && (
          <PinOverlay
            componentId={component.id}
            componentX={component.x}
            componentY={component.y}
            onPinClick={handlePinClick}
            showPins={showPinsForComponent}
            zoom={zoom}
          />
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="simulator-canvas-container">
      {/* ESP32 crash notification */}
      {esp32CrashBoardId && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: '#c0392b',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 13,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <span>
            ESP32 crash detected on board <strong>{esp32CrashBoardId}</strong> — cache error (IDF
            incompatibility)
          </span>
          <button
            onClick={dismissEsp32Crash}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.6)',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Canvas */}
      <div className="simulator-canvas">
        {(() => {
          const headerJsx = (
        <div className={`canvas-header${headerSlot ? ' canvas-header--portaled' : ''}`}>
          <div className="canvas-header-left">
            {/* Status LED */}
            <span
              className={`status-dot ${running ? 'running' : 'stopped'}`}
              title={running ? 'Running' : 'Stopped'}
            />

            {/* Active board selector (multi-board) — hidden when no boards */}
            {boards.length > 0 ? (
              <select
                className="board-selector"
                value={activeBoardId ?? ''}
                onChange={(e) => useSimulatorStore.getState().setActiveBoardId(e.target.value)}
                disabled={running}
                title="Active board"
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {BOARD_KIND_LABELS[b.boardKind] ?? b.id}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="board-selector"
                style={{ opacity: 0.55, fontStyle: 'italic', cursor: 'default' }}
                title="No board on canvas — add one with the Add button to compile and run code"
              >
                No board
              </span>
            )}

            {/* Serial Monitor toggle */}
            <button
              onClick={() => {
                toggleSerialMonitor();
                trackToggleSerialMonitor(!serialMonitorOpen);
              }}
              className={`canvas-serial-btn${serialMonitorOpen ? ' canvas-serial-btn-active' : ''}`}
              title="Toggle Serial Monitor"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              Serial
            </button>

            {/* ESP32-CAM webcam stream toggle */}
            {activeBoard?.boardKind === 'esp32-cam' && (
              <CameraToggle boardId={activeBoard.id} />
            )}

            {/* WiFi status indicator (ESP32 boards only) */}
            {activeBoard &&
              isEsp32Kind(activeBoard.boardKind) &&
              activeBoard.wifiStatus &&
              (() => {
                const status = activeBoard.wifiStatus.status;
                const hasIp = status === 'got_ip';
                const sessionId = getTabSessionId();
                const clientId = `${sessionId}::${activeBoard.id}`;
                const backendBase =
                  (import.meta.env.VITE_API_BASE as string | undefined) ??
                  'http://localhost:8001/api';
                const gatewayUrl = `${backendBase}/gateway/${clientId}/`;

                return (
                  <span
                    className={`canvas-wifi-badge canvas-wifi-${status}${hasIp ? ' canvas-wifi-clickable' : ''}`}
                    onClick={() => hasIp && window.open(gatewayUrl, '_blank')}
                    title={
                      hasIp
                        ? `WiFi: ${activeBoard.wifiStatus.ssid ?? 'Velxio-GUEST'} — IP: ${activeBoard.wifiStatus.ip}\nClick to open IoT Gateway ↗`
                        : status === 'connected'
                          ? `WiFi: ${activeBoard.wifiStatus.ssid ?? 'Velxio-GUEST'} — Connecting...`
                          : status === 'initializing'
                            ? 'WiFi: Initializing...'
                            : 'WiFi: Disconnected'
                    }
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <circle cx="12" cy="20" r="1" />
                    </svg>
                  </span>
                );
              })()}

            {/* BLE status indicator (ESP32 boards only) */}
            {activeBoard && isEsp32Kind(activeBoard.boardKind) && activeBoard.bleStatus && (
              <span
                className={`canvas-ble-badge canvas-ble-${activeBoard.bleStatus.status}`}
                title={
                  activeBoard.bleStatus.status === 'advertising'
                    ? 'BLE: Advertising'
                    : 'BLE: Initialized'
                }
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5" />
                </svg>
              </span>
            )}

            {/* Oscilloscope toggle */}
            <button
              onClick={toggleOscilloscope}
              className={`canvas-serial-btn${oscilloscopeOpen ? ' canvas-serial-btn-active' : ''}`}
              title="Toggle Oscilloscope / Logic Analyzer"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="2 14 6 8 10 14 14 6 18 14 22 10" />
              </svg>
              Scope
            </button>
          </div>

          <div className="canvas-header-right">
            {/* Zoom controls */}
            <div className="zoom-controls">
              <button
                className="zoom-btn"
                onClick={() =>
                  handleWheel({
                    deltaY: 100,
                    clientX: 0,
                    clientY: 0,
                    preventDefault: () => {},
                  } as any)
                }
                title="Zoom out"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                className="zoom-level"
                onClick={handleResetView}
                title="Reset view (click to reset)"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                className="zoom-btn"
                onClick={() =>
                  handleWheel({
                    deltaY: -100,
                    clientX: 0,
                    clientY: 0,
                    preventDefault: () => {},
                  } as any)
                }
                title="Zoom in"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            {/* Component count */}
            <span
              className="component-count"
              title={`${components.length} component${components.length !== 1 ? 's' : ''}`}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              </svg>
              {components.length}
            </span>

            {/* Add Component */}
            <button
              className="add-component-btn"
              onClick={() => setShowComponentPicker(true)}
              title="Add Component"
              disabled={running}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
            </button>
          </div>
        </div>
          );
          return headerSlot ? createPortal(headerJsx, headerSlot) : headerJsx;
        })()}
        <div
          ref={canvasRef}
          className="canvas-content"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => {
            isPanningRef.current = false;
            setPan({ ...panRef.current });
            setDraggedComponentId(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (wireInProgress) cancelWireCreation();
          }}
          onClick={(e) => {
            if (wireInProgress) {
              const world = toWorld(e.clientX, e.clientY);
              addWireWaypoint(world.x, world.y);
              return;
            }
            // If a segment handle drag just finished, don't also select
            if (segmentDragJustCommittedRef.current) {
              segmentDragJustCommittedRef.current = false;
              return;
            }
            // Wire selection via canvas-level hit detection
            const world = toWorld(e.clientX, e.clientY);
            const threshold = 8 / zoomRef.current;
            const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
            if (wire) {
              setSelectedWire(selectedWireId === wire.id ? null : wire.id);
            } else {
              setSelectedWire(null);
              setSelectedComponentId(null);
            }
          }}
          onDoubleClick={(e) => {
            if (wireInProgress) return;
            const world = toWorld(e.clientX, e.clientY);
            const threshold = 8 / zoomRef.current;
            const wire = findWireNearPoint(wiresRef.current, world.x, world.y, threshold);
            if (!wire) return;
            const seg = findSegmentNearPoint(wire, world.x, world.y, threshold);
            if (!seg) return;
            // Insert a draggable waypoint where the user double-clicked,
            // projected onto the segment so the wire stays orthogonal.
            const newWaypoints = insertWaypointAtSegment(
              wire.waypoints ?? [],
              seg,
              world.x,
              world.y,
            );
            updateWire(wire.id, { waypoints: newWaypoints });
            setSelectedWire(wire.id);
          }}
          style={{
            cursor: isPanningRef.current
              ? 'grabbing'
              : wireInProgress
                ? 'crosshair'
                : hoveredWireId
                  ? 'pointer'
                  : 'default',
          }}
        >
          {/* Sensor Control Panel — shown when a sensor component is clicked during simulation */}
          {sensorControlComponentId &&
            sensorControlMetadataId &&
            (() => {
              const meta = registry.getById(sensorControlMetadataId);
              return (
                <SensorControlPanel
                  componentId={sensorControlComponentId}
                  metadataId={sensorControlMetadataId}
                  sensorName={meta?.name ?? sensorControlMetadataId}
                  onClose={() => {
                    setSensorControlComponentId(null);
                    setSensorControlMetadataId(null);
                  }}
                />
              );
            })()}

          {/* Infinite world — pan+zoom applied here */}
          <div
            className="canvas-world"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            {/* Wire Layer - Renders below all components */}
            <WireLayer
              hoveredWireId={hoveredWireId}
              segmentDragPreview={segmentDragPreview}
              segmentHandles={segmentHandles}
              waypointHandles={waypointHandles}
              alignmentGuides={alignmentGuides}
              onHandleMouseDown={handleHandleMouseDown}
              onHandleTouchStart={handleHandleTouchStart}
              onWaypointMouseDown={handleWaypointMouseDown}
              onWaypointTouchStart={handleWaypointTouchStart}
            />

            {/* All boards on canvas */}
            {boards.map((board) => (
              <BoardOnCanvas
                key={board.id}
                board={board}
                running={running}
                isActive={board.id === activeBoardId}
                led13={Boolean(boardLedStates[board.id])}
                onMouseDown={(e) => {
                  setClickStartTime(Date.now());
                  setClickStartPos({ x: e.clientX, y: e.clientY });
                  const world = toWorld(e.clientX, e.clientY);
                  setDraggedComponentId(`__board__:${board.id}`);
                  setDragOffset({ x: world.x - board.x, y: world.y - board.y });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setBoardContextMenu({ boardId: board.id, x: e.clientX, y: e.clientY });
                }}
                onPinClick={handlePinClick}
                zoom={zoom}
              />
            ))}

            {/* Components using wokwi-elements */}
            <div className="components-area">
              {registryLoaded && components.map(renderComponent)}
            </div>

            {/* Electrical simulation overlay (voltages / warnings) */}
            <ElectricalOverlay />
          </div>

          {/* Wire creation mode banner — visible on both desktop and mobile */}
          {wireInProgress && (
            <div className="wire-mode-banner">
              <span>Tap a pin to connect — tap canvas for waypoints</span>
              <button onClick={() => cancelWireCreation()}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* Component Property Dialog */}
      {showPropertyDialog &&
        propertyDialogComponentId &&
        (() => {
          const component = components.find((c) => c.id === propertyDialogComponentId);
          const metadata = component ? registry.getById(component.metadataId) : null;
          if (!component || !metadata) return null;

          const element = document.getElementById(propertyDialogComponentId);
          const pinInfo = element ? (element as any).pinInfo : [];

          return (
            <ComponentPropertyDialog
              componentId={propertyDialogComponentId}
              componentMetadata={metadata}
              componentProperties={component.properties}
              position={propertyDialogPosition}
              pinInfo={pinInfo || []}
              onClose={() => setShowPropertyDialog(false)}
              onRotate={handleRotateComponent}
              onDelete={(id) => {
                removeComponent(id);
                setShowPropertyDialog(false);
              }}
              onPropertyChange={(id, propName, value) => {
                const comp = components.find((c) => c.id === id);
                if (comp) {
                  updateComponent(id, {
                    properties: { ...comp.properties, [propName]: value },
                  });
                }
              }}
            />
          );
        })()}

      {/* Custom Chip Designer Dialog */}
      {customChipComponentId &&
        (() => {
          const comp = components.find((c) => c.id === customChipComponentId);
          if (!comp) return null;
          const props = comp.properties as Record<string, unknown>;
          return (
            <CustomChipDialog
              initial={{
                chipName:   String(props.chipName   ?? 'My Chip'),
                sourceC:    String(props.sourceC    ?? ''),
                chipJson:   String(props.chipJson   ?? ''),
                wasmBase64: String(props.wasmBase64 ?? ''),
                attrs:      (props.attrs as Record<string, number>) ?? {},
              }}
              onClose={() => setCustomChipComponentId(null)}
              onSave={(data) => {
                updateComponent(customChipComponentId, {
                  properties: { ...comp.properties, ...data },
                } as any);
                setCustomChipComponentId(null);
                // Force the chip's pin layout to re-render after the save.
                recalculateAllWirePositions();
              }}
            />
          );
        })()}

      {/* Component Picker Modal */}
      <ComponentPickerModal
        isOpen={showComponentPicker}
        onClose={() => setShowComponentPicker(false)}
        onSelectComponent={handleSelectComponent}
        onSelectBoard={(kind: BoardKind) => {
          trackSelectBoard(kind);
          const sameKind = boards.filter((b) => b.boardKind === kind);
          const newBoardId = sameKind.length === 0 ? kind : `${kind}-${sameKind.length + 1}`;
          const x = boardPosition.x + boards.length * 60 + 420;
          const y = boardPosition.y + boards.length * 30;
          addBoard(kind, x, y);
          // file group is created inside addBoard
          void newBoardId;
        }}
      />

      {/* Board right-click context menu */}
      {boardContextMenu &&
        (() => {
          const board = boards.find((b) => b.id === boardContextMenu.boardId);
          const label = board ? BOARD_KIND_LABELS[board.boardKind] : 'Board';
          const connectedWires = wires.filter(
            (w) =>
              w.start.componentId === boardContextMenu.boardId ||
              w.end.componentId === boardContextMenu.boardId,
          ).length;
          return (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                onClick={() => setBoardContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setBoardContextMenu(null);
                }}
              />
              <div
                style={{
                  position: 'fixed',
                  left: boardContextMenu.x,
                  top: boardContextMenu.y,
                  background: '#252526',
                  border: '1px solid #3c3c3c',
                  borderRadius: 6,
                  padding: '4px 0',
                  zIndex: 9999,
                  minWidth: 180,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    padding: '6px 14px',
                    color: '#888',
                    fontSize: 11,
                    borderBottom: '1px solid #3c3c3c',
                    marginBottom: 2,
                  }}
                >
                  {label}
                </div>
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 14px',
                    background: 'none',
                    border: 'none',
                    color: '#e06c75',
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#2a2d2e';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                  }}
                  onClick={() => {
                    setBoardContextMenu(null);
                    setBoardToRemove(boardContextMenu.boardId);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Remove board
                  {connectedWires > 0 && (
                    <span style={{ color: '#888', fontSize: 11 }}>
                      ({connectedWires} wire{connectedWires > 1 ? 's' : ''})
                    </span>
                  )}
                </button>
              </div>
            </>
          );
        })()}

      {/* Board removal confirmation dialog */}
      {boardToRemove &&
        (() => {
          const board = boards.find((b) => b.id === boardToRemove);
          const label = board ? BOARD_KIND_LABELS[board.boardKind] : 'Board';
          const connectedWires = wires.filter(
            (w) => w.start.componentId === boardToRemove || w.end.componentId === boardToRemove,
          ).length;
          return (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.5)',
                zIndex: 10000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  background: '#1e1e1e',
                  border: '1px solid #3c3c3c',
                  borderRadius: 8,
                  padding: '20px 24px',
                  maxWidth: 380,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                }}
              >
                <h3 style={{ margin: '0 0 10px', color: '#e0e0e0', fontSize: 15 }}>
                  Remove {label}?
                </h3>
                <p style={{ margin: '0 0 16px', color: '#999', fontSize: 13, lineHeight: 1.5 }}>
                  This will remove the board from the workspace
                  {connectedWires > 0 && (
                    <>
                      {' '}
                      and{' '}
                      <strong style={{ color: '#e06c75' }}>
                        {connectedWires} connected wire{connectedWires > 1 ? 's' : ''}
                      </strong>
                    </>
                  )}
                  . This action cannot be undone.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setBoardToRemove(null)}
                    style={{
                      padding: '6px 16px',
                      background: '#333',
                      border: '1px solid #555',
                      borderRadius: 4,
                      color: '#ccc',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      removeBoard(boardToRemove);
                      setBoardToRemove(null);
                    }}
                    style={{
                      padding: '6px 16px',
                      background: '#e06c75',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};
