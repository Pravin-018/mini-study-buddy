import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom';

const AuthContext = createContext(null);
const tokenKey = 'studyBuddyToken';

async function api(path, options = {}) {
  const token = localStorage.getItem(tokenKey);
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const oauth = new URLSearchParams(window.location.search).get('oauth');
    if (localStorage.getItem(tokenKey) || oauth === 'success') {
      api('/api/auth/me').then(data => setUser(data.user)).catch(() => {
        localStorage.removeItem(tokenKey);
      }).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    if (oauth) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  async function signIn(email, password, action) {
    const data = await api(`/api/auth/${action}`, {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    localStorage.setItem(tokenKey, data.token);
    setUser(data.user);
  }
  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    finally {
      localStorage.removeItem(tokenKey);
      setUser(null);
    }
  }
  return <AuthContext.Provider value={{ user, loading, signIn, signOut }}>{children}</AuthContext.Provider>;
}

function useAuth() {
  return useContext(AuthContext);
}

function Button({ children, variant = '', ...props }) {
  return <button className={`button ${variant}`} {...props}>{children}</button>;
}

function Brand({ compact = false }) {
  return <Link className={`brand ${compact ? 'brand-compact' : ''}`} to="/">
    <span className="brand-mark">✦</span>
    <span>study<span className="brand-light">buddy</span></span>
  </Link>;
}

function Landing() {
  const { user } = useAuth();
  const [ai, setAi] = useState(null);
  useEffect(() => { api('/api/status').then(setAi).catch(() => setAi({ aiConfigured: false })); }, []);
  return <div className="landing">
    <header className="landing-nav wrap-wide">
      <Brand />
      <div className="nav-actions">
        {user ? <Link className="button" to="/app">Open dashboard <span>→</span></Link> :
          <><Link className="nav-login" to="/login">Log in</Link><Link className="button" to="/register">Get started <span>→</span></Link></>}
      </div>
    </header>
    <main>
      <section className="hero wrap-wide">
        <div className="hero-copy">
          <div className="eyebrow"><span className="status-dot" /> YOUR FRIENDLY AI STUDY PARTNER</div>
          <h1>Make learning<br />feel <em>a little easier.</em></h1>
          <p>Ask questions, organize your notes, and make a study plan that works for you. One calm space for your next big idea.</p>
          <div className="hero-actions">
            <Link className="button button-large" to={user ? '/app' : '/register'}>Start studying <span>→</span></Link>
            <span className="hero-note">Free to explore · Built for curious minds</span>
          </div>
          <div className="hero-avatars"><div className="avatar-stack"><span>J</span><span>M</span><span>A</span></div><span>Made for your everyday learning</span></div>
        </div>
        <div className="hero-art" aria-label="Study dashboard preview">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="preview-card">
            <div className="preview-top"><span className="tiny-spark">✦</span><span>YOUR STUDY SPACE</span><span className="preview-dots">•••</span></div>
            <div className="preview-greeting">Good morning, Alex <span>☀</span></div>
            <p className="preview-subtitle">A little progress goes a long way.</p>
            <div className="preview-progress"><div><span>Weekly focus</span><b>4.5h</b></div><div className="progress-track"><span /></div><small>You're building a great rhythm ✨</small></div>
            <div className="preview-chat"><div className="mini-avatar">✦</div><div><b>Study Buddy</b><p>Think of photosynthesis as a tiny solar-powered kitchen. 🌱</p></div></div>
            <div className="preview-chips"><span>Explain a concept</span><span>Make a plan</span></div>
          </div>
          <div className="float-note float-note-a">✧ &nbsp; One step at a time</div>
          <div className="float-note float-note-b"><span>✓</span> Notes ready</div>
        </div>
      </section>
      <section className="features-section">
        <div className="wrap-wide">
          <div className="section-intro"><span className="eyebrow">A SPACE TO LEARN YOUR WAY</span><h2>Your study toolkit,<br /><em>all in one place.</em></h2></div>
          <div className="feature-grid">
            <article className="feature-card feature-purple"><div className="feature-icon">✧</div><h3>Ask anything</h3><p>Get friendly, clear explanations and follow-up help whenever a topic feels tricky.</p><span className="feature-number">01</span></article>
            <article className="feature-card feature-peach"><div className="feature-icon">▤</div><h3>Your notes, in context</h3><p>Save what matters and ask questions grounded in your own study materials.</p><span className="feature-number">02</span></article>
            <article className="feature-card feature-blue"><div className="feature-icon">◷</div><h3>Plans that fit</h3><p>Turn a topic and the time you have into a practical study session checklist.</p><span className="feature-number">03</span></article>
          </div>
        </div>
      </section>
    </main>
    <footer className="landing-footer wrap-wide"><Brand compact /><span>{ai && !ai.aiConfigured ? 'Demo mode is ready — add an API key for live AI.' : 'A small buddy for your big goals.'}</span><span>Made for learning with care ✦</span></footer>
  </div>;
}

function AuthPage({ mode }) {
  const { user, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  if (user) return <Navigate to="/app" replace />;
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (mode === 'register' && password !== confirm) return setError('Your passwords do not match.');
    setBusy(true);
    try {
      await signIn(email, password, mode);
      navigate('/app');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen">
    <div className="auth-top"><Brand /><Link to="/">Back to home</Link></div>
    <section className="auth-card">
      <div className="auth-mark">✦</div>
      <span className="eyebrow">{mode === 'register' ? 'A FRESH START' : 'WELCOME BACK'}</span>
      <h1>{mode === 'register' ? 'Create your space.' : 'Let’s pick up where you left off.'}</h1>
      <p className="muted">{mode === 'register' ? 'A little support can make a big difference.' : 'Your next learning moment is waiting.'}</p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <form onSubmit={submit} className="form-stack">
        <label>Email address<input type="email" autoComplete="email" required maxLength="254" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        <label>Password<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength="8" maxLength="128" required value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
        {mode === 'register' && <label>Confirm password<input type="password" autoComplete="new-password" minLength="8" maxLength="128" required value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="Type it again" /></label>}
        <Button disabled={busy}>{busy ? 'Just a moment…' : mode === 'register' ? 'Create account' : 'Log in'} <span>→</span></Button>
      </form>
      <div className="auth-divider"><span>or</span></div>
      <a className="button button-outline google-button" href="/auth/google">Continue with Google</a>
      <p className="auth-switch">{mode === 'register' ? 'Already have an account?' : 'New to Study Buddy?'} <Link to={mode === 'register' ? '/login' : '/register'}>{mode === 'register' ? 'Log in' : 'Create an account'}</Link></p>
    </section>
    <p className="auth-foot">Your learning space, at your pace ✦</p>
  </main>;
}

function Protected({ admin = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="full-loading">Getting your study space ready…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/app" replace />;
  return <Outlet />;
}

const navItems = [
  { to: '/app', label: 'Overview', icon: '⌂', end: true },
  { to: '/app/chat', label: 'AI chat', icon: '✧' },
  { to: '/app/notes', label: 'My notes', icon: '▤' },
  { to: '/app/planner', label: 'Study planner', icon: '◷' },
  { to: '/app/profile', label: 'Profile', icon: '○' }
];

function AppLayout() {
  const { user, signOut } = useAuth();
  const [chats, setChats] = useState([]);
  const [mobileMenu, setMobileMenu] = useState(false);
  const refreshChats = () => api('/api/chats').then(setChats).catch(() => setChats([]));
  useEffect(() => { refreshChats(); }, []);
  return <div className="app-shell">
    <button className="mobile-menu-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle navigation">☰</button>
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <Brand />
      <Link className="sidebar-new" to="/app/chat" onClick={() => setMobileMenu(false)}><span>＋</span> New chat</Link>
      <div className="sidebar-label">YOUR SPACE</div>
      <nav className="side-nav">
        {navItems.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMobileMenu(false)} className={({ isActive }) => isActive ? 'side-link active' : 'side-link'}><span>{item.icon}</span>{item.label}</NavLink>)}
        {user.role === 'admin' && <NavLink to="/admin" onClick={() => setMobileMenu(false)} className={({ isActive }) => isActive ? 'side-link active' : 'side-link'}><span>▦</span>Admin dashboard</NavLink>}
      </nav>
      <div className="sidebar-label recent-label">RECENT CHATS</div>
      <div className="recent-chats">{chats.slice(0, 6).map(chat => <Link key={chat.id} to={`/app/chat/${chat.id}`} onClick={() => setMobileMenu(false)} title={chat.title}> <span>↗</span>{chat.title}</Link>)}{!chats.length && <span className="empty-mini">Your chats will appear here</span>}</div>
      <div className="sidebar-bottom"><div className="user-mini"><span className="user-avatar">{user.email[0].toUpperCase()}</span><span className="user-identity"><b>{user.email}</b><small>{user.role}</small></span><button title="Log out" onClick={signOut}>↪</button></div></div>
    </aside>
    <main className="app-main"><Outlet context={{ refreshChats }} /></main>
  </div>;
}

function PageHeader({ eyebrow, title, description, action }) {
  return <div className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState({ usage: null, notes: [], chats: [] });
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api('/api/usage'), api('/api/notes'), api('/api/chats')])
      .then(([usage, notes, chats]) => setData({ usage, notes, chats }))
      .catch(err => setError(err.message));
  }, []);
  return <div className="page-content">
    <div className="welcome-banner"><div><span className="eyebrow">YOUR STUDY SPACE</span><h1>Good to see you, {user.email.split('@')[0]} <span>✦</span></h1><p>What would you like to learn today?</p><Link className="button button-white" to="/app/chat">Start a new chat <span>→</span></Link></div><div className="welcome-art">✺</div></div>
    {error && <div className="alert alert-error">{error}</div>}
    <div className="stat-grid">
      <article className="stat-card"><span className="stat-icon purple-icon">✧</span><span>Saved notes</span><b>{data.notes.length}</b><small>Your knowledge, collected</small></article>
      <article className="stat-card"><span className="stat-icon peach-icon">☷</span><span>Conversations</span><b>{data.chats.length}</b><small>Questions explored</small></article>
      <article className="stat-card"><span className="stat-icon blue-icon">◷</span><span>AI requests</span><b>{data.usage?.requests ?? '—'}</b><small>Live AI usage recorded</small></article>
      <article className="stat-card"><span className="stat-icon green-icon">⌁</span><span>Tokens used</span><b>{data.usage ? Number(data.usage.input_tokens + data.usage.output_tokens).toLocaleString() : '—'}</b><small>Estimated cost: ${data.usage?.estimated_cost_usd?.toFixed(4) ?? '0.0000'}</small></article>
    </div>
    <div className="dashboard-lower">
      <section className="content-card"><div className="card-heading"><div><span className="eyebrow">KEEP GOING</span><h2>Recent conversations</h2></div><Link to="/app/chat">New chat <span>→</span></Link></div>
        {data.chats.length ? <div className="conversation-list">{data.chats.slice(0, 5).map((chat, index) => <Link key={chat.id} to={`/app/chat/${chat.id}`} className="conversation-row"><span className={`conversation-icon color-${index % 3}`}>✧</span><span><b>{chat.title}</b><small>{chat.last_message || 'Start exploring this topic'}</small></span><span>→</span></Link>)}</div> : <div className="empty-state"><span>✧</span><b>Your first conversation is a question away.</b><Link to="/app/chat">Ask your study buddy →</Link></div>}
      </section>
      <section className="content-card quick-card"><span className="eyebrow">A SMALL NUDGE</span><div className="quick-spark">✳</div><h2>Make a little time<br />for a big idea.</h2><p>Choose a topic and your available time. We’ll help you break it into doable steps.</p><Link className="button button-outline" to="/app/planner">Make a study plan <span>→</span></Link><div className="quick-deco">✦</div></section>
    </div>
  </div>;
}

function ChatPage() {
  const { chatId: routeChatId } = useParams();
  const { refreshChats } = useContextOutlet();
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chatId, setChatId] = useState(routeChatId || null);
  const [usedNotes, setUsedNotes] = useState([]);
  const [demo, setDemo] = useState(false);
  const bottomRef = useRef(null);
  const navigate = useNavigate();
  useEffect(() => {
    setChatId(routeChatId || null);
    setMessages([]);
    setError('');
    setUsedNotes([]);
    if (routeChatId) api(`/api/chats/${routeChatId}`).then(chat => setMessages(chat.messages)).catch(err => setError(err.message));
  }, [routeChatId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send(text = question) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setQuestion('');
    setError('');
    setUsedNotes([]);
    setDemo(false);
    setBusy(true);
    const assistantId = `pending-${Date.now()}`;
    setMessages(previous => [...previous, { role: 'user', content: prompt }, { id: assistantId, role: 'assistant', content: '', notes: [] }]);
    try {
      const token = localStorage.getItem(tokenKey);
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body: JSON.stringify({ question: prompt, chatId })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let doneEvent = null;
      const handleEvent = raw => {
        const eventName = raw.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const dataLine = raw.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) return;
        const payload = JSON.parse(dataLine.slice(5).trim());
        if (eventName === 'done') {
          doneEvent = payload;
          setUsedNotes(payload.notes || []);
          setDemo(Boolean(payload.demo));
          if (payload.chatId) {
            setChatId(payload.chatId);
            if (!routeChatId) navigate(`/app/chat/${payload.chatId}`, { replace: true });
          }
          refreshChats();
        } else if (eventName === 'error') {
          throw new Error(payload.error || 'The response failed.');
        } else if (payload.text) {
          setMessages(previous => previous.map(message => message.id === assistantId
            ? { ...message, content: message.content + payload.text } : message));
        }
      };
      while (true) {
        const { value, done: streamEnded } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !streamEnded });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        events.forEach(handleEvent);
        if (streamEnded) break;
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!doneEvent) throw new Error('The response ended before completion.');
    } catch (err) {
      setError(err.message);
      setMessages(previous => previous.filter(message => message.id !== assistantId));
    } finally { setBusy(false); }
  }

  return <div className="page-content chat-page">
    <PageHeader eyebrow="LET'S FIGURE IT OUT" title="AI study chat" description="Ask a question and work through it, one clear answer at a time." action={<Button variant="button-outline" onClick={() => navigate('/app/chat')}>＋ New chat</Button>} />
    <div className="chat-card">
      <div className="chat-toolbar"><span className="ai-online"><i /> Study Buddy is here</span><span className="chat-privacy">Your notes stay private</span></div>
      <div className="messages-area">
        {!messages.length && <div className="chat-empty"><div className="chat-empty-icon">✧</div><h2>What are you learning?</h2><p>Ask for an explanation, an example, or a little help getting unstuck.</p><div className="suggestion-row">{['Explain photosynthesis simply', 'What is a variable?', 'Help me study for 30 minutes'].map(item => <button key={item} onClick={() => send(item)}>{item} <span>↗</span></button>)}</div></div>}
        {messages.map((message, index) => <div key={message.id || `${message.role}-${index}`} className={`message-row ${message.role === 'user' ? 'message-user' : ''}`}>
          {message.role === 'assistant' && <span className="message-avatar">✦</span>}
          <div className="message-body"><span className="message-author">{message.role === 'user' ? 'You' : 'Study Buddy'}</span><div className="message-bubble">{message.content || (busy && index === messages.length - 1 ? <span className="typing-dots"><i /><i /><i /></span> : '')}</div>
            {message.role === 'assistant' && index === messages.length - 1 && usedNotes.length > 0 && <div className="source-notes">From your notes: {usedNotes.map(note => <span key={note.id}>{note.title}</span>)}</div>}
            {message.role === 'assistant' && index === messages.length - 1 && demo && <div className="demo-label">Demo response · Add an API key for live AI</div>}
          </div>
        </div>)}
        <div ref={bottomRef} />
      </div>
      {error && <div className="alert alert-error chat-error">{error}</div>}
      <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Ask your study buddy anything…" rows="2" disabled={busy} />
        <div className="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><Button disabled={busy || !question.trim()}>{busy ? 'Thinking…' : 'Send'} <span>↑</span></Button></div>
      </form>
    </div>
  </div>;
}

function useContextOutlet() {
  return useOutletContextSafe();
}

function NotesPage() {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = () => api('/api/notes').then(setNotes).catch(err => setError(err.message));
  useEffect(() => { reload(); }, []);
  async function save(event) {
    event.preventDefault();
    setError(''); setStatus(''); setBusy(true);
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ title, content }) });
      setTitle(''); setContent(''); setStatus('Your note is saved and ready to use in chat.');
      await reload();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setError('');
    try { await api(`/api/notes/${id}`, { method: 'DELETE' }); setNotes(current => current.filter(note => note.id !== id)); }
    catch (err) { setError(err.message); }
  }
  return <div className="page-content">
    <PageHeader eyebrow="YOUR KNOWLEDGE LIBRARY" title="My notes" description="Save your own study material and ask questions about it in chat." />
    {error && <div className="alert alert-error">{error}</div>}{status && <div className="alert alert-success">{status}</div>}
    <div className="notes-layout">
      <section className="content-card note-form-card"><span className="eyebrow">ADD TO YOUR LIBRARY</span><h2>Save a study note</h2><p className="muted">Your notes are private to your account. The AI can find relevant notes when you ask a question.</p>
        <form className="form-stack" onSubmit={save}><label>Note title<input required maxLength="120" value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. The water cycle" /></label><label>Note content<textarea required maxLength="8000" rows="8" value={content} onChange={event => setContent(event.target.value)} placeholder="Add the concepts, facts, or examples you want to remember…" /></label><Button disabled={busy}>{busy ? 'Saving…' : 'Save note'} <span>＋</span></Button></form>
      </section>
      <section className="notes-list-section"><div className="card-heading"><div><span className="eyebrow">YOUR COLLECTION</span><h2>{notes.length} saved {notes.length === 1 ? 'note' : 'notes'}</h2></div><Link to="/app/chat">Ask about your notes →</Link></div>
        {notes.length ? <div className="notes-grid">{notes.map(note => <article className="note-card" key={note.id}><div className="note-card-top"><span className="note-icon">▤</span><button className="icon-button" onClick={() => remove(note.id)} aria-label={`Delete ${note.title}`}>×</button></div><h3>{note.title}</h3><p>{note.content}</p><small>Saved {new Date(`${note.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</small></article>)}</div> : <div className="empty-state note-empty"><span>▤</span><b>Your note library is ready.</b><small>Add a note to make answers more personal.</small></div>}
      </section>
    </div>
  </div>;
}

function PlannerPage() {
  const [topic, setTopic] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [difficulty, setDifficulty] = useState('beginner');
  const [plan, setPlan] = useState(null);
  const [checked, setChecked] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function generate(event) {
    event.preventDefault(); setBusy(true); setError(''); setPlan(null); setChecked({});
    try { setPlan(await api('/api/study-plan', { method: 'POST', body: JSON.stringify({ topic, minutes: Number(minutes), difficulty }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="page-content">
    <PageHeader eyebrow="A PLAN THAT FITS YOUR DAY" title="Study planner" description="Choose a topic and the time you have. We’ll break it into smaller steps." />
    <div className="planner-layout">
      <section className="content-card planner-form-card"><div className="planner-art">◷</div><span className="eyebrow">START WITH WHAT YOU HAVE</span><h2>A focused session<br />starts here.</h2><form className="form-stack" onSubmit={generate}><label>What do you want to study?<input required maxLength="160" value={topic} onChange={event => setTopic(event.target.value)} placeholder="e.g. Intro to cell biology" /></label><label>Available time<select value={minutes} onChange={event => setMinutes(event.target.value)}><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></label><label>Difficulty<select value={difficulty} onChange={event => setDifficulty(event.target.value)}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></label><Button disabled={busy}>{busy ? 'Making your plan…' : 'Create my plan'} <span>→</span></Button></form>{error && <div className="alert alert-error">{error}</div>}</section>
      <section className="content-card plan-result">{plan ? <><div className="plan-title-row"><div><span className="eyebrow">{plan.demo ? 'DEMO STUDY PLAN' : 'YOUR STUDY SESSION'}</span><h2>{plan.topic}</h2></div><span className="plan-total">{plan.tasks.reduce((sum, task) => sum + task.minutes, 0)} min</span></div>{plan.demo && <div className="alert alert-info">Demo plan · Add OPENAI_API_KEY to generate live AI plans.</div>}<div className="plan-tasks">{plan.tasks.map((task, index) => <label className={`plan-task ${checked[index] ? 'task-done' : ''}`} key={`${task.name}-${index}`}><input type="checkbox" checked={Boolean(checked[index])} onChange={() => setChecked(current => ({ ...current, [index]: !current[index] }))} /><span className="task-index">{String(index + 1).padStart(2, '0')}</span><span className="task-details"><b>{task.name}</b><small>{task.description}</small></span><span className="task-minutes">{task.minutes} min</span></label>)}</div><div className="plan-progress">{Object.values(checked).filter(Boolean).length} of {plan.tasks.length} steps complete</div></> : <div className="planner-placeholder"><div className="placeholder-sun">✦</div><h2>Your plan will<br />show up here.</h2><p>Every big topic becomes easier when you take it one step at a time.</p><div className="placeholder-lines"><span /><span /><span /></div></div>}</section>
    </div>
  </div>;
}

function ProfilePage() {
  const { user, signOut } = useAuth();
  const [usage, setUsage] = useState(null);
  useEffect(() => { api('/api/usage').then(setUsage).catch(() => {}); }, []);
  return <div className="page-content"><PageHeader eyebrow="YOUR ACCOUNT" title="Profile" description="A quick look at your account and study activity." />
    <section className="content-card profile-card"><div className="profile-avatar">{user.email[0].toUpperCase()}</div><div className="profile-details"><span className="eyebrow">ACCOUNT DETAILS</span><h2>{user.email}</h2><p><span className="role-pill">{user.role}</span> &nbsp; Member since your account was created</p></div><Button variant="button-outline" onClick={signOut}>Log out</Button></section>
    <section className="content-card profile-usage"><span className="eyebrow">YOUR AI USAGE</span><h2>Activity at a glance</h2><div className="usage-row"><span>AI requests</span><b>{usage?.requests ?? '—'}</b></div><div className="usage-row"><span>Input tokens</span><b>{usage?.input_tokens?.toLocaleString() ?? '—'}</b></div><div className="usage-row"><span>Output tokens</span><b>{usage?.output_tokens?.toLocaleString() ?? '—'}</b></div><p className="muted">Estimated cost: ${usage?.estimated_cost_usd?.toFixed(4) ?? '0.0000'} · Estimates are not exact charges.</p></section>
  </div>;
}

function AdminPage() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [usage, setUsage] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api('/api/admin/stats'), api('/api/admin/users'), api('/api/admin/usage')])
      .then(([nextStats, nextUsers, nextUsage]) => { setStats(nextStats); setUsers(nextUsers); setUsage(nextUsage); })
      .catch(err => setError(err.message));
  }, []);
  return <div className="page-content">
    <PageHeader eyebrow="ADMINISTRATION" title="Admin dashboard" description="Account totals and recorded AI usage across the app." />
    {error && <div className="alert alert-error">{error}</div>}
    <div className="stat-grid admin-stats"><article className="stat-card"><span>Total users</span><b>{stats?.totalUsers ?? '—'}</b></article><article className="stat-card"><span>AI requests</span><b>{stats?.requests ?? '—'}</b></article><article className="stat-card"><span>Total tokens</span><b>{stats?.total_tokens?.toLocaleString() ?? '—'}</b></article><article className="stat-card"><span>Estimated cost</span><b>${stats?.estimated_cost_usd?.toFixed(4) ?? '—'}</b></article></div>
    <section className="content-card table-card"><div className="card-heading"><div><span className="eyebrow">ACCOUNTS</span><h2>Users</h2></div></div><div className="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th>AI requests</th><th>Joined</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td>{user.email}</td><td><span className="role-pill">{user.role}</span></td><td>{user.ai_requests}</td><td>{new Date(`${user.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</td></tr>)}</tbody></table>{!users.length && !error && <p className="muted table-empty">No users to display yet.</p>}</div></section>
    <section className="content-card table-card"><div className="card-heading"><div><span className="eyebrow">LATEST ACTIVITY</span><h2>AI usage records</h2></div></div><div className="table-scroll"><table><thead><tr><th>User</th><th>Model</th><th>Tokens in / out</th><th>Estimated cost</th></tr></thead><tbody>{usage.map((record, index) => <tr key={`${record.email}-${record.created_at}-${index}`}><td>{record.email}</td><td>{record.model}</td><td>{record.input_tokens} / {record.output_tokens}</td><td>${record.estimated_cost_usd.toFixed(5)}</td></tr>)}</tbody></table>{!usage.length && !error && <p className="muted table-empty">No live AI requests have been recorded.</p>}</div></section>
  </div>;
}

function FullLoading() {
  return <div className="full-loading"><span className="brand-mark">✦</span><p>Getting your study space ready…</p></div>;
}

import { useOutletContext as useOutletContextSafe } from 'react-router-dom';

function App() {
  return <AuthProvider><Routes>
    <Route path="/" element={<Landing />} />
    <Route path="/login" element={<AuthPage mode="login" />} />
    <Route path="/register" element={<AuthPage mode="register" />} />
    <Route element={<Protected />}>
      <Route path="/app" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:chatId" element={<ChatPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="planner" element={<PlannerPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
    </Route>
    <Route element={<Protected admin />}>
      <Route path="/admin" element={<AppLayout />}><Route index element={<AdminPage />} /></Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider>;
}

export default App;
