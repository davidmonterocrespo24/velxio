import React, { useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../../store/useChatStore';
import { generateSketch } from '../../services/chatService';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { parseDiagramJson } from '../../utils/wokwiZip';
import type { ChatMessage, GeneratedFile } from '../../services/chatService';
import './ChatWidget.css';

const SUGGESTIONS = [
  'Blink LED on pin 13 every 500ms',
  'Read a button and toggle an LED',
  'Play a melody with a buzzer',
  'Traffic light with red, yellow, green LEDs',
];

function buildApiMessages(uiMessages: ReturnType<typeof useChatStore.getState>['messages']): ChatMessage[] {
  return uiMessages
    .filter((m) => !m.error)
    .map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.files?.length
          ? `${m.text}\n\n${JSON.stringify({ files: m.files }, null, 2)}`
          : m.text,
    }));
}

export const ChatWidget: React.FC = () => {
  const navigate = useNavigate();
  const { isOpen, messages, loading, close, addMessage, setLoading } = useChatStore();
  const loadFiles = useEditorStore((s) => s.loadFiles);

  const [input, setInput] = React.useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (isOpen) textareaRef.current?.focus();
  }, [isOpen]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg = { role: 'user' as const, text: trimmed };
      addMessage(userMsg);
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      setLoading(true);

      const currentMessages = [...useChatStore.getState().messages];

      try {
        const res = await generateSketch(buildApiMessages(currentMessages));
        addMessage({ role: 'assistant', text: res.explanation, files: res.files, diagram: res.diagram });
      } catch (err: any) {
        const detail =
          err?.response?.data?.detail ??
          err?.message ??
          'Error — is the backend running and ANTHROPIC_API_KEY set?';
        addMessage({ role: 'assistant', text: detail, error: true });
      } finally {
        setLoading(false);
      }
    },
    [loading, addMessage, setLoading],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const loadIntoEditor = (files: GeneratedFile[], diagram?: object) => {
    // Load code files into editor
    if (files.length > 0) {
      loadFiles(
        files.map((f, i) => ({
          id: `chat-${Date.now()}-${i}`,
          name: f.name,
          content: f.content,
          modified: false,
        })),
      );
    }

    // Load diagram into simulator — diagram is already a parsed JS object, no string escaping issues
    if (diagram) {
      try {
        const { boardType, boardPosition, components, wires } = parseDiagramJson(JSON.stringify(diagram));
        const { stopSimulation, setBoardType, setBoardPosition, setComponents, setWires } =
          useSimulatorStore.getState();
        stopSimulation();
        setBoardType(boardType as any);
        setBoardPosition(boardPosition);
        setComponents(components);
        setWires(wires);
      } catch (e) {
        console.warn('[ChatWidget] Failed to load diagram:', e);
      }
    }

    navigate('/editor');
    close();
  };

  return (
    <div className={`chat-widget-panel${isOpen ? ' chat-widget-open' : ''}`}>
      {/* Panel header */}
      <div className="chat-widget-header">
        <div className="chat-widget-title">
          <span className="chat-widget-title-dot" />
          AI Code Generator
        </div>
        <button className="chat-widget-close" onClick={close} title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages or empty state */}
      {messages.length === 0 && !loading ? (
        <div className="chat-widget-empty">
          <p>Describe your Arduino project and get ready-to-compile code instantly.</p>
          <div className="chat-widget-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chat-widget-suggestion" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-widget-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`cw-row cw-row-${msg.role}`}>
              <div className={`cw-avatar cw-avatar-${msg.role === 'user' ? 'user' : 'ai'}`}>
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className={`cw-bubble${msg.error ? ' cw-bubble-error' : ''}`}>
                {msg.text}
                {(msg.files && msg.files.length > 0 || msg.diagram) && (
                  <div className="cw-files">
                    {msg.files?.map((file) => (
                      <div key={file.name} className="cw-file-card">
                        <div className="cw-file-name">{file.name}</div>
                        <pre className="cw-file-code">{file.content}</pre>
                      </div>
                    ))}
                    {msg.diagram && (
                      <div className="cw-file-card cw-file-diagram">
                        <div className="cw-file-name">diagram.json</div>
                        <div className="cw-file-diagram-hint">Circuit diagram included — click Load to see it on the canvas</div>
                      </div>
                    )}
                    <button className="cw-load-btn" onClick={() => loadIntoEditor(msg.files ?? [], msg.diagram)}>
                      Load into Editor →
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="cw-row">
              <div className="cw-avatar cw-avatar-ai">AI</div>
              <div className="cw-bubble">
                <div className="cw-typing"><span /><span /><span /></div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Input bar */}
      <div className="chat-widget-input-area">
        <div className="chat-widget-input-row">
          <textarea
            ref={textareaRef}
            className="chat-widget-textarea"
            rows={1}
            placeholder="Describe your Arduino project…"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className="chat-widget-send"
            onClick={() => send(input)}
            disabled={loading || !input.trim()}
            title="Send (Enter)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="chat-widget-hint">Enter to send · Shift+Enter for new line</div>
      </div>
    </div>
  );
};
