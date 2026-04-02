import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { generateSketch, type ChatMessage, type GeneratedFile } from '../services/chatService';
import { useEditorStore } from '../store/useEditorStore';
import './ChatbotPage.css';

interface UIMessage {
  role: 'user' | 'assistant';
  text: string;
  files?: GeneratedFile[];
  error?: boolean;
}

const SUGGESTIONS = [
  'Blink an LED on pin 13 every 500ms',
  'Read a button and toggle an LED',
  'PWM fade an LED in and out',
  'Play a melody with a buzzer using pitches.h',
  'Read a potentiometer and print the value over Serial',
  'Traffic light with red, yellow, green LEDs',
];

export const ChatbotPage: React.FC = () => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadFiles = useEditorStore((s) => s.loadFiles);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const buildApiMessages = (uiMessages: UIMessage[]): ChatMessage[] =>
    uiMessages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role,
        content: m.role === 'assistant' && m.files?.length
          ? `${m.text}\n\n${JSON.stringify({ files: m.files }, null, 2)}`
          : m.text,
      }));

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg: UIMessage = { role: 'user', text: trimmed };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      setLoading(true);

      try {
        const res = await generateSketch(buildApiMessages(nextMessages));
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: res.explanation, files: res.files },
        ]);
      } catch (err: any) {
        const detail =
          err?.response?.data?.detail ??
          err?.message ??
          'Something went wrong. Is the backend running and ANTHROPIC_API_KEY set?';
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: detail, error: true },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [messages, loading],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const loadIntoEditor = (files: GeneratedFile[]) => {
    loadFiles(
      files.map((f, i) => ({
        id: `chat-${Date.now()}-${i}`,
        name: f.name,
        content: f.content,
        modified: false,
      })),
    );
    navigate('/editor');
  };

  return (
    <div className="chatbot-page">
      <AppHeader />

      {messages.length === 0 && !loading ? (
        <div className="chatbot-empty">
          <div className="chatbot-empty-icon">⚡</div>
          <h2>Arduino Code Generator</h2>
          <p>
            Describe what you want your Arduino to do in plain English and get
            ready-to-compile <code>.ino</code> and <code>.h</code> files instantly.
          </p>
          <div className="chatbot-suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="chatbot-suggestion-btn"
                onClick={() => send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chatbot-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-row chat-row-${msg.role}`}>
              <div className={`chat-avatar chat-avatar-${msg.role === 'user' ? 'user' : 'ai'}`}>
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="chat-bubble" style={msg.error ? { borderColor: '#f44747', color: '#f88' } : {}}>
                {msg.text}
                {msg.files && msg.files.length > 0 && (
                  <div className="chat-files">
                    {msg.files.map((file) => (
                      <div key={file.name} className="chat-file-card">
                        <div className="chat-file-header">
                          <span className="chat-file-name">{file.name}</span>
                        </div>
                        <pre className="chat-file-code">{file.content}</pre>
                      </div>
                    ))}
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="chat-load-btn"
                        onClick={() => loadIntoEditor(msg.files!)}
                      >
                        Load into Editor →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="chat-row">
              <div className="chat-avatar chat-avatar-ai">AI</div>
              <div className="chat-bubble">
                <div className="chat-typing">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      <div className="chatbot-input-area">
        <div className="chatbot-input-row">
          <textarea
            ref={textareaRef}
            className="chatbot-textarea"
            rows={1}
            placeholder="Describe your Arduino project… (Enter to send, Shift+Enter for new line)"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className="chatbot-send-btn"
            onClick={() => send(input)}
            disabled={loading || !input.trim()}
            title="Send"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="chatbot-hint">Shift+Enter for new line · Enter to send</div>
      </div>
    </div>
  );
};
