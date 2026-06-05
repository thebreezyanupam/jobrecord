import { useState, useEffect } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { getAuth, getDb, initFirebase, isFirebaseConfigured } from './firebase';
import Auth from './Auth';
import {
  isGuestSession,
  startGuestSession,
  endGuestSession,
  loadGuestJobs,
  saveGuestJobs,
  normalizeGuestJobs,
} from './guestStorage';
import { parseJobsFromJson } from './parseJobJson';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const safeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9]/.test(trimmed)) return `https://${trimmed}`;
  return null;
};

const STATUS_CONFIG = {
  applied:    { label: 'Applied',     color: '#378ADD', bg: 'rgba(55,138,221,0.12)', dot: '#378ADD' },
  interview:  { label: 'Interview',   color: '#EF9F27', bg: 'rgba(239,159,39,0.12)',  dot: '#EF9F27' },
  rejected:   { label: 'Rejected',    color: '#E24B4A', bg: 'rgba(226,75,74,0.12)',   dot: '#E24B4A' },
  offer:      { label: 'Offer',       color: '#1D9E75', bg: 'rgba(29,158,117,0.12)',  dot: '#1D9E75' },
  ghosted:    { label: 'Ghosted',     color: '#888780', bg: 'rgba(136,135,128,0.12)', dot: '#888780' },
  saved:      { label: 'Saved',       color: '#7F77DD', bg: 'rgba(127,119,221,0.12)', dot: '#7F77DD' },
};

const CHANCE_COLOR = (n) => {
  if (n >= 60) return '#1D9E75';
  if (n >= 40) return '#EF9F27';
  return '#E24B4A';
};

const parseLocalDate = (dateStr) => {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

const daysSince = (dateStr) => {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return Math.floor((todayStart - d) / (1000 * 60 * 60 * 24));
};

const fmt = (dateStr) => {
  const d = parseLocalDate(dateStr);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const emptyForm = () => ({
  company: '', role: '', location: '', jobUrl: '', appliedDate: todayLocal(),
  status: 'applied', chanceBase: '', chanceCustomized: '',
  platform: '', notes: '', resumeVersion: '', coverLetter: false,
});

const computeStreak = (jobs) => {
  const dates = new Set(
    jobs.filter(j => j.appliedDate).map(j => j.appliedDate.slice(0, 10))
  );
  let streak = 0;
  const d = new Date();
  while (true) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (dates.has(ds)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
};

const getActivityData = (jobs, range) => {
  const days = range === 'weekly' ? 7 : 30;
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = i === 0 ? 'Today' : i === 1 ? 'Yest' : `${d.getMonth() + 1}/${d.getDate()}`;
    result.push({ date: ds, count: jobs.filter(j => j.appliedDate && j.appliedDate.slice(0, 10) === ds).length, label });
  }
  return result;
};

function LoadingScreen({ message }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#0a0a0a', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        width: 32, height: 32, border: '2px solid #1e1e1e', borderTopColor: '#378ADD',
        borderRadius: '50%', animation: 'spin 0.8s linear infinite',
      }} />
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#444', margin: 0 }}>
        {message}
      </p>
    </div>
  );
}

function JobTracker({ isGuest, user, onLeave }) {
  const [jobs, setJobs] = useState(() => (isGuest ? normalizeGuestJobs(loadGuestJobs()) : []));
  const [loading, setLoading] = useState(!isGuest);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [dateLockedToToday, setDateLockedToToday] = useState(true);
  const [chartRange, setChartRange] = useState('weekly');
  const [chartType, setChartType] = useState('bar');
  const [expandedDates, setExpandedDates] = useState(new Set());

  const toggleDateCollapse = (key) => setExpandedDates(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [formMode, setFormMode] = useState('form');
  const [commandText, setCommandText] = useState('');
  const [commandError, setCommandError] = useState('');
  const [commandBusy, setCommandBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');

  const resolveStatus = (status) => (STATUS_CONFIG[status] ? status : 'applied');

  const resetFormPanel = () => {
    setForm(emptyForm());
    setDateLockedToToday(true);
    setEditId(null);
    setFormMode('form');
    setCommandText('');
    setCommandError('');
  };

  useEffect(() => {
    if (!importNotice) return undefined;
    const t = setTimeout(() => setImportNotice(''), 4000);
    return () => clearTimeout(t);
  }, [importNotice]);

  useEffect(() => {
    if (isGuest) return;
    setLoading(true);
    const q = query(
      collection(getDb(), 'jobs'),
      where('userId', '==', user.uid),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));
      setJobs(docs.sort((a, b) => b.id - a.id));
      setLoading(false);
    }, (err) => {
      console.error('Firestore snapshot error:', err);
      setLoading(false);
    });
    return unsubscribe;
  }, [isGuest, user.uid]);

  useEffect(() => {
    if (!isGuest) return;
    saveGuestJobs(jobs.map(({ docId, userId, ...rest }) => rest));
  }, [jobs, isGuest]);

  const sortJobs = (list) => [...list].sort((a, b) => b.id - a.id);

  const addJobsBatch = async (items) => {
    if (isGuest) {
      const usedIds = new Set(jobs.map((j) => j.id));
      let next = [...jobs];
      items.forEach((item, i) => {
        let id = Number(item.id);
        if (!Number.isFinite(id)) id = Date.now() + i;
        while (usedIds.has(id)) id += 1;
        usedIds.add(id);
        const { id: _id, ...fields } = item;
        next = [{ ...fields, id, docId: String(id) }, ...next];
      });
      setJobs(sortJobs(next));
      return items.length;
    }

    if (!isFirebaseConfigured()) {
      throw new Error('Cloud sync is not configured.');
    }
    initFirebase();

    await Promise.all(
      items.map((item, i) => {
        let id = Number(item.id);
        if (!Number.isFinite(id)) id = Date.now() + i;
        const { id: _id, ...fields } = item;
        return addDoc(collection(getDb(), 'jobs'), { ...fields, id, userId: user.uid });
      }),
    );
    return items.length;
  };

  const importFromCommand = async () => {
    setCommandError('');
    setCommandBusy(true);
    try {
      const items = parseJobsFromJson(commandText, new Set(Object.keys(STATUS_CONFIG)));
      const count = await addJobsBatch(items);
      setCommandText('');
      setShowForm(false);
      resetFormPanel();
      setImportNotice(count === 1 ? 'Imported 1 application.' : `Imported ${count} applications.`);
    } catch (err) {
      const msg = err?.code ? `${err.code}: ${err.message}` : err?.message;
      setCommandError(msg || 'Import failed.');
    } finally {
      setCommandBusy(false);
    }
  };

  const save = async () => {
    if (!form.company || !form.role) return;
    if (isGuest) {
      if (editId) {
        setJobs(sortJobs(jobs.map((j) => (
          j.docId === editId ? { ...form, id: form.id, docId: editId } : j
        ))));
        setEditId(null);
      } else {
        const id = Date.now();
        const docId = String(id);
        setJobs(sortJobs([{ ...form, id, docId }, ...jobs]));
      }
    } else if (editId) {
      await updateDoc(doc(getDb(), 'jobs', editId), { ...form, id: form.id, userId: user.uid });
      setEditId(null);
    } else {
      await addDoc(collection(getDb(), 'jobs'), { ...form, id: Date.now(), userId: user.uid });
    }
    setForm(emptyForm());
    setDateLockedToToday(true);
    setShowForm(false);
  };

  const del = (docId) => {
    if (isGuest) {
      setJobs(jobs.filter((j) => j.docId !== docId));
    } else {
      deleteDoc(doc(getDb(), 'jobs', docId));
    }
  };

  const edit = (job) => {
    const { docId, userId, ...rest } = job;
    setForm(rest);
    setDateLockedToToday(false);
    setEditId(docId);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const updateStatus = async (docId, newStatus) => {
    if (isGuest) {
      setJobs(jobs.map((j) => (j.docId === docId ? { ...j, status: newStatus } : j)));
      if (filter !== 'all' && filter !== newStatus) setFilter('all');
      return;
    }
    initFirebase();
    try {
      await updateDoc(doc(getDb(), 'jobs', docId), { status: newStatus });
      if (filter !== 'all' && filter !== newStatus) setFilter('all');
    } catch (err) {
      setImportNotice(err?.message || 'Could not update status.');
    }
  };

  const handleLeave = () => {
    if (isGuest) {
      endGuestSession();
      onLeave();
    } else {
      signOut(getAuth());
    }
  };

  const filtered = filter === 'all' ? jobs : jobs.filter(j => j.status === filter);

  const today = todayLocal();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const stats = {
    total: jobs.length,
    applied: jobs.filter(j => j.status === 'applied').length,
    interview: jobs.filter(j => j.status === 'interview').length,
    offer: jobs.filter(j => j.status === 'offer').length,
    rejected: jobs.filter(j => j.status === 'rejected').length,
    ghosted: jobs.filter(j => j.status === 'ghosted').length,
    responseRate: jobs.length ? Math.round(((jobs.filter(j => ['interview','offer'].includes(j.status)).length) / jobs.length) * 100) : 0,
    todayCount: jobs.filter(j => j.appliedDate && j.appliedDate.slice(0, 10) === today).length,
    yesterdayCount: jobs.filter(j => j.appliedDate && j.appliedDate.slice(0, 10) === yesterday).length,
    streak: computeStreak(jobs),
  };

  const s = {
    app: { height: '100vh', overflow: 'hidden', background: '#0a0a0a', color: '#e8e6e0', fontFamily: "'DM Sans', sans-serif", display: 'flex', flexDirection: 'column' },
    header: { borderBottom: '1px solid #1e1e1e', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: '#0a0a0a', zIndex: 10 },
    headerLeft: { display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' },
    title: { fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 500, color: '#e8e6e0', margin: 0 },
    subtitle: { fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#444', margin: 0 },
    addBtn: { background: '#378ADD', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' },
    main: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 960, margin: '0 auto', padding: '0 24px' },
    mainOuter: { flex: 1, overflow: 'hidden', display: 'flex', justifyContent: 'center' },
    staticArea: { flexShrink: 0, paddingTop: 14 },
    jobScroll: { flex: 1, overflowY: 'auto', paddingBottom: 40 },
    jobCard: { background: '#111', border: '1px solid #1e1e1e', borderRadius: 10, marginBottom: 10 },
    jobTop: { padding: '16px 20px', cursor: 'pointer' },
    jobMain: { flex: 1, minWidth: 0 },
    jobTitle: { fontSize: 15, fontWeight: 500, color: '#e8e6e0', margin: '0 0 3px', overflow: 'hidden', textOverflow: 'ellipsis' },
    jobCompany: { fontSize: 13, color: '#888', margin: '0 0 10px', wordBreak: 'break-word' },
    jobBadges: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
    statusBadge: (status) => ({ background: STATUS_CONFIG[status].bg, color: STATUS_CONFIG[status].color, border: `1px solid ${STATUS_CONFIG[status].color}33`, borderRadius: 99, padding: '3px 10px', fontSize: 11, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }),
    dot: (status) => ({ width: 6, height: 6, borderRadius: '50%', background: STATUS_CONFIG[status].dot, display: 'inline-block' }),
    badge: { background: '#1a1a1a', color: '#666', border: '1px solid #222', borderRadius: 99, padding: '2px 8px', fontSize: 11 },
    chanceBadge: (n) => ({ background: '#0f0f0f', color: CHANCE_COLOR(n), border: `1px solid ${CHANCE_COLOR(n)}44`, borderRadius: 99, padding: '2px 8px', fontSize: 11, fontFamily: "'DM Mono', monospace" }),
    daysTag: (d) => ({ fontSize: 11, color: d > 14 ? '#E24B4A' : d > 7 ? '#EF9F27' : '#555', fontFamily: "'DM Mono', monospace" }),
    expanded: { borderTop: '1px solid #1a1a1a', padding: '16px 20px', background: '#0d0d0d' },
    expandRow: { display: 'flex', flexDirection: 'column', gap: 2 },
    expandLabel: { fontSize: 10, color: '#444', textTransform: 'uppercase', letterSpacing: '0.06em' },
    expandVal: { fontSize: 13, color: '#aaa', wordBreak: 'break-word' },
    notes: { background: '#111', border: '1px solid #1e1e1e', borderRadius: 6, padding: '10px 12px', fontSize: 13, color: '#888', fontFamily: "'DM Mono', monospace", lineHeight: 1.6, marginBottom: 16, wordBreak: 'break-word' },
    actionRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
    actionBtn: (color) => ({ background: 'transparent', color: color || '#555', border: `1px solid ${color ? color + '33' : '#222'}`, borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }),
    statusSelect: { background: '#1a1a1a', color: '#aaa', border: '1px solid #222', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", maxWidth: '100%' },
    formOverlay: { background: '#0a0a0a', border: '1px solid #1e1e1e', borderRadius: 12, padding: 28, marginBottom: 28 },
    formTitle: { fontFamily: "'DM Mono', monospace", fontSize: 14, color: '#e8e6e0', margin: '0 0 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    formGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
    formLabel: { fontSize: 11, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em' },
    formInput: { background: '#111', border: '1px solid #222', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e6e0', fontFamily: "'DM Sans', sans-serif", outline: 'none', width: '100%', boxSizing: 'border-box' },
    formTextarea: { background: '#111', border: '1px solid #222', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e6e0', fontFamily: "'DM Mono', monospace", outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 80 },
    cancelBtn: { background: 'transparent', color: '#555', border: '1px solid #222', borderRadius: 6, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    saveBtn: { background: '#378ADD', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    empty: { textAlign: 'center', padding: '60px 20px', color: '#333' },
    emptyTitle: { fontFamily: "'DM Mono', monospace", fontSize: 16, color: '#444', margin: '0 0 8px' },
    emptyText: { fontSize: 13, color: '#333', margin: 0 },
    loadingWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 16 },
    spinner: { width: 32, height: 32, border: '2px solid #1e1e1e', borderTopColor: '#378ADD', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
    loadingText: { fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#444', margin: 0 },
    formTab: (active) => ({
      background: active ? '#1e1e1e' : 'transparent',
      color: active ? '#e8e6e0' : '#555',
      border: `1px solid ${active ? '#333' : '#1e1e1e'}`,
      borderRadius: 6,
      padding: '6px 12px',
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif",
    }),
  };

  const formTabBtn = (active) => s.formTab(active);

  const Field = ({ label, id, full, type = 'text', as }) => (
    <div style={full ? { ...s.formGroup, gridColumn: '1 / -1' } : s.formGroup}>
      <label style={s.formLabel}>{label}</label>
      {as === 'textarea'
        ? <textarea id={id} style={s.formTextarea} value={form[id]} onChange={e => setForm({ ...form, [id]: e.target.value })} />
        : as === 'select'
          ? <select style={s.formInput} value={form[id]} onChange={e => setForm({ ...form, [id]: e.target.value })}>
              {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          : as === 'checkbox'
            ? <input type="checkbox" checked={form[id]} onChange={e => setForm({ ...form, [id]: e.target.checked })} style={{ width: 16, height: 16 }} />
            : <input type={type} style={s.formInput} value={form[id]} onChange={e => setForm({ ...form, [id]: e.target.value })} placeholder={id === 'chanceBase' || id === 'chanceCustomized' ? 'e.g. 60' : ''} />
      }
    </div>
  );

  return (
    <div style={s.app}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 99px; }
        ::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }
        * { scrollbar-width: thin; scrollbar-color: #2a2a2a transparent; }
      `}</style>
      <header style={s.header} className="app-header">
        <div style={s.headerLeft} className="header-left">
          <p style={s.title}>Job Tracker</p>
          <p style={s.subtitle} className="app-subtitle">Applications</p>
        </div>
        <div className="header-actions">
          {isGuest ? (
            <span className="user-guest-label" title="Saved on this device only">Guest</span>
          ) : (
            <span className="user-email" title={user.email}>{user.email}</span>
          )}
          <button type="button" className="logout-btn" onClick={handleLeave}>
            {isGuest ? 'Exit' : 'Log out'}
          </button>
          <button
            type="button"
            style={s.addBtn}
            className="add-btn-full"
            onClick={() => {
              if (showForm) {
                setShowForm(false);
                resetFormPanel();
              } else {
                resetFormPanel();
                setShowForm(true);
              }
            }}
          >
            {showForm ? 'Close' : 'Add application'}
          </button>
        </div>
      </header>

      <div style={s.mainOuter}>
      <main style={s.main} className="app-main">

        <div style={s.staticArea}>
        {importNotice && (
          <p className="import-notice">{importNotice}</p>
        )}

        {showForm && (
          <div style={s.formOverlay} className="form-overlay-responsive">
            <p style={s.formTitle}>
              <span>{editId ? 'Edit application' : 'New application'}</span>
            </p>

            {!editId && (
              <div className="form-mode-tabs">
                <button type="button" style={formTabBtn(formMode === 'form')} onClick={() => { setFormMode('form'); setCommandError(''); }}>
                  Form
                </button>
                <button type="button" style={formTabBtn(formMode === 'command')} onClick={() => { setFormMode('command'); setCommandError(''); }}>
                  Import JSON
                </button>
              </div>
            )}

            {formMode === 'command' && !editId ? (
              <>
                <p style={{ ...s.formLabel, marginBottom: 8, textTransform: 'none', letterSpacing: 0, fontSize: 12, color: '#666' }}>
                  Paste one job object or a JSON array, then import.
                </p>
                <textarea
                  className="command-panel-input"
                  value={commandText}
                  onChange={(e) => { setCommandText(e.target.value); setCommandError(''); }}
                  placeholder={'{\n  "company": "Acme Inc.",\n  "role": "Developer",\n  "status": "applied"\n}'}
                  spellCheck={false}
                  aria-label="Job JSON"
                />
                {commandError && <p className="command-panel-error">{commandError}</p>}
                <div className="form-actions-responsive">
                  <button type="button" style={s.cancelBtn} onClick={() => { setShowForm(false); resetFormPanel(); }}>Cancel</button>
                  <button
                    type="button"
                    style={{ ...s.saveBtn, opacity: commandBusy ? 0.7 : 1, cursor: commandBusy ? 'wait' : 'pointer' }}
                    onClick={importFromCommand}
                    disabled={commandBusy || !commandText.trim()}
                  >
                    {commandBusy ? 'Importing…' : 'Import'}
                  </button>
                </div>
              </>
            ) : (
              <>
            <div className="form-grid-responsive">
              <Field label="Company *" id="company" />
              <Field label="Role *" id="role" />
              <Field label="Location" id="location" />
              <Field label="Platform (Indeed / LinkedIn / etc)" id="platform" />
              <Field label="Job URL" id="jobUrl" full />
              {!editId ? (
                <div style={s.formGroup}>
                  <label style={s.formLabel}>Applied Date</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={dateLockedToToday}
                      onChange={e => {
                        setDateLockedToToday(e.target.checked);
                        if (e.target.checked) setForm(f => ({ ...f, appliedDate: todayLocal() }));
                      }}
                      style={{ width: 14, height: 14, accentColor: '#378ADD' }}
                    />
                    <span style={{ fontSize: 12, color: '#666' }}>Applied today</span>
                  </label>
                  {!dateLockedToToday && (
                    <input type="date" style={s.formInput} value={form.appliedDate} onChange={e => setForm({ ...form, appliedDate: e.target.value })} />
                  )}
                </div>
              ) : (
                <Field label="Applied Date" id="appliedDate" type="date" />
              )}
              <Field label="Status" id="status" as="select" />
              <Field label="Resume Version" id="resumeVersion" />
              <Field label="Chance — base %" id="chanceBase" />
              <Field label="Chance — customized %" id="chanceCustomized" />
              <div style={s.formGroup}>
                <label style={s.formLabel}>Cover letter sent?</label>
                <input type="checkbox" checked={form.coverLetter} onChange={e => setForm({ ...form, coverLetter: e.target.checked })} style={{ width: 16, height: 16, marginTop: 4 }} />
              </div>
              <Field label="Notes" id="notes" as="textarea" full />
            </div>
            <div className="form-actions-responsive">
              <button type="button" style={s.cancelBtn} onClick={() => { setShowForm(false); resetFormPanel(); }}>Cancel</button>
              <button type="button" style={s.saveBtn} onClick={save}>Save</button>
            </div>
              </>
            )}
          </div>
        )}

        </div>{/* end staticArea */}

        {loading ? (
          <div style={s.loadingWrap}>
            <div style={s.spinner} />
            <p style={s.loadingText}>Loading…</p>
          </div>
        ) : (
          <>
        <div style={s.staticArea}>
        {/* ── Activity & Streak ── */}
        {(() => {
          const activityData = getActivityData(jobs, chartRange);
          const maxCount = Math.max(...activityData.map(d => d.count), 1);
          const rateColor = stats.responseRate > 20 ? '#1D9E75' : stats.responseRate > 10 ? '#EF9F27' : '#E24B4A';
          return (
            <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
              {/* top row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* total */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: '#e8e6e0' }}>{stats.total}</span>
                    <span style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>total</span>
                  </div>
                  {/* response rate */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: rateColor }}>{stats.responseRate}%</span>
                    <span style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>response</span>
                  </div>
                  {/* streak */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: stats.streak > 0 ? '#EF9F27' : '#333' }}>
                      {stats.streak > 0 ? `🔥 ${stats.streak}` : '—'}
                    </span>
                    <span style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>streak</span>
                  </div>
                  {/* today */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: stats.todayCount > 0 ? '#378ADD' : '#2a2a2a' }}>{stats.todayCount}</span>
                    <span style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>today</span>
                  </div>
                  {/* yesterday */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: stats.yesterdayCount > 0 ? '#7F77DD' : '#2a2a2a' }}>{stats.yesterdayCount}</span>
                    <span style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>yesterday</span>
                  </div>
                </div>
                {/* controls: type + range as matching pill groups */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', background: '#0d0d0d', border: '1px solid #1e1e1e', borderRadius: 7, padding: 2, gap: 2 }}>
                    {[['bar', 'Bar'], ['curve', 'Curve']].map(([t, label]) => (
                      <button key={t} type="button" onClick={() => setChartType(t)} style={{
                        background: chartType === t ? '#1e1e1e' : 'transparent',
                        color: chartType === t ? '#e8e6e0' : '#444',
                        border: 'none', borderRadius: 5, padding: '3px 10px',
                        fontSize: 11, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                        transition: 'background 0.15s, color 0.15s',
                      }}>{label}</button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', background: '#0d0d0d', border: '1px solid #1e1e1e', borderRadius: 7, padding: 2, gap: 2 }}>
                    {[['weekly', '7 days'], ['monthly', '30 days']].map(([r, label]) => (
                      <button key={r} type="button" onClick={() => setChartRange(r)} style={{
                        background: chartRange === r ? '#1e1e1e' : 'transparent',
                        color: chartRange === r ? '#e8e6e0' : '#444',
                        border: 'none', borderRadius: 5, padding: '3px 10px',
                        fontSize: 11, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                        transition: 'background 0.15s, color 0.15s',
                      }}>{label}</button>
                    ))}
                  </div>
                </div>
              </div>
              {/* chart */}
              {chartType === 'bar' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: chartRange === 'monthly' ? 2 : 4, height: 52 }}>
                    {activityData.map((d) => {
                      const isToday = d.label === 'Today';
                      const barH = d.count === 0 ? 3 : Math.max(6, Math.round((d.count / maxCount) * 52));
                      return (
                        <div key={d.date} title={`${d.date}: ${d.count}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'default' }}>
                          <div style={{ width: '100%', height: barH, background: isToday ? '#378ADD' : d.count > 0 ? '#378ADD44' : '#161616', borderRadius: 3, transition: 'height 0.3s ease' }} />
                          {chartRange === 'weekly' && (
                            <span style={{ fontSize: 9, color: isToday ? '#378ADD' : '#2e2e2e', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>{d.label}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {chartRange === 'monthly' && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <span style={{ fontSize: 9, color: '#2e2e2e', fontFamily: "'DM Mono', monospace" }}>{activityData[0]?.date?.slice(5)}</span>
                      <span style={{ fontSize: 9, color: '#378ADD', fontFamily: "'DM Mono', monospace" }}>Today</span>
                    </div>
                  )}
                </>
              ) : (() => {
                const W = 500, H = 60, padX = 6, padY = 6;
                const pts = activityData.map((d, i) => {
                  const x = padX + (i / Math.max(activityData.length - 1, 1)) * (W - padX * 2);
                  const y = H - padY - (maxCount === 0 ? 0 : (d.count / maxCount) * (H - padY * 2));
                  return [x, y];
                });
                const pathD = pts.reduce((acc, [x, y], i) => {
                  if (i === 0) return `M ${x},${y}`;
                  const [px, py] = pts[i - 1];
                  const cpx = (px + x) / 2;
                  return `${acc} C ${cpx},${py} ${cpx},${y} ${x},${y}`;
                }, '');
                const fillD = pts.length > 0
                  ? `${pathD} L ${pts[pts.length - 1][0]},${H} L ${pts[0][0]},${H} Z`
                  : '';
                const todayIdx = activityData.length - 1;
                return (
                  <div>
                    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 64, display: 'block' }} preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#378ADD" stopOpacity="0.18" />
                          <stop offset="100%" stopColor="#378ADD" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {fillD && <path d={fillD} fill="url(#cg)" />}
                      {pathD && <path d={pathD} fill="none" stroke="#378ADD" strokeWidth="1.5" strokeLinecap="round" />}
                      {pts.map(([x, y], i) => {
                        const isToday = i === todayIdx;
                        const hasPt = activityData[i].count > 0 || isToday;
                        return hasPt ? (
                          <circle key={i} cx={x} cy={y}
                            r={isToday ? 3 : 2}
                            fill={isToday ? '#378ADD' : '#378ADD88'}
                            stroke="#0a0a0a" strokeWidth={isToday ? 1.5 : 0}
                          />
                        ) : null;
                      })}
                    </svg>
                    <div style={{ display: 'flex', justifyContent: chartRange === 'weekly' ? 'space-around' : 'space-between', marginTop: 3 }}>
                      {chartRange === 'weekly'
                        ? activityData.map(d => (
                          <span key={d.date} style={{ fontSize: 9, color: d.label === 'Today' ? '#378ADD' : '#2e2e2e', fontFamily: "'DM Mono', monospace" }}>{d.label}</span>
                        ))
                        : <>
                          <span style={{ fontSize: 9, color: '#2e2e2e', fontFamily: "'DM Mono', monospace" }}>{activityData[0]?.date?.slice(5)}</span>
                          <span style={{ fontSize: 9, color: '#378ADD', fontFamily: "'DM Mono', monospace" }}>Today</span>
                        </>
                      }
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* ── Filter chips ── */}
        <div className="filters-scroll" style={{ marginBottom: 16 }}>
          {['all', ...Object.keys(STATUS_CONFIG)].map(f => {
            const active = filter === f;
            const color = f !== 'all' ? STATUS_CONFIG[f].color : null;
            const count = f === 'all' ? jobs.length : jobs.filter(j => j.status === f).length;
            return (
              <button key={f} type="button"
                style={{
                  background: active ? (color ? color + '20' : '#1e1e1e') : 'transparent',
                  color: active ? (color || '#e8e6e0') : '#444',
                  border: `1px solid ${active ? (color ? color + '55' : '#333') : '#1a1a1a'}`,
                  borderRadius: 99, padding: '4px 13px', fontSize: 12,
                  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                  display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                }}
                onClick={() => setFilter(f)}
              >
                {color && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />}
                {f === 'all' ? 'All' : STATUS_CONFIG[f].label}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, opacity: count === 0 ? 0.3 : 0.7 }}>{count}</span>
              </button>
            );
          })}
        </div>

        </div>{/* end staticArea */}
        <div style={s.jobScroll}>
        {filtered.length === 0 ? (
          <div style={s.empty}>
            <p style={s.emptyTitle}>No applications yet</p>
            <p style={s.emptyText}>Add one to get started</p>
          </div>
        ) : (() => {
          const grouped = filtered.reduce((acc, job) => {
            const key = job.appliedDate ? job.appliedDate.slice(0, 10) : 'no-date';
            if (!acc[key]) acc[key] = [];
            acc[key].push(job);
            return acc;
          }, {});
          const sortedKeys = Object.keys(grouped).sort((a, b) => {
            if (a === 'no-date') return 1;
            if (b === 'no-date') return -1;
            return b.localeCompare(a);
          });
          const todayStr = todayLocal();
          const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
          return sortedKeys.map(dateKey => {
            const label = dateKey === 'no-date' ? 'No date' : dateKey === todayStr ? 'Today' : dateKey === yesterdayStr ? 'Yesterday' : fmt(dateKey);
            const isCollapsed = !expandedDates.has(dateKey);
            const cnt = grouped[dateKey].length;
            const accentColor = dateKey === todayStr ? '#378ADD' : dateKey === yesterdayStr ? '#7F77DD' : '#444';
            return (
              <div key={dateKey}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleDateCollapse(dateKey)}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 600, color: accentColor, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: accentColor, background: accentColor + '18', border: `1px solid ${accentColor}33`, borderRadius: 99, padding: '1px 7px' }}>{cnt} app{cnt !== 1 ? 's' : ''}</span>
                  <div style={{ flex: 1, height: 1, background: '#1e1e1e' }} />
                  <span style={{ fontSize: 10, color: '#333', fontFamily: "'DM Mono', monospace" }}>{isCollapsed ? '▶ show' : '▼ hide'}</span>
                </div>
                {!isCollapsed && grouped[dateKey].map(job => {
          const days = daysSince(job.appliedDate);
          const isExpanded = expandedId === job.id;
          return (
            <div key={job.id} style={s.jobCard}>
              <div style={s.jobTop} className="job-top-responsive" onClick={() => setExpandedId(isExpanded ? null : job.id)}>
                <div style={s.jobMain}>
                  <p style={s.jobTitle}>{job.role}</p>
                  <p style={s.jobCompany}>{job.company}{job.location ? ` · ${job.location}` : ''}</p>
                  <div style={s.jobBadges}>
                    <span style={s.statusBadge(resolveStatus(job.status))}>
                      <span style={s.dot(resolveStatus(job.status))} />
                      {STATUS_CONFIG[resolveStatus(job.status)].label}
                    </span>
                    {job.appliedDate && (
                      <span style={{ ...s.badge, fontFamily: "'DM Mono', monospace", fontSize: 10, color: '#666' }}>
                        {fmt(job.appliedDate)}
                      </span>
                    )}
                    {job.platform && <span style={s.badge}>{job.platform}</span>}
                    {job.coverLetter && <span style={{ ...s.badge, color: '#7F77DD', borderColor: '#7F77DD33' }}>cover letter</span>}
                    {job.resumeVersion && <span style={{ ...s.badge, fontFamily: "'DM Mono', monospace", fontSize: 10 }}>{job.resumeVersion}</span>}
                  </div>
                </div>
                <div className="job-right-responsive">
                  {job.chanceCustomized && (
                    <span style={s.chanceBadge(parseInt(job.chanceCustomized))}>
                      {job.chanceCustomized}% custom
                    </span>
                  )}
                  {job.chanceBase && !job.chanceCustomized && (
                    <span style={s.chanceBadge(parseInt(job.chanceBase))}>
                      {job.chanceBase}% base
                    </span>
                  )}
                  {days !== null && (
                    <span style={s.daysTag(days)}>
                      {days === 0 ? 'today' : `${days}d ago`}
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: '#333' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {isExpanded && (
                <div style={s.expanded}>
                  <div className="expand-grid-responsive">
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Applied</span>
                      <span style={s.expandVal}>{fmt(job.appliedDate)}</span>
                    </div>
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Days since applied</span>
                      <span style={{ ...s.expandVal, color: days > 14 ? '#E24B4A' : '#aaa', fontFamily: "'DM Mono', monospace" }}>
                        {days !== null ? `${days} days` : '—'}
                      </span>
                    </div>
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Base chance</span>
                      <span style={{ ...s.expandVal, color: job.chanceBase ? CHANCE_COLOR(parseInt(job.chanceBase)) : '#444', fontFamily: "'DM Mono', monospace" }}>
                        {job.chanceBase ? `${job.chanceBase}%` : '—'}
                      </span>
                    </div>
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Customized chance</span>
                      <span style={{ ...s.expandVal, color: job.chanceCustomized ? CHANCE_COLOR(parseInt(job.chanceCustomized)) : '#444', fontFamily: "'DM Mono', monospace" }}>
                        {job.chanceCustomized ? `${job.chanceCustomized}%` : '—'}
                      </span>
                    </div>
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Resume version</span>
                      <span style={{ ...s.expandVal, fontFamily: "'DM Mono', monospace" }}>{job.resumeVersion || '—'}</span>
                    </div>
                    <div style={s.expandRow}>
                      <span style={s.expandLabel}>Cover letter</span>
                      <span style={{ ...s.expandVal, color: job.coverLetter ? '#1D9E75' : '#555' }}>{job.coverLetter ? 'Yes' : 'No'}</span>
                    </div>
                    {safeUrl(job.jobUrl) && (
                      <div style={{ ...s.expandRow, gridColumn: '1 / -1' }}>
                        <span style={s.expandLabel}>Job URL</span>
                        <a href={safeUrl(job.jobUrl)} target="_blank" rel="noreferrer" style={{ color: '#378ADD', fontSize: 13, textDecoration: 'none', wordBreak: 'break-all', display: 'block' }}>
                          {job.jobUrl}
                        </a>
                      </div>
                    )}
                  </div>

                  {job.notes && (
                    <div style={s.notes}>{job.notes}</div>
                  )}

                  <div
                    style={s.actionRow}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <select
                      style={s.statusSelect}
                      value={resolveStatus(job.status)}
                      onChange={(e) => {
                        e.stopPropagation();
                        const newStatus = e.target.value;
                        if (newStatus !== resolveStatus(job.status)) updateStatus(job.docId, newStatus);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                    <button type="button" style={s.actionBtn('#378ADD')} onClick={() => edit(job)}>edit</button>
                    {safeUrl(job.jobUrl) && (
                      <a href={safeUrl(job.jobUrl)} target="_blank" rel="noreferrer" style={{ ...s.actionBtn('#555'), textDecoration: 'none', display: 'inline-block' }}>
                        view posting ↗
                      </a>
                    )}
                    <button type="button" style={s.actionBtn('#E24B4A')} onClick={() => del(job.docId)}>delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
              </div>
            );
          });
        })()}
        </div>{/* end jobScroll */}
          </>
        )}
      </main>
      </div>{/* end mainOuter */}

    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [guestMode, setGuestMode] = useState(() => isGuestSession());
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setAuthLoading(false);
      return undefined;
    }
    try {
      const { auth: firebaseAuth } = initFirebase();
      return onAuthStateChanged(firebaseAuth, (u) => {
        setUser(u);
        setAuthLoading(false);
        if (u) {
          endGuestSession();
          setGuestMode(false);
        }
      });
    } catch {
      setAuthLoading(false);
      return undefined;
    }
  }, []);

  const enterGuest = () => {
    startGuestSession();
    setGuestMode(true);
  };

  const leaveGuest = () => {
    endGuestSession();
    setGuestMode(false);
  };

  if (authLoading) return <LoadingScreen message="Loading…" />;
  if (!user && !guestMode) {
    return <Auth onGuest={enterGuest} firebaseReady={isFirebaseConfigured()} />;
  }
  return (
    <JobTracker
      isGuest={guestMode}
      user={user}
      onLeave={leaveGuest}
    />
  );
}
