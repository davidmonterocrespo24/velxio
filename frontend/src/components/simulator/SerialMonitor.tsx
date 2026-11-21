/**
 * Serial Monitor — multi-board tabbed view.
 * Each board has its own tab with serial output, input, and clear button.
 */

import { DropdownSelect } from '../ui/DropdownSelect';
import { WorkspaceClearButton } from '../editor/WorkspaceClearButton';
import React, { useRef, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { getTabSessionId } from '../../simulation/Esp32Bridge';
import { openDeviceGateway } from '../../lib/openDeviceGateway';
import { boardDisplayName, isPiBoardKind } from '../../types/board';
import { PiTerminal } from '../raspberry-pi/PiTerminal';
import { serialMonitorText } from '../../store/serialMonitorText';
import { useHardwareSerial } from '../../hooks/useHardwareSerial';

export type SerialMonitorSource = 'simulation' | 'hardware';

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600];

function cleanSerialText(text: string) {
  // A plain log can't render ANSI commands or terminal control bytes.
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Short labels for tabs
const BOARD_SHORT_LABEL: Partial<Record<string, string>> = {
  'arduino-uno': 'Uno',
  'arduino-nano': 'Nano',
  'arduino-mega': 'Mega',
  'raspberry-pi-pico': 'Pico',
  'pi-pico-w': 'Pico W',
  'raspberry-pi-3': 'Pi 3B',
  'raspberry-pi-4': 'Pi 4B',
  'raspberry-pi-5': 'Pi 5',
  esp32: 'ESP32',
  'esp32-devkit-c-v4': 'ESP32',
  'esp32-cam': 'ESP32-CAM',
  'wemos-lolin32-lite': 'Lolin32',
  'esp32-s3': 'ESP32-S3',
  'xiao-esp32-s3': 'XIAO-S3',
  'arduino-nano-esp32': 'Nano ESP32',
  'esp32-c3': 'ESP32-C3',
  'xiao-esp32-c3': 'XIAO-C3',
  'aitewinrobot-esp32c3-supermini': 'C3 Mini',
  attiny85: 'ATtiny85',
};

const BOARD_ICON: Partial<Record<string, string>> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'pi-pico-w': '◆',
  'raspberry-pi-3': '⬛',
  'raspberry-pi-4': '⬛',
  'raspberry-pi-5': '⬛',
  esp32: '⬡',
  'esp32-devkit-c-v4': '⬡',
  'esp32-cam': '⬡',
  'wemos-lolin32-lite': '⬡',
  'esp32-s3': '⬡',
  'xiao-esp32-s3': '⬡',
  'arduino-nano-esp32': '⬡',
  'esp32-c3': '⬡',
  'xiao-esp32-c3': '⬡',
  'aitewinrobot-esp32c3-supermini': '⬡',
  attiny85: '▪',
};

const BOARD_COLOR: Partial<Record<string, string>> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'pi-pico-w': '#ce93d8',
  'raspberry-pi-3': 'var(--color-feedback-error)',
  'raspberry-pi-4': 'var(--color-feedback-error)',
  'raspberry-pi-5': 'var(--color-feedback-error)',
  esp32: 'var(--color-feedback-success)',
  'esp32-devkit-c-v4': 'var(--color-feedback-success)',
  'esp32-cam': 'var(--color-feedback-success)',
  'wemos-lolin32-lite': 'var(--color-feedback-success)',
  'esp32-s3': 'var(--color-feedback-success)',
  'xiao-esp32-s3': 'var(--color-feedback-success)',
  'arduino-nano-esp32': 'var(--color-feedback-success)',
  'esp32-c3': 'var(--color-feedback-success)',
  'xiao-esp32-c3': 'var(--color-feedback-success)',
  'aitewinrobot-esp32c3-supermini': 'var(--color-feedback-success)',
  attiny85: 'var(--color-feedback-warning)',
};

export const SerialMonitor: React.FC<{
  onClose?: () => void;
  source?: SerialMonitorSource;
  onSourceChange?: (source: SerialMonitorSource) => void;
}> = ({ onClose, source = 'simulation', onSourceChange }) => {
  const { t } = useTranslation();
  const hardware = useHardwareSerial();
  const isHardware = source === 'hardware';
  const [baudRate, setBaudRate] = useState(115200);
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const serialWriteToBoard = useSimulatorStore((s) => s.serialWriteToBoard);
  const clearBoardSerialOutput = useSimulatorStore((s) => s.clearBoardSerialOutput);

  // Active tab defaults to activeBoardId, updates when active board changes
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Track last-seen serial output length per board for unread dots
  const [lastSeenLen, setLastSeenLen] = useState<Record<string, number>>({});

  const [drafts, setDrafts] = useState({ simulation: '', hardware: '' });
  const inputValue = drafts[source];
  const [lineEnding, setLineEnding] = useState<'none' | 'nl' | 'cr' | 'both'>('nl');
  const [autoscroll, setAutoscroll] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);

  // Sync active tab to activeBoardId when it changes
  useEffect(() => {
    if (activeBoardId) setActiveTabId(activeBoardId);
  }, [activeBoardId]);

  // Fallback: if activeTab is gone, pick first board
  const resolvedTabId =
    (boards.find((b) => b.id === activeTabId) ? activeTabId : boards[0]?.id) ?? null;
  const activeBoard = boards.find((b) => b.id === resolvedTabId);
  const visibleOutput = isHardware ? hardware.output : activeBoard?.serialOutput;
  const canSend = isHardware ? hardware.status === 'connected' : !!activeBoard?.running;
  const showPiTerminal = !isHardware && activeBoard?.running &&
    activeBoard.engineMode !== 'instant' && isPiBoardKind(activeBoard.boardKind);

  // Snapshot the current length the moment a tab becomes active so any
  // future bytes register as unread on *other* tabs. Deliberately omits
  // `activeBoard?.serialOutput.length` from the deps — the unread dot is
  // already hidden on the active tab (`hasUnread && !isActive`), so there's
  // no need to re-snapshot on every byte arrival. Doing so under a high
  // serial rate (~600 bytes/s from `Serial.println` in a tight loop) drove
  // React's useSyncExternalStore into "Maximum update depth exceeded".
  useEffect(() => {
    if (resolvedTabId) {
      const board = boards.find((b) => b.id === resolvedTabId);
      if (board) {
        setLastSeenLen((prev) => ({ ...prev, [resolvedTabId]: board.serialOutput.length }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTabId]);

  // Auto-scroll when output changes on the visible tab. Depending on the
  // string identity (not its length) means one scroll per RAF flush — the
  // batcher guarantees this doesn't run faster than 60 Hz.
  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [visibleOutput, source, autoscroll]);

  const handleSend = () => {
    if (!canSend) return;
    if (!inputValue && lineEnding === 'none') return;
    let text = inputValue;
    switch (lineEnding) {
      case 'nl':
        text += '\n';
        break;
      case 'cr':
        text += '\r';
        break;
      case 'both':
        text += '\r\n';
        break;
    }
    if (isHardware) void hardware.write(text);
    else if (resolvedTabId) serialWriteToBoard(resolvedTabId, text);
    setDrafts((previous) => ({ ...previous, [source]: '' }));
  };

  const isMicroPython = !isHardware && activeBoard?.languageMode === 'micropython';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
      return;
    }
    // MicroPython REPL control characters (works for RP2040 and ESP32)
    if (resolvedTabId && isMicroPython && e.ctrlKey) {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        serialWriteToBoard(resolvedTabId, '\x03'); // Ctrl+C — keyboard interrupt
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        serialWriteToBoard(resolvedTabId, '\x04'); // Ctrl+D — soft reset
      }
    }
  };

  const handleTabClick = (boardId: string) => {
    setActiveTabId(boardId);
    const board = boards.find((b) => b.id === boardId);
    if (board) {
      setLastSeenLen((prev) => ({ ...prev, [boardId]: board.serialOutput.length }));
    }
  };

  const closeLabel = t('editor.serial.close', 'Close Serial Monitor');
  const closeButton = onClose && (
    <button
      type="button"
      className="workspace-panel-close"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={onClose}
    >
      <X size={15} aria-hidden />
    </button>
  );
  const heading = (
    <div className={onClose ? 'workspace-serial-heading workspace-panel-header--closable' : 'workspace-serial-heading'}>
      <div style={styles.headerDetails}>
        <span className="workspace-panel-title">{t('editor.serial.title')}</span>
        {isMicroPython && (
          <span style={{ color: '#ce93d8', fontSize: 11, fontWeight: 600 }}>
            MicroPython REPL
          </span>
        )}
        {!isHardware && !isMicroPython && activeBoard?.serialLink?.source === 'usb-cdc' && (
          <span
            style={styles.baudRate}
            title="This console is a USB device endpoint, not a UART. As on the real board, the terminal's baud setting is ignored."
          >
            USB CDC
          </span>
        )}
        {!isHardware && activeBoard?.serialBaudRate != null &&
          activeBoard.serialBaudRate > 0 &&
          activeBoard.serialLink?.source !== 'usb-cdc' &&
          !isMicroPython && (
            <span style={styles.baudRate} title="The rate the board is clocking Serial at.">
              {activeBoard.serialBaudRate.toLocaleString()} baud
            </span>
          )}
        {/* Overlay slot for per-board terminal actions (empty in OSS). */}
        {!isHardware && activeBoard && <span data-velxio-slot="serial-actions" />}
      </div>
      <div style={styles.headerControls}>
        <label style={styles.autoscrollLabel}>
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
            style={styles.checkbox}
          />
          {t('editor.serial.autoscroll')}
        </label>
        <WorkspaceClearButton
          onClear={isHardware ? hardware.clear : () => resolvedTabId && clearBoardSerialOutput(resolvedTabId)}
          title={t(isHardware ? 'editor.serial.hardware.clear' : 'editor.serial.clearTitle')}
          disabled={!isHardware && !activeBoard}
        />
      </div>
      {closeButton}
    </div>
  );

  const sources = onSourceChange && (
    <div style={styles.tabStrip} role="group" aria-label={t('editor.serial.source')}>
      {(['simulation', 'hardware'] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={source === item}
          onClick={() => onSourceChange(item)}
          style={{
            ...styles.tab,
            ...(source === item ? {
              ...styles.tabActive,
              borderBottomColor: 'var(--color-action-primary)',
              color: 'var(--color-fg-default)',
            } : {}),
          }}
        >
          {item === 'hardware' ? t('editor.serial.hardware.tab') : t('editor.serial.simulation')}
        </button>
      ))}
    </div>
  );

  if (!isHardware && boards.length === 0) {
    return (
      <div style={styles.container}>
        {heading}
        {sources}
        <pre style={styles.output}>{t('editor.serial.addBoard')}</pre>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {heading}
      {sources}
      {isHardware ? (
        <div style={styles.hardwareControls}>
          {hardware.available && (
            <>
              <DropdownSelect
                aria-label={t('editor.serial.hardware.baudRate')}
                value={baudRate}
                onValueChange={(value) => setBaudRate(Number(value))}
                disabled={hardware.status !== 'disconnected'}
                style={styles.select}
              >
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>{t('editor.serial.hardware.baud', { rate })}</option>
                ))}
              </DropdownSelect>
              <button
                type="button"
                style={styles.sendBtn}
                disabled={hardware.status === 'connecting' || hardware.status === 'disconnecting'}
                onClick={() => {
                  if (hardware.status === 'connected') void hardware.disconnect();
                  else if (hardware.status === 'disconnected') void hardware.connect(baudRate);
                }}
              >
                {t(`editor.serial.hardware.${hardware.status}`)}
              </button>
              {hardware.status === 'connected' && (
                <span role="status">{t('editor.serial.hardware.portOpen')}</span>
              )}
            </>
          )}
          {hardware.error && <span role="alert" style={styles.hardwareError}>{hardware.error}</span>}
        </div>
      ) : (
        <>
          {/* Tab strip */}
          <div style={styles.tabStrip}>
            {boards.map((board) => {
              const isActive = board.id === resolvedTabId;
              const color = BOARD_COLOR[board.boardKind] ?? 'var(--wb-10)';
              const hasUnread = board.serialOutput.length > (lastSeenLen[board.id] ?? 0);
              return (
                <button
                  key={board.id}
                  style={{
                    ...styles.tab,
                    ...(isActive ? { ...styles.tabActive, borderBottomColor: color, color } : {}),
                  }}
                  onClick={() => handleTabClick(board.id)}
                  title={boardDisplayName(board)}
                >
                  <span
                    style={{ fontSize: 9, marginRight: 3, color: isActive ? color : 'var(--wb-10)' }}
                  >
                    {BOARD_ICON[board.boardKind] ?? '●'}
                  </span>
                  {board.name?.trim() || BOARD_SHORT_LABEL[board.boardKind] || board.boardKind}
                  {hasUnread && !isActive && <span style={styles.unreadDot} />}
                </button>
              );
            })}

          </div>

          {/* Overlay slot for a full-width notice about the LINK itself — e.g. the
              terminal's baud not matching the rate the board is clocking, which is
              why the text below is unreadable (empty in OSS). */}
          <div data-velxio-slot="serial-banner" />
        </>
      )}

      {/* Output area. QEMU-Linux boards get the interactive xterm (shell
          input, line editing, ANSI) instead of the read-only mirror — this
          replaced the separate RaspberryPiWorkspace as the one terminal. */}
      {showPiTerminal ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PiTerminal key={activeBoard.id} boardId={activeBoard.id} />
        </div>
      ) : (
        <pre ref={outputRef} style={styles.output}>
          {isHardware
            ? cleanSerialText(hardware.output) || (
                !hardware.available
                  ? t('editor.serial.hardware.unavailable')
                  : hardware.status === 'connected'
                    ? t('editor.serial.waitingData')
                    : t('editor.serial.hardware.connectHint')
              )
            : activeBoard?.serialOutput
            ? (() => {
                const text = cleanSerialText(serialMonitorText(activeBoard));
                // ESP32 (QEMU slirp) hands out 192.168.4.x; the Pico W virtual
                // net hands out 10.13.37.x. Both reach their emulated server
                // through the same /api/gateway proxy, so linkify either subnet.
                // The http:// prefix is OPTIONAL: Arduino sketches tend to print
                // full URLs, but MicroPython's idiom is the bare ifconfig()[0]
                // ("Open: 192.168.4.15") — requiring the scheme left exactly
                // those users with a dead-end IP that is unreachable outside
                // the emulated network. The trailing dot-check keeps a longer
                // address like 192.168.4.15.99 from half-matching.
                const ipRegex =
                  /(?:http:\/\/)?(?:192\.168\.4|10\.13\.37)\.(\d{1,3})(?!\d|\.\d)(\/[^\s]*)?/g;
                // ...but ONLY once the board actually joined a network. A sketch
                // that calls WiFi.softAP() becomes the access point instead of a
                // client, and the ESP32's SoftAP default address is 192.168.4.1
                // — the very subnet above. The address alone cannot tell the two
                // apart, so a captive-portal sketch used to get a gateway link
                // that could never resolve: the bridge the proxy looks up is
                // registered on 'got_ip', which only a STATION ever reaches, so
                // the click landed on a 404 telling the user to connect to WiFi
                // when the sketch had deliberately chosen not to. Gate on the
                // status every family reports: QEMU (wifi_status_parser),
                // the in-browser JS engines, and the Pico W's cyw43 peripheral
                // all emit 'got_ip'. Without it the IP stays plain text.
                const reachable = activeBoard.wifiStatus?.status === 'got_ip';
                const matches = reachable ? [...text.matchAll(ipRegex)] : [];

                if (matches.length > 0) {
                  const parts: (string | React.ReactNode)[] = [];
                  let lastIdx = 0;
                  const sessionId = getTabSessionId();
                  const backendBase =
                    (import.meta.env.VITE_API_BASE as string | undefined) ??
                    'http://localhost:8001/api';

                  matches.forEach((m, i) => {
                    const start = m.index!;
                    const end = start + m[0].length;
                    const path = m[2] || '/';
                    const clientId = `${sessionId}::${activeBoard.id}`;
                    const gatewayUrl = `${backendBase}/gateway/${clientId}${path}`;

                    parts.push(text.slice(lastIdx, start));
                    // Boards whose network stack lives in THIS tab (Pico W, and
                    // any ESP32 on the in-browser JS engine — wifiStatus carries
                    // inBrowser) must open in the in-app iframe: a new tab
                    // backgrounds this one, the emulation gets timer-throttled,
                    // and the in-chip server times out. QEMU boards run
                    // backend-side, so a new tab is fine there.
                    const servesInTab =
                      activeBoard.boardKind === 'pi-pico-w' ||
                      activeBoard.wifiStatus?.inBrowser === true;
                    parts.push(
                      <a
                        key={i}
                        href={gatewayUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={
                          servesInTab
                            ? (e) => {
                                e.preventDefault();
                                openDeviceGateway(gatewayUrl);
                              }
                            : undefined
                        }
                        style={{
                          color: '#4fc3f7',
                          textDecoration: 'underline',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                        title={t('editor.serial.iotGatewayTitle')}
                      >
                        {m[0]} ({t('editor.serial.openIotGateway')} ↗)
                      </a>,
                    );
                    lastIdx = end;
                  });
                  parts.push(text.slice(lastIdx));
                  return parts;
                }
                return text;
              })()
            : activeBoard?.running
              ? t('editor.serial.waitingData') + '\n'
              : t('editor.serial.startSim') + '\n'}
        </pre>
      )}

      {/* Input row — the xterm handles Pi input itself */}
      {!showPiTerminal && (
        <div style={styles.inputRow}>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => {
              const value = e.target.value;
              setDrafts((previous) => ({ ...previous, [source]: value }));
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isMicroPython
                ? t('editor.serial.placeholderPython')
                : t('editor.serial.placeholderText')
            }
            style={styles.input}
            disabled={!canSend}
          />
          <DropdownSelect
            aria-label={t('editor.serial.lineEnd.label')}
            value={lineEnding}
            onValueChange={(value) => setLineEnding(value as typeof lineEnding)}
            style={styles.select}
          >
            <option value="none">{t('editor.serial.lineEnd.none')}</option>
            <option value="nl">{t('editor.serial.lineEnd.nl')}</option>
            <option value="cr">{t('editor.serial.lineEnd.cr')}</option>
            <option value="both">{t('editor.serial.lineEnd.both')}</option>
          </DropdownSelect>
          <button type="button" onClick={handleSend} disabled={!canSend} style={styles.sendBtn}>
            {t('editor.serial.send')}
          </button>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--wb-2)',
    borderTop: '1px solid var(--wb-6)',
    fontFamily: 'monospace',
    fontSize: 13,
    minHeight: 0,
  },
  tabStrip: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--wb-3)',
    borderBottom: '1px solid var(--wb-6)',
    minHeight: 32,
    flexShrink: 0,
    overflow: 'hidden',
  },
  tab: {
    background: 'none',
    borderWidth: 0,
    borderStyle: 'solid',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    color: 'var(--wb-10)',
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    whiteSpace: 'nowrap',
    position: 'relative',
  },
  tabActive: {
    background: 'rgba(255,255,255,0.04)',
  },
  headerDetails: {
    flex: 1,
    minWidth: 0,
    minHeight: 22,
    display: 'flex',
    alignItems: 'center',
    gap: '4px 8px',
    flexWrap: 'wrap',
  },
  headerControls: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: 8,
  },
  hardwareControls: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    padding: '4px 8px',
    fontSize: 11,
  },
  hardwareError: {
    color: 'var(--color-feedback-error)',
    overflowWrap: 'anywhere',
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#4fc3f7',
    flexShrink: 0,
    marginLeft: 3,
  },
  baudRate: {
    color: 'var(--color-accent-fg)',
    fontSize: 11,
    fontFamily: 'monospace',
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-6)',
    borderRadius: 3,
    padding: '1px 6px',
  },
  autoscrollLabel: {
    color: 'var(--wb-10)',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
  },
  checkbox: {
    margin: 0,
    cursor: 'pointer',
  },
  output: {
    flex: 1,
    margin: 0,
    padding: 8,
    color: 'var(--color-terminal-fg)',
    background: 'var(--color-terminal-bg)',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minHeight: 0,
    fontSize: 13,
    lineHeight: '1.4',
  },
  inputRow: {
    display: 'flex',
    gap: 4,
    padding: 4,
    background: 'var(--wb-3)',
    borderTop: '1px solid var(--wb-6)',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-7)',
    color: 'var(--wb-12)',
    padding: '4px 8px',
    borderRadius: 3,
    fontFamily: 'monospace',
    fontSize: 12,
    outline: 'none',
  },
  select: {
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-7)',
    color: 'var(--wb-12)',
    paddingBlock: '4px',
    paddingInlineStart: '8px',
    borderRadius: 3,
    fontSize: 11,
    outline: 'none',
  },
  sendBtn: {
    background: 'var(--color-action-primary)',
    border: 'none',
    color: 'var(--color-fg-on-action)',
    padding: '4px 12px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
};
