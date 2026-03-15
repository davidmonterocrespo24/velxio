import { useSimulatorStore } from '../../store/useSimulatorStore';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ComponentPickerModal } from '../ComponentPickerModal';
import { ComponentPropertyDialog } from './ComponentPropertyDialog';
import { DynamicComponent, createComponentFromMetadata } from '../DynamicComponent';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { PinSelector } from './PinSelector';
import { WireLayer } from './WireLayer';
import type { SegmentHandle } from './WireLayer';
import { BoardOnCanvas } from './BoardOnCanvas';
import { PartSimulationRegistry } from '../../simulation/parts';
import { PinOverlay } from './PinOverlay';
import { isBoardComponent, boardPinToNumber } from '../../utils/boardPinMapping';
import { autoWireColor, WIRE_KEY_COLORS } from '../../utils/wireUtils';
import {
  findWireNearPoint,
  getRenderedPoints,
  getRenderedSegments,
  moveSegment,
  renderedToWaypoints,
  renderedPointsToPath,
} from '../../utils/wireHitDetection';
import type { ComponentMetadata } from '../../types/component-metadata';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import './SimulatorCanvas.css';

export const SimulatorCanvas = () => {
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
    updateComponent,
    serialMonitorOpen,
    toggleSerialMonitor,
  } = useSimulatorStore();

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
  const [showPinSelector, setShowPinSelector] = useState(false);
  const [pinSelectorPos, setPinSelectorPos] = useState({ x: 0, y: 0 });

  // Component property dialog
  const [showPropertyDialog, setShowPropertyDialog] = useState(false);
  const [propertyDialogComponentId, setPropertyDialogComponentId] = useState<string | null>(null);
  const [propertyDialogPosition, setPropertyDialogPosition] = useState({ x: 0, y: 0 });

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
  /** Set to true during mouseup if a segment drag committed, so onClick can skip selection. */
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

  // Touch-specific state refs (for single-finger drag and pinch-to-zoom)
  const touchDraggedComponentIdRef = useRef<string | null>(null);
  const touchDragOffsetRef = useRef({ x: 0, y: 0 });
  const touchClickStartTimeRef = useRef(0);
  const touchClickStartPosRef = useRef({ x: 0, y: 0 });
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const pinchStartMidRef = useRef({ x: 0, y: 0 });
  const pinchStartPanRef = useRef({ x: 0, y: 0 });

  // Convert viewport coords to world (canvas) coords
  const toWorld = useCallback((screenX: number, screenY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: screenX, y: screenY };
    return {
      x: (screenX - rect.left - panRef.current.x) / zoomRef.current,
      y: (screenY - rect.top  - panRef.current.y) / zoomRef.current,
    };
  }, []);

  // Initialize simulator on mount
  useEffect(() => {
    initSimulator();
  }, [initSimulator]);

  // Auto-start/stop Pi bridges when simulation state changes
  const startBoard = useSimulatorStore((s) => s.startBoard);
  const stopBoard = useSimulatorStore((s) => s.stopBoard);
  useEffect(() => {
    const remoteBoards = boards.filter(
      (b) => b.boardKind === 'raspberry-pi-3' ||
             b.boardKind === 'esp32' || b.boardKind === 'esp32-s3' || b.boardKind === 'esp32-c3'
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
  // single-finger pan, single-finger component drag, and two-finger pinch-to-zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault(); // Prevent browser scroll / mouse-event synthesis

      pinchStartDistRef.current = 0; // Reset pinch state on each new gesture

      if (e.touches.length === 2) {
        // ── Two-finger pinch: cancel any active drag/pan and prepare zoom ──
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
      touchClickStartTimeRef.current = Date.now();
      touchClickStartPosRef.current = { x: touch.clientX, y: touch.clientY };

      // Identify what element was touched
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const componentWrapper = target?.closest('[data-component-id]') as HTMLElement | null;
      const boardOverlay = target?.closest('[data-board-overlay]') as HTMLElement | null;

      if (componentWrapper && !runningRef.current) {
        // ── Single finger on a component: start drag ──
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
        // ── Single finger on the board overlay: start board drag ──
        const board = boardPositionRef.current;
        const world = toWorld(touch.clientX, touch.clientY);
        touchDraggedComponentIdRef.current = '__board__';
        touchDragOffsetRef.current = {
          x: world.x - board.x,
          y: world.y - board.y,
        };
      } else {
        // ── Single finger on empty canvas: start pan ──
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
          setBoardPosition({
            x: world.x - touchDragOffsetRef.current.x,
            y: world.y - touchDragOffsetRef.current.y,
          }, boardId);
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
      e.preventDefault();

      // ── Finish pinch zoom: commit values to React state ──
      if (pinchStartDistRef.current > 0 && e.touches.length < 2) {
        setZoom(zoomRef.current);
        setPan({ ...panRef.current });
        pinchStartDistRef.current = 0;
      }

      if (e.touches.length > 0) return; // Still fingers on screen

      // ── Finish panning ──
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setPan({ ...panRef.current });
      }

      const changed = e.changedTouches[0];

      // ── Finish component/board drag ──
      if (touchDraggedComponentIdRef.current) {
        const elapsed = Date.now() - touchClickStartTimeRef.current;
        const dx = changed ? changed.clientX - touchClickStartPosRef.current.x : 0;
        const dy = changed ? changed.clientY - touchClickStartPosRef.current.y : 0;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Short tap with minimal movement → open property dialog
        if (dist < 5 && elapsed < 300 && touchDraggedComponentIdRef.current !== '__board__') {
          const component = componentsRef.current.find(
            (c) => c.id === touchDraggedComponentIdRef.current
          );
          if (component) {
            setPropertyDialogComponentId(touchDraggedComponentIdRef.current);
            setPropertyDialogPosition({ x: component.x, y: component.y });
            setShowPropertyDialog(true);
          }
        }

        recalculateAllWirePositions();
        touchDraggedComponentIdRef.current = null;
        return;
      }

      // ── Short tap on empty canvas: deselect ──
      if (changed) {
        const elapsed = Date.now() - touchClickStartTimeRef.current;
        const dx = changed.clientX - touchClickStartPosRef.current.x;
        const dy = changed.clientY - touchClickStartPosRef.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 5 && elapsed < 300) {
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

    // Helper to add subscription
    const subscribeComponentToPin = (component: any, pin: number, componentPinName?: string) => {
      const unsubscribe = pinManager.onPinChange(
        pin,
        (_pin, state) => {
          // 1. Update React state for standard properties
          updateComponentState(component.id, state);

          // 2. Delegate to PartSimulationRegistry for custom visual updates
          const logic = PartSimulationRegistry.get(component.metadataId);
          if (logic && logic.onPinStateChange) {
            const el = document.getElementById(component.id);
            if (el) {
              logic.onPinStateChange(componentPinName || 'A', state, el);
            }
          }

          console.log(`Component ${component.id} on pin ${pin}: ${state ? 'HIGH' : 'LOW'}`);
        }
      );
      unsubscribers.push(unsubscribe);
    };

    components.forEach((component) => {
      // 1. Subscribe by explicit pin property
      if (component.properties.pin !== undefined) {
        subscribeComponentToPin(component, component.properties.pin as number, 'A');
      } else {
        // 2. Subscribe by finding wires connected to arduino
        const connectedWires = useSimulatorStore.getState().wires.filter(
          w => w.start.componentId === component.id || w.end.componentId === component.id
        );

        connectedWires.forEach(wire => {
          const isStartSelf = wire.start.componentId === component.id;
          const selfEndpoint = isStartSelf ? wire.start : wire.end;
          const otherEndpoint = isStartSelf ? wire.end : wire.start;

          if (isBoardComponent(otherEndpoint.componentId)) {
            // Use the board's actual boardKind (not just its instance ID) so that
            // a board whose ID is 'arduino-uno' but whose kind is 'esp32' gets the
            // correct GPIO mapping ('GPIO4' → 4, not null).
            const boardInstance = boards.find(b => b.id === otherEndpoint.componentId);
            const lookupKey = boardInstance ? boardInstance.boardKind : otherEndpoint.componentId;
            const pin = boardPinToNumber(lookupKey, otherEndpoint.pinName);
            console.log(
              `[WirePin] component=${component.id} board=${otherEndpoint.componentId}` +
              ` kind=${lookupKey} pinName=${otherEndpoint.pinName} → gpioPin=${pin}`
            );
            if (pin !== null) {
              subscribeComponentToPin(component, pin, selfEndpoint.pinName);
            } else {
              console.warn(`[WirePin] Could not resolve pin "${otherEndpoint.pinName}" on ${lookupKey}`);
            }
          }
        });
      }
    });

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [components, pinManager, updateComponentState]);

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComponentId) {
        removeComponent(selectedComponentId);
        setSelectedComponentId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponentId, removeComponent]);

  // Handle component selection from modal
  const handleSelectComponent = (metadata: ComponentMetadata) => {
    // Calculate grid position to avoid overlapping
    // Use existing components count to determine position
    const componentsCount = components.length;
    const gridSize = 250; // Space between components
    const cols = 3; // Components per row

    const col = componentsCount % cols;
    const row = Math.floor(componentsCount / cols);

    const x = 400 + (col * gridSize);
    const y = 100 + (row * gridSize);

    const component = createComponentFromMetadata(metadata, x, y);
    addComponent(component as any);
    setShowComponentPicker(false);
  };

  // Component selection (double click to open pin selector)
  const handleComponentDoubleClick = (componentId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSelectedComponentId(componentId);
    setPinSelectorPos({ x: event.clientX, y: event.clientY });
    setShowPinSelector(true);
  };

  // Pin assignment
  const handlePinSelect = (componentId: string, pin: number) => {
    updateComponent(componentId, {
      properties: {
        ...components.find((c) => c.id === componentId)?.properties,
        pin,
      },
    } as any);
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
    if (showPinSelector || showPropertyDialog) return;

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
      const newValue = sd.axis === 'horizontal' ? world.y : world.x;
      const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
      const overridePath = renderedPointsToPath(newPts);
      setSegmentDragPreview({ wireId: sd.wireId, overridePath });
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
        const newValue = sd.axis === 'horizontal' ? world.y : world.x;
        const newPts = moveSegment(sd.renderedPts, sd.segIndex, sd.axis, newValue);
        updateWire(sd.wireId, { waypoints: renderedToWaypoints(newPts) });
      }
      segmentDragRef.current = null;
      setSegmentDragPreview(null);
      return;
    }

    if (draggedComponentId) {
      const timeDiff = Date.now() - clickStartTime;
      const posDiff = Math.sqrt(
        Math.pow(e.clientX - clickStartPos.x, 2) +
        Math.pow(e.clientY - clickStartPos.y, 2)
      );

      if (posDiff < 5 && timeDiff < 300) {
        if (draggedComponentId.startsWith('__board__:')) {
          // Click on a board — make it the active board (editor switches to its code)
          const boardId = draggedComponentId.slice('__board__:'.length);
          useSimulatorStore.getState().setActiveBoardId(boardId);
        } else if (draggedComponentId !== '__board__') {
          const component = components.find((c) => c.id === draggedComponentId);
          if (component) {
            setPropertyDialogComponentId(draggedComponentId);
            setPropertyDialogPosition({ x: component.x, y: component.y });
            setShowPropertyDialog(true);
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
  }, [wireInProgress, cancelWireCreation, selectedWireId, removeWire, setWireInProgressColor, updateWire]);

  // Recalculate wire positions when components change (e.g., when loading an example)
  useEffect(() => {
    // Wait for components to render and pinInfo to be available
    // Use multiple retries to ensure pinInfo is ready
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Try at 100ms, 300ms, and 500ms to ensure all components have rendered
    timers.push(setTimeout(() => recalculateAllWirePositions(), 100));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 300));
    timers.push(setTimeout(() => recalculateAllWirePositions(), 500));

    return () => timers.forEach(t => clearTimeout(t));
  }, [components, recalculateAllWirePositions]);

  // Auto-pan to keep the board visible after a project import/load.
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
      const newPan = {
        x: rect.width  / 4 - boardPosition.x * currentZoom,
        y: rect.height / 4 - boardPosition.y * currentZoom,
      };
      panRef.current = newPan;
      setPan(newPan);
    }, 150);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components.length]);

  // Render component using dynamic renderer
  const renderComponent = (component: any) => {
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
            // Only handle UI events when simulation is NOT running
            if (!running) {
              handleComponentMouseDown(component.id, e);
            }
          }}
          onDoubleClick={(e) => {
            // Only handle UI events when simulation is NOT running
            if (!running) {
              handleComponentDoubleClick(component.id, e);
            }
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
          />
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="simulator-canvas-container">
      {/* ESP32 crash notification */}
      {esp32CrashBoardId && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1000, background: '#c0392b', color: '#fff',
          padding: '8px 16px', borderRadius: 6, display: 'flex', alignItems: 'center',
          gap: 12, fontSize: 13, boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>
          <span>ESP32 crash detected on board <strong>{esp32CrashBoardId}</strong> — cache error (IDF incompatibility)</span>
          <button
            onClick={dismissEsp32Crash}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.6)',
              color: '#fff', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Canvas */}
      <div className="simulator-canvas">
        <div className="canvas-header">
          <div className="canvas-header-left">
            {/* Status LED */}
            <span className={`status-dot ${running ? 'running' : 'stopped'}`} title={running ? 'Running' : 'Stopped'} />

            {/* Active board selector (multi-board) */}
            <select
              className="board-selector"
              value={activeBoardId ?? ''}
              onChange={(e) => useSimulatorStore.getState().setActiveBoardId(e.target.value)}
              disabled={running}
              title="Active board"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>{BOARD_KIND_LABELS[b.boardKind] ?? b.id}</option>
              ))}
            </select>

            {/* Serial Monitor toggle */}
            <button
              onClick={toggleSerialMonitor}
              className={`canvas-serial-btn${serialMonitorOpen ? ' canvas-serial-btn-active' : ''}`}
              title="Toggle Serial Monitor"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              Serial
            </button>

            {/* Oscilloscope toggle */}
            <button
              onClick={toggleOscilloscope}
              className={`canvas-serial-btn${oscilloscopeOpen ? ' canvas-serial-btn-active' : ''}`}
              title="Toggle Oscilloscope / Logic Analyzer"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 14 6 8 10 14 14 6 18 14 22 10" />
              </svg>
              Scope
            </button>
          </div>

          <div className="canvas-header-right">
            {/* Zoom controls */}
            <div className="zoom-controls">
              <button className="zoom-btn" onClick={() => handleWheel({ deltaY: 100, clientX: 0, clientY: 0, preventDefault: () => {} } as any)} title="Zoom out">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button className="zoom-level" onClick={handleResetView} title="Reset view (click to reset)">
                {Math.round(zoom * 100)}%
              </button>
              <button className="zoom-btn" onClick={() => handleWheel({ deltaY: -100, clientX: 0, clientY: 0, preventDefault: () => {} } as any)} title="Zoom in">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
            </div>

            {/* Component count */}
            <span className="component-count" title={`${components.length} component${components.length !== 1 ? 's' : ''}`}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
            </button>

          </div>
        </div>
        <div
          ref={canvasRef}
          className="canvas-content"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => { isPanningRef.current = false; setPan({ ...panRef.current }); setDraggedComponentId(null); }}
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
            if (wire) {
              removeWire(wire.id);
            }
          }}
          style={{
            cursor: isPanningRef.current ? 'grabbing'
              : wireInProgress ? 'crosshair'
              : hoveredWireId ? 'pointer'
              : 'default',
          }}
        >
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
              onHandleMouseDown={handleHandleMouseDown}
            />

            {/* All boards on canvas */}
            {boards.map((board) => (
              <BoardOnCanvas
                key={board.id}
                board={board}
                running={running}
                isActive={board.id === activeBoardId}
                led13={Boolean(components.find((c) => c.id === 'led-builtin')?.properties.state)}
                onMouseDown={(e) => {
                  setClickStartTime(Date.now());
                  setClickStartPos({ x: e.clientX, y: e.clientY });
                  const world = toWorld(e.clientX, e.clientY);
                  setDraggedComponentId(`__board__:${board.id}`);
                  setDragOffset({ x: world.x - board.x, y: world.y - board.y });
                }}
                onPinClick={handlePinClick}
              />
            ))}

            {/* Components using wokwi-elements */}
            <div className="components-area">{registryLoaded && components.map(renderComponent)}</div>
          </div>
        </div>
      </div>

      {/* Pin Selector Modal */}
      {showPinSelector && selectedComponentId && (
        <PinSelector
          componentId={selectedComponentId}
          componentType={
            components.find((c) => c.id === selectedComponentId)?.metadataId || 'unknown'
          }
          currentPin={
            components.find((c) => c.id === selectedComponentId)?.properties.pin as number | undefined
          }
          onPinSelect={handlePinSelect}
          onClose={() => setShowPinSelector(false)}
          position={pinSelectorPos}
        />
      )}

      {/* Component Property Dialog */}
      {showPropertyDialog && propertyDialogComponentId && (() => {
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
          />
        );
      })()}

      {/* Component Picker Modal */}
      <ComponentPickerModal
        isOpen={showComponentPicker}
        onClose={() => setShowComponentPicker(false)}
        onSelectComponent={handleSelectComponent}
        onSelectBoard={(kind: BoardKind) => {
          const sameKind = boards.filter((b) => b.boardKind === kind);
          const newBoardId = sameKind.length === 0 ? kind : `${kind}-${sameKind.length + 1}`;
          const x = boardPosition.x + boards.length * 60 + 420;
          const y = boardPosition.y + boards.length * 30;
          addBoard(kind, x, y);
          // file group is created inside addBoard
          void newBoardId;
        }}
      />

    </div>
  );
};
