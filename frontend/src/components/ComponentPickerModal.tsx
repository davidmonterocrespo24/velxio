/**
 * Component Picker Modal
 *
 * Modal interface for searching and selecting components from the wokwi-elements library.
 * Features:
 * - Search bar with real-time filtering
 * - Category tabs for filtering
 * - Grid layout with component thumbnails
 * - Click to select and add component
 */

import React, { useState, useEffect, useMemo } from 'react';
import { ComponentRegistry } from '../services/ComponentRegistry';
import type { ComponentMetadata, ComponentCategory } from '../types/component-metadata';
import type { BoardKind } from '../types/board';
import { BOARD_KIND_LABELS } from '../types/board';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import { Attiny85 } from './components-wokwi/Attiny85';
import { RiscVBoard } from './components-wokwi/RiscVBoard';
import './components-wokwi/Esp32Element';        // registers wokwi-esp32
import './components-wokwi/PiPicoWElement';      // registers wokwi-pi-pico-w
import './ComponentPickerModal.css';

interface ComponentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectComponent: (metadata: ComponentMetadata) => void;
  onSelectBoard?: (kind: BoardKind) => void;
}

const BOARD_DESCRIPTIONS: Record<BoardKind, string> = {
  'arduino-uno':        '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-nano':       'Compact 8-bit AVR, same as Uno',
  'arduino-mega':       '8-bit AVR, 256KB flash, 54 digital I/O',
  'raspberry-pi-pico':  'RP2040 dual-core Cortex-M0+',
  'pi-pico-w':          'RP2040 + WiFi/BT, same emulator as Pico',
  'raspberry-pi-3':     'ARM64 Cortex-A53 quad-core, Linux/Python (QEMU)',
  'esp32':              'Xtensa LX6 dual-core, WiFi+BT, 38 GPIO (QEMU)',
  'esp32-devkit-c-v4':  'ESP32 DevKit C V4, official Espressif (QEMU)',
  'esp32-cam':          'ESP32 + 2MP camera, microSD (QEMU)',
  'wemos-lolin32-lite': 'Compact ESP32, LiPo battery support (QEMU)',
  'esp32-s3':           'Xtensa LX7 dual-core, WiFi+BT, AI accel (QEMU)',
  'xiao-esp32-s3':      'Seeed XIAO tiny form, 8MB flash+PSRAM (QEMU)',
  'arduino-nano-esp32': 'Nano form-factor, ESP32-S3, RGB LED (QEMU)',
  'esp32-c3':           'RISC-V single-core, WiFi+BLE, 22 GPIO (QEMU)',
  'xiao-esp32-c3':      'Seeed XIAO ESP32-C3 mini board (QEMU)',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3 SuperMini (QEMU)',
  'attiny85':           '8-bit AVR, 8KB flash, 6 GPIO (browser)',
  'riscv-generic':      'RV32EC 48 MHz, 16KB flash, CH32V003 (browser)',
};

const BOARD_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4af', 'arduino-nano': '#4af', 'arduino-mega': '#4af',
  'raspberry-pi-pico': '#4af', 'pi-pico-w': '#4af',
  'raspberry-pi-3': '#c22',
  'esp32': '#e8a020', 'esp32-devkit-c-v4': '#e8a020', 'esp32-cam': '#e8a020',
  'wemos-lolin32-lite': '#e8a020',
  'esp32-s3': '#e8a020', 'xiao-esp32-s3': '#e8a020', 'arduino-nano-esp32': '#4af',
  'esp32-c3': '#e8a020', 'xiao-esp32-c3': '#e8a020',
  'aitewinrobot-esp32c3-supermini': '#e8a020',
  'attiny85': '#4af', 'riscv-generic': '#4a4',
};

const ALL_BOARDS: BoardKind[] = [
  'arduino-uno', 'arduino-nano', 'arduino-mega',
  'raspberry-pi-pico', 'pi-pico-w', 'raspberry-pi-3',
  'esp32', 'esp32-devkit-c-v4', 'esp32-cam', 'wemos-lolin32-lite',
  'esp32-s3', 'xiao-esp32-s3', 'arduino-nano-esp32',
  'esp32-c3', 'xiao-esp32-c3', 'aitewinrobot-esp32c3-supermini',
  'attiny85', 'riscv-generic',
];

export const ComponentPickerModal: React.FC<ComponentPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectComponent,
  onSelectBoard,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ComponentCategory | 'all' | 'boards'>('all');
  const [registry] = useState(() => ComponentRegistry.getInstance());
  const [isLoading, setIsLoading] = useState(true);

  // Wait for registry to load
  useEffect(() => {
    const loadRegistry = async () => {
      await registry.load();
      setIsLoading(false);
    };
    loadRegistry();
  }, [registry]);

  // Filter components based on search and category
  const filteredComponents = useMemo(() => {
    if (isLoading) return [];

    let components = searchQuery
      ? registry.search(searchQuery)
      : registry.getAllComponents();

    if (selectedCategory !== 'all') {
      components = components.filter(c => c.category === selectedCategory);
    }

    return components;
  }, [searchQuery, selectedCategory, registry, isLoading]);

  // Get available categories
  const categories = useMemo(() => {
    if (isLoading) return [];
    return registry.getCategories();
  }, [registry, isLoading]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="component-picker-overlay" onClick={onClose}>
      <div className="component-picker-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Add Component</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            X
          </button>
        </div>

        {/* Search Bar */}
        <div className="search-section">
          <div className="search-input-wrapper">
            <input
              type="text"
              className="search-input"
              placeholder="Search components..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery && (
              <button
                className="clear-search-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                X
              </button>
            )}
          </div>
        </div>

        {/* Category Tabs */}
        <div className="category-tabs">
          <button
            className={`category-tab ${selectedCategory === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('all')}
          >
            All Components
          </button>
          {categories.filter((c) => c !== 'boards').map((category) => (
            <button
              key={category}
              className={`category-tab ${selectedCategory === category ? 'active' : ''}`}
              onClick={() => setSelectedCategory(category)}
            >
              {ComponentRegistry.getCategoryDisplayName(category)}
            </button>
          ))}
          {onSelectBoard && (
            <button
              className={`category-tab ${selectedCategory === 'boards' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('boards')}
            >
              Boards
            </button>
          )}
        </div>

        {/* Boards Panel */}
        {selectedCategory === 'boards' ? (
          <div className="components-grid">
            {ALL_BOARDS.map((kind) => (
              <BoardCard
                key={kind}
                kind={kind}
                onSelect={() => { onSelectBoard?.(kind); onClose(); }}
              />
            ))}
          </div>
        ) : (
          <>
            {/* Boards row in "All Components" view */}
            {selectedCategory === 'all' && onSelectBoard && (
              <div className="components-grid" style={{ borderBottom: '1px solid #333', paddingBottom: 8, marginBottom: 4 }}>
                {ALL_BOARDS.filter((k) =>
                  !searchQuery || BOARD_KIND_LABELS[k].toLowerCase().includes(searchQuery.toLowerCase())
                ).map((kind) => (
                  <BoardCard
                    key={kind}
                    kind={kind}
                    onSelect={() => { onSelectBoard(kind); onClose(); }}
                  />
                ))}
              </div>
            )}

            {/* Components Grid */}
            <div className="components-grid">
              {isLoading ? (
                <div className="loading-state">
                  <div className="spinner"></div>
                  <p>Loading components...</p>
                </div>
              ) : filteredComponents.length === 0 ? (
                <div className="no-results">
                  <p>No components found</p>
                  {searchQuery && (
                    <button
                      className="clear-filters-btn"
                      onClick={() => {
                        setSearchQuery('');
                        setSelectedCategory('all');
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                filteredComponents.map((component) => (
                  <ComponentCard
                    key={component.id}
                    component={component}
                    onSelect={() => onSelectComponent(component)}
                  />
                ))
              )}
            </div>

            {/* Footer Info */}
            <div className="modal-footer">
              <span className="component-count">
                {filteredComponents.length} component{filteredComponents.length !== 1 ? 's' : ''} available
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * Component Card - Individual component display in the grid
 */
interface ComponentCardProps {
  component: ComponentMetadata;
  onSelect: () => void;
}

const ComponentCard: React.FC<ComponentCardProps> = ({ component, onSelect }) => {
  const thumbnailRef = React.useRef<HTMLDivElement>(null);

  // Render actual web component as thumbnail
  React.useEffect(() => {
    if (!thumbnailRef.current) return;

    // Create the actual wokwi element
    const element = document.createElement(component.tagName);

    // Scale factors for different component types
    let scale = 0.5;
    if (component.tagName.includes('arduino') || component.tagName.includes('esp32')) {
      scale = 0.35; // Boards are larger, scale them down more
    } else if (component.tagName.includes('lcd') || component.tagName.includes('display')) {
      scale = 0.4; // Displays need a bit more space
    }

    (element as HTMLElement).style.transform = `scale(${scale})`;
    (element as HTMLElement).style.transformOrigin = 'center center';

    // Set default properties for better preview appearance
    if (component.tagName === 'wokwi-led') {
      (element as any).value = true; // Turn on LED
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-rgb-led') {
      (element as any).red = true;
      (element as any).green = true;
      (element as any).blue = true;
    } else if (component.tagName === 'wokwi-pushbutton') {
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-lcd1602' || component.tagName === 'wokwi-lcd2004') {
      (element as any).text = 'Hello World!';
    }

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(element);

    return () => {
      if (thumbnailRef.current) {
        thumbnailRef.current.innerHTML = '';
      }
    };
  }, [component.tagName, component.defaultValues]);

  return (
    <button className="component-card" onClick={onSelect}>
      <div className="card-thumbnail">
        <div ref={thumbnailRef} className="component-preview" />
      </div>
      <div className="card-content">
        <div className="card-name">{component.name}</div>
        {component.description && (
          <div className="card-description">{component.description}</div>
        )}
        <div className="card-meta">
          <span className="card-category">{component.category}</span>
          {component.pinCount > 0 && (
            <span className="card-pins">{component.pinCount} pins</span>
          )}
        </div>
      </div>
    </button>
  );
};

// Tag name used to render a thumbnail for each board kind.
// Boards without a tag will show a generic chip icon.
const BOARD_TAG: Partial<Record<BoardKind, string>> = {
  'arduino-uno':        'wokwi-arduino-uno',
  'arduino-nano':       'wokwi-arduino-nano',
  'arduino-mega':       'wokwi-arduino-mega',
  'raspberry-pi-pico':  'wokwi-nano-rp2040-connect',
  'pi-pico-w':          'wokwi-pi-pico-w',
  'esp32':              'wokwi-esp32',
  'esp32-devkit-c-v4':  'wokwi-esp32',
  'esp32-cam':          'wokwi-esp32',
  'wemos-lolin32-lite': 'wokwi-esp32',
  'esp32-s3':           'wokwi-esp32',
  'xiao-esp32-s3':      'wokwi-esp32',
  'arduino-nano-esp32': 'wokwi-esp32',
  'esp32-c3':           'wokwi-esp32',
  'xiao-esp32-c3':      'wokwi-esp32',
  'aitewinrobot-esp32c3-supermini': 'wokwi-esp32',
};

interface BoardCardProps {
  kind: BoardKind;
  onSelect: () => void;
}

const BoardCard: React.FC<BoardCardProps> = ({ kind, onSelect }) => {
  const thumbnailRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!thumbnailRef.current) return;
    // React-rendered boards and Pi3 handled in JSX below
    if (kind === 'raspberry-pi-3' || kind === 'attiny85' || kind === 'riscv-generic') return;

    const tag = BOARD_TAG[kind];
    if (!tag) return;

    const el = document.createElement(tag) as HTMLElement;
    // Use setAttribute so observedAttributes + connectedCallback read the correct value
    el.setAttribute('board-kind', kind);
    el.style.transform = 'scale(0.28)';
    el.style.transformOrigin = 'center center';

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(el);

    return () => { if (thumbnailRef.current) thumbnailRef.current.innerHTML = ''; };
  }, [kind]);

  const reactThumbnail =
    kind === 'raspberry-pi-3' ? (
      <img src={raspberryPi3Svg} alt="Raspberry Pi 3" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
    ) : kind === 'attiny85' ? (
      <div style={{ transform: 'scale(0.55)', transformOrigin: 'center center' }}>
        <Attiny85 />
      </div>
    ) : kind === 'riscv-generic' ? (
      <div style={{ transform: 'scale(0.42)', transformOrigin: 'center center' }}>
        <RiscVBoard />
      </div>
    ) : null;

  return (
    <button className="component-card" onClick={onSelect}>
      <div className="card-thumbnail">
        {reactThumbnail ? (
          reactThumbnail
        ) : (
          <div ref={thumbnailRef} className="component-preview" />
        )}
      </div>
      <div className="card-content">
        <div className="card-name">{BOARD_KIND_LABELS[kind]}</div>
        <div className="card-description">{BOARD_DESCRIPTIONS[kind]}</div>
      </div>
    </button>
  );
};
