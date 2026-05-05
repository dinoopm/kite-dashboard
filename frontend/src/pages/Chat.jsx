import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

const SUGGESTIONS = [
  'What was the total FII net buying last week?',
  'Which stocks had the highest volume spike today?',
  'Show me the latest bulk deals above ₹10 crore',
  'Which stocks are currently under ASM surveillance?',
  'What is the FII vs DII net activity for the last 5 days?',
];

function SqlBlock({ sql }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          color: 'var(--accent)',
          borderRadius: '6px',
          padding: '0.25rem 0.75rem',
          fontSize: '0.75rem',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {open ? 'Hide SQL' : 'View SQL'}
      </button>
      {open && (
        <pre style={{
          marginTop: '0.5rem',
          background: 'rgba(15, 23, 42, 0.8)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          fontSize: '0.8rem',
          color: '#7dd3fc',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {sql}
        </pre>
      )}
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '1rem',
    }}>
      <div style={{
        maxWidth: '80%',
        background: isUser
          ? 'rgba(56, 189, 248, 0.15)'
          : 'rgba(30, 41, 59, 0.8)',
        border: `1px solid ${isUser ? 'rgba(56, 189, 248, 0.3)' : 'var(--border)'}`,
        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        padding: '0.75rem 1rem',
      }}>
        {isUser ? (
          <p style={{ margin: 0, color: 'var(--text-primary)' }}>{msg.content}</p>
        ) : msg.error ? (
          <p style={{ margin: 0, color: 'var(--danger)' }}>{msg.error}</p>
        ) : (
          <>
            <div style={{ color: 'var(--text-primary)', lineHeight: 1.6 }}>
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
            {msg.rowCount !== undefined && (
              <p style={{ margin: '0.5rem 0 0', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {msg.rowCount} row{msg.rowCount !== 1 ? 's' : ''} returned
              </p>
            )}
            {msg.sql && <SqlBlock sql={msg.sql} />}
          </>
        )}
      </div>
    </div>
  );
}

function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const send = async (question) => {
    const q = (question || input).trim();
    if (!q || loading) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setMessages(prev => [...prev, { role: 'user', content: q }]);
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!mountedRef.current) return;
      setMessages(prev => [
        ...prev,
        data.error
          ? { role: 'assistant', error: data.error, sql: data.sql }
          : {
              role: 'assistant',
              content: data.answer || '_(No answer was generated.)_',
              sql: data.sql,
              rowCount: data.rowCount,
            },
      ]);
    } catch (err) {
      if (err.name === 'AbortError' || !mountedRef.current) return;
      setMessages(prev => [...prev, { role: 'assistant', error: 'Network error: ' + err.message }]);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        inputRef.current?.focus();
      }
      abortRef.current = null;
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="dashboard-layout" style={{ maxWidth: '900px' }}>
      <div className="header">
        <div>
          <h2 style={{ margin: 0 }}>Market Intelligence</h2>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>Ask anything about FII/DII flows, bulk deals, surveillance, and more</p>
        </div>
      </div>

      {/* Chat window */}
      <div className="glass-panel" style={{
        minHeight: '480px',
        maxHeight: '60vh',
        overflowY: 'auto',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        marginBottom: '1rem',
      }}>
        {messages.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '1.5rem' }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '1rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                Ask a question about Indian market data
              </p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', opacity: 0.6 }}>
                Powered by Llama 3.3 70B via Groq
              </p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center', maxWidth: '600px' }}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  style={{
                    background: 'rgba(56, 189, 248, 0.06)',
                    border: '1px solid rgba(56, 189, 248, 0.15)',
                    color: 'var(--text-secondary)',
                    borderRadius: '20px',
                    padding: '0.4rem 0.9rem',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseOver={e => {
                    e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                    e.currentTarget.style.color = 'var(--accent)';
                  }}
                  onMouseOut={e => {
                    e.currentTarget.style.background = 'rgba(56, 189, 248, 0.06)';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => <Message key={i} msg={msg} />)}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1rem' }}>
                <div style={{
                  background: 'rgba(30, 41, 59, 0.8)',
                  border: '1px solid var(--border)',
                  borderRadius: '16px 16px 16px 4px',
                  padding: '0.75rem 1.25rem',
                  color: 'var(--accent)',
                  fontSize: '0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}>
                  <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>⟳</span>
                  Querying Database...
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input bar */}
      <div className="glass-panel" style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading}
          placeholder="Ask about FII/DII activity, bulk deals, surveillance stocks..."
          rows={1}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            fontFamily: 'inherit',
            resize: 'none',
            lineHeight: '1.5',
            maxHeight: '120px',
            overflowY: 'auto',
          }}
          onInput={e => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
        />
        <button
          onClick={() => send()}
          disabled={!input.trim() || loading}
          style={{
            background: !input.trim() || loading ? 'rgba(56, 189, 248, 0.1)' : 'var(--accent)',
            color: !input.trim() || loading ? 'var(--text-secondary)' : '#0f172a',
            border: 'none',
            borderRadius: '10px',
            padding: '0.5rem 1.25rem',
            fontWeight: '600',
            cursor: !input.trim() || loading ? 'default' : 'pointer',
            fontSize: '0.9rem',
            fontFamily: 'inherit',
            transition: 'all 0.2s',
            whiteSpace: 'nowrap',
          }}
        >
          Ask
        </button>
      </div>
      <p style={{ textAlign: 'center', fontSize: '0.72rem', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '0.5rem' }}>
        Press Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}

export default Chat;
