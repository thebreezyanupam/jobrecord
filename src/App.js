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

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const fmt = (dateStr) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
};

const EMPTY_FORM = {
  company: '', role: '', location: '', jobUrl: '', appliedDate: '',
  status: 'applied', chanceBase: '', chanceCustomized: '',
  platform: '', notes: '', resumeVersion: '', coverLetter: false,
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
  const [form, setForm] = useState(EMPTY_FORM);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [formMode, setFormMode] = useState('form');
  const [commandText, setCommandText] = useState('');
  const [commandError, setCommandError] = useState('');
  const [commandBusy, setCommandBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');

  const resolveStatus = (status) => (STATUS_CONFIG[status] ? status : 'applied');

  const resetFormPanel = () => {
    setForm(EMPTY_FORM);
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
    setForm(EMPTY_FORM);
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

  const stats = {
    total: jobs.length,
    applied: jobs.filter(j => j.status === 'applied').length,
    interview: jobs.filter(j => j.status === 'interview').length,
    offer: jobs.filter(j => j.status === 'offer').length,
    rejected: jobs.filter(j => j.status === 'rejected').length,
    ghosted: jobs.filter(j => j.status === 'ghosted').length,
    responseRate: jobs.length ? Math.round(((jobs.filter(j => ['interview','offer'].includes(j.status)).length) / jobs.length) * 100) : 0,
  };

  const s = {
    app: { minHeight: '100vh', background: '#0a0a0a', color: '#e8e6e0', fontFamily: "'DM Sans', sans-serif", padding: '0 0 80px' },
    header: { borderBottom: '1px solid #1e1e1e', padding: '24px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#0a0a0a', zIndex: 10 },
    headerLeft: { display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' },
    title: { fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 500, color: '#e8e6e0', margin: 0 },
    subtitle: { fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#444', margin: 0 },
    addBtn: { background: '#378ADD', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' },
    main: { maxWidth: 960, margin: '0 auto', padding: '32px 24px', width: '100%' },
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
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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

      <main style={s.main} className="app-main">

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
              <Field label="Applied Date" id="appliedDate" type="date" />
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

        {loading ? (
          <div style={s.loadingWrap}>
            <div style={s.spinner} />
            <p style={s.loadingText}>Loading…</p>
          </div>
        ) : (
          <>
        {/* ── Summary panel ── */}
        {(() => {
          const statusItems = [
            { key: 'applied',   label: 'Applied',   color: '#378ADD', value: stats.applied },
            { key: 'interview', label: 'Interview', color: '#EF9F27', value: stats.interview },
            { key: 'offer',     label: 'Offer',     color: '#1D9E75', value: stats.offer },
            { key: 'rejected',  label: 'Rejected',  color: '#E24B4A', value: stats.rejected },
            { key: 'ghosted',   label: 'Ghosted',   color: '#888780', value: stats.ghosted },
            { key: 'saved',     label: 'Saved',     color: '#7F77DD', value: jobs.filter(j => j.status === 'saved').length },
          ];
          const segments = statusItems.filter(i => i.value > 0);
          const rateColor = stats.responseRate > 20 ? '#1D9E75' : stats.responseRate > 10 ? '#EF9F27' : '#E24B4A';
          return (
            <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
              {/* hero row */}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 4 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 600, color: '#e8e6e0' }}>
                  {stats.total}
                  <span style={{ fontSize: 13, fontWeight: 400, color: '#444', marginLeft: 8 }}>applications</span>
                </span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: rateColor }}>
                  {stats.responseRate}%
                  <span style={{ fontSize: 11, color: '#444', marginLeft: 5 }}>response rate</span>
                </span>
              </div>

              {/* stacked bar */}
              <div style={{ height: 5, borderRadius: 99, background: '#1a1a1a', overflow: 'hidden', display: 'flex', marginBottom: 14 }}>
                {stats.total === 0
                  ? <div style={{ flex: 1, background: '#1a1a1a' }} />
                  : segments.map(seg => (
                    <div key={seg.key}
                      style={{ width: `${(seg.value / stats.total) * 100}%`, background: seg.color, transition: 'width 0.4s ease' }}
                    />
                  ))
                }
              </div>

              {/* per-status panels */}
              <div className="status-panels">
                {statusItems.map(item => {
                  const active = filter === item.key;
                  return (
                    <div key={item.key}
                      className="status-panel-btn"
                      style={{
                        borderColor: '#1e1e1e',
                        background: '#0d0d0d',
                      }}
                    >
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 600, color: item.value === 0 ? '#2a2a2a' : item.color, lineHeight: 1, display: 'block', marginBottom: 3 }}>
                        {item.value}
                      </span>
                      <span style={{ fontSize: 10, color: item.value === 0 ? '#2a2a2a' : '#555', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' }}>
                        {item.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── Filter chips ── */}
        <div className="filters-scroll" style={{ marginBottom: 16 }}>
          {['all', ...Object.keys(STATUS_CONFIG)].map(f => {
            const active = filter === f;
            const color = f !== 'all' ? STATUS_CONFIG[f].color : null;
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
              </button>
            );
          })}
        </div>

        {filtered.length === 0 ? (
          <div style={s.empty}>
            <p style={s.emptyTitle}>No applications yet</p>
            <p style={s.emptyText}>Add one to get started</p>
          </div>
        ) : filtered.map(job => {
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
          </>
        )}
      </main>

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
