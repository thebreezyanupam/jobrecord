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
import ThemePicker, { loadTheme, applyTheme } from './ThemePicker';

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

// GitHub-style heatmap: trailing `weeks` columns of 7 days (Sun→Sat), ending this week.
// Build a single month as calendar weeks (rows of 7, Sun→Sat). Cells outside the month are null.
const getMonthMatrix = (jobs, year, month) => {
  const counts = {};
  jobs.forEach((j) => {
    if (j.appliedDate) {
      const k = j.appliedDate.slice(0, 10);
      counts[k] = (counts[k] || 0) + 1;
    }
  });
  const pad = (n) => String(n).padStart(2, '0');
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad(month + 1)}-${pad(d)}`;
    cells.push({ date: ds, day: d, count: counts[ds] || 0 });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
};

const HEAT_COLOR = (c) => {
  if (c <= 0) return 'var(--surface-2)';
  if (c === 1) return 'color-mix(in srgb, var(--accent) 25%, transparent)';
  if (c === 2) return 'color-mix(in srgb, var(--accent) 44%, transparent)';
  if (c === 3) return 'color-mix(in srgb, var(--accent) 66%, transparent)';
  return 'var(--accent)';
};

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function LoadingScreen({ message }) {
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        width: 32, height: 32, border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
        borderRadius: '50%', animation: 'spin 0.8s linear infinite',
      }} />
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: 'var(--t6)', margin: 0 }}>
        {message}
      </p>
    </div>
  );
}

function JobTracker({ isGuest, user, onLeave, theme, setTheme }) {
  const [jobs, setJobs] = useState(() => (isGuest ? normalizeGuestJobs(loadGuestJobs()) : []));
  const [loading, setLoading] = useState(!isGuest);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [dateLockedToToday, setDateLockedToToday] = useState(true);
  const [chartRange, setChartRange] = useState('weekly');
  const [chartType, setChartType] = useState('calendar');
  const [calDate, setCalDate] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [viewMode, setViewMode] = useState('list');
  // Date groups are expanded by default; this set tracks the ones the user collapsed.
  const [collapsedDates, setCollapsedDates] = useState(new Set());

  const toggleDateCollapse = (key) => setCollapsedDates(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const [filter, setFilter] = useState('all');
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
  }, [isGuest, user?.uid]);

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
    setFormMode('form');
    setDateLockedToToday(false);
    setEditId(docId);
    setShowForm(true);
  };


  const exportCsv = () => {
    if (!jobs.length) return;
    const headers = [
      'Company', 'Role', 'Location', 'Status', 'Applied Date', 'Platform',
      'Job URL', 'Base Chance %', 'Customized Chance %', 'Resume Version',
      'Cover Letter', 'Notes',
    ];
    const esc = (v) => {
      const str = v == null ? '' : String(v);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows = [...jobs].sort((a, b) => b.id - a.id).map((j) => [
      j.company,
      j.role,
      j.location,
      STATUS_CONFIG[resolveStatus(j.status)].label,
      j.appliedDate ? j.appliedDate.slice(0, 10) : '',
      j.platform,
      j.jobUrl,
      j.chanceBase,
      j.chanceCustomized,
      j.resumeVersion,
      j.coverLetter ? 'Yes' : 'No',
      j.notes,
    ].map(esc).join(','));
    const csv = '﻿' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-applications-${todayLocal()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setImportNotice(jobs.length === 1 ? 'Exported 1 application.' : `Exported ${jobs.length} applications.`);
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
    app: { height: '100vh', overflow: 'hidden', background: 'var(--app-bg)', color: 'var(--t1)', fontFamily: "'DM Sans', sans-serif", display: 'flex', flexDirection: 'column' },
    header: { borderBottom: '1px solid var(--border)', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: 'transparent', zIndex: 10 },
    headerLeft: { display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' },
    title: { fontFamily: "'DM Mono', monospace", fontSize: 19, fontWeight: 500, color: 'var(--t1)', margin: 0, letterSpacing: '-0.02em' },
    subtitle: { fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'var(--t5)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.14em' },
    addBtn: { background: 'var(--accent)', color: 'var(--accent-contrast)', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' },
    main: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 1320, margin: '0 auto', padding: '0 24px' },
    mainOuter: { flex: 1, overflow: 'hidden', display: 'flex', justifyContent: 'center' },
    staticArea: { flexShrink: 0, paddingTop: 14 },
    jobScroll: { flex: 1, overflowY: 'auto', paddingBottom: 40 },
    jobCard: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10, boxShadow: 'var(--shadow-card)' },
    jobTop: { padding: '16px 20px', cursor: 'pointer' },
    jobMain: { flex: 1, minWidth: 0 },
    jobTitle: { fontSize: 16, fontWeight: 600, color: 'var(--t1)', margin: '0 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '-0.01em' },
    jobCompany: { fontSize: 13, color: 'var(--t3)', margin: '0 0 11px', wordBreak: 'break-word' },
    jobBadges: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
    statusBadge: (status) => ({ background: STATUS_CONFIG[status].bg, color: STATUS_CONFIG[status].color, border: `1px solid ${STATUS_CONFIG[status].color}33`, borderRadius: 99, padding: '3px 10px', fontSize: 11, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }),
    dot: (status) => ({ width: 6, height: 6, borderRadius: '50%', background: STATUS_CONFIG[status].dot, display: 'inline-block' }),
    badge: { background: 'var(--surface-3)', color: 'var(--t4)', border: '1px solid var(--border-2)', borderRadius: 99, padding: '2px 8px', fontSize: 11 },
    chanceBadge: (n) => ({ background: 'var(--bg-inset)', color: CHANCE_COLOR(n), border: `1px solid ${CHANCE_COLOR(n)}44`, borderRadius: 99, padding: '2px 8px', fontSize: 11, fontFamily: "'DM Mono', monospace" }),
    daysTag: (d) => ({ fontSize: 11, color: d > 14 ? '#E24B4A' : d > 7 ? '#EF9F27' : 'var(--t5)', fontFamily: "'DM Mono', monospace" }),
    expanded: { borderTop: '1px solid var(--surface-3)', padding: '16px 20px', background: 'var(--bg-inset)' },
    expandRow: { display: 'flex', flexDirection: 'column', gap: 2 },
    expandLabel: { fontSize: 10, color: 'var(--t6)', textTransform: 'uppercase', letterSpacing: '0.06em' },
    expandVal: { fontSize: 13, color: 'var(--t2)', wordBreak: 'break-word' },
    notes: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', fontSize: 13, color: 'var(--t3)', fontFamily: "'DM Mono', monospace", lineHeight: 1.6, marginBottom: 16, wordBreak: 'break-word' },
    actionRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
    actionBtn: (color) => ({ background: 'transparent', color: color || 'var(--t5)', border: `1px solid ${color ? color + '33' : 'var(--border-2)'}`, borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }),
    statusSelect: { background: 'var(--surface-3)', color: 'var(--t2)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", maxWidth: '100%' },
    formOverlay: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, marginBottom: 28, boxShadow: 'var(--shadow-pop)' },
    formTitle: { fontFamily: "'DM Mono', monospace", fontSize: 14, color: 'var(--t1)', margin: '0 0 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    formGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
    formLabel: { fontSize: 11, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.06em' },
    formInput: { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', fontFamily: "'DM Sans', sans-serif", outline: 'none', width: '100%', boxSizing: 'border-box' },
    formTextarea: { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', fontFamily: "'DM Mono', monospace", outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 80 },
    cancelBtn: { background: 'transparent', color: 'var(--t5)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    saveBtn: { background: 'var(--accent)', color: 'var(--accent-contrast)', border: 'none', borderRadius: 6, padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", boxShadow: 'var(--accent-glow)' },
    empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t7)' },
    emptyTitle: { fontFamily: "'DM Mono', monospace", fontSize: 16, color: 'var(--t6)', margin: '0 0 8px' },
    emptyText: { fontSize: 13, color: 'var(--t7)', margin: 0 },
    loadingWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 16 },
    spinner: { width: 32, height: 32, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
    loadingText: { fontFamily: "'DM Mono', monospace", fontSize: 12, color: 'var(--t6)', margin: 0 },
    formTab: (active) => ({
      background: active ? 'var(--border)' : 'transparent',
      color: active ? 'var(--t1)' : 'var(--t5)',
      border: `1px solid ${active ? 'var(--t7)' : 'var(--border)'}`,
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

  const renderJobCard = (job, inGrid) => {
    const chanceRaw = job.chanceCustomized || job.chanceBase;
    const chanceVal = chanceRaw ? parseInt(chanceRaw) : null;
    return (
      <div
        key={job.id}
        className={`job-card-themed${inGrid ? ' job-card-grid' : ''}`}
        style={{ ...s.jobCard, position: 'relative', overflow: 'hidden', marginBottom: inGrid ? 0 : 10, cursor: 'pointer' }}
        onClick={() => edit(job)}
        title="Click to view / edit"
      >
        {chanceVal !== null && !Number.isNaN(chanceVal) && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: '50%', right: inGrid ? 16 : 24, transform: 'translateY(-50%)',
            fontFamily: "'DM Sans', sans-serif", fontWeight: 800, fontSize: inGrid ? 52 : 64,
            letterSpacing: '-0.05em', lineHeight: 1, color: CHANCE_COLOR(chanceVal),
            opacity: 0.13, pointerEvents: 'none', userSelect: 'none', zIndex: 0, whiteSpace: 'nowrap',
          }}>
            {chanceVal}<span style={{ fontSize: '0.5em', fontWeight: 700, letterSpacing: '-0.02em' }}>%</span>
          </span>
        )}
        <div style={{ ...s.jobTop, position: 'relative', zIndex: 1, paddingRight: chanceVal !== null && !Number.isNaN(chanceVal) ? (inGrid ? 84 : 104) : undefined }} className="job-top-responsive">
          <div style={s.jobMain}>
            <p style={s.jobTitle}>{job.role}</p>
            <p style={s.jobCompany}>{job.company}{job.location ? ` · ${job.location}` : ''}</p>
            <div style={s.jobBadges}>
              <span style={s.statusBadge(resolveStatus(job.status))}>
                <span style={s.dot(resolveStatus(job.status))} />
                {STATUS_CONFIG[resolveStatus(job.status)].label}
              </span>
              {job.appliedDate && (
                <span style={{ ...s.badge, fontFamily: "'DM Mono', monospace", fontSize: 10, color: 'var(--t4)' }}>
                  {fmt(job.appliedDate)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={s.app}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border-3); border-radius: 99px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--t7); }
        * { scrollbar-width: thin; scrollbar-color: var(--border-3) transparent; }
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
          <ThemePicker theme={theme} setTheme={setTheme} />
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
          <div className="modal-overlay" onClick={() => { setShowForm(false); resetFormPanel(); }}>
          <div style={s.formOverlay} className="form-overlay-responsive form-modal" onClick={(e) => e.stopPropagation()}>
            <p style={s.formTitle}>
              <span>{editId ? 'Edit application' : 'New application'}</span>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => { setShowForm(false); resetFormPanel(); }}>×</button>
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
                <p style={{ ...s.formLabel, marginBottom: 8, textTransform: 'none', letterSpacing: 0, fontSize: 12, color: 'var(--t4)' }}>
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
                      style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--t4)' }}>Applied today</span>
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
              {editId && (
                <button type="button" className="form-delete-btn" style={s.actionBtn('#E24B4A')} onClick={() => { del(editId); setShowForm(false); resetFormPanel(); }}>Delete</button>
              )}
              <button type="button" style={s.cancelBtn} onClick={() => { setShowForm(false); resetFormPanel(); }}>Cancel</button>
              <button type="button" style={s.saveBtn} onClick={save}>Save</button>
            </div>
              </>
            )}
          </div>
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
        <div className="dashboard-layout">
        <aside className="dashboard-side">
        {/* ── Activity & Streak ── */}
        {(() => {
          const activityData = getActivityData(jobs, chartRange);
          const maxCount = Math.max(...activityData.map(d => d.count), 1);
          const rateColor = stats.responseRate > 20 ? '#1D9E75' : stats.responseRate > 10 ? '#EF9F27' : '#E24B4A';
          return (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16, boxShadow: 'var(--shadow-card)' }}>
              {/* top row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* total */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 27, fontWeight: 500, letterSpacing: '-0.03em', color: 'var(--t1)' }}>{stats.total}</span>
                    <span style={{ fontSize: 10, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>total</span>
                  </div>
                  {/* response rate */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 27, fontWeight: 500, letterSpacing: '-0.03em', color: rateColor }}>{stats.responseRate}%</span>
                    <span style={{ fontSize: 10, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>response</span>
                  </div>
                  {/* streak */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 27, fontWeight: 500, letterSpacing: '-0.03em', color: stats.streak > 0 ? '#EF9F27' : 'var(--t7)' }}>
                      {stats.streak > 0 ? `🔥 ${stats.streak}` : '—'}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>streak</span>
                  </div>
                  {/* today */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 27, fontWeight: 500, letterSpacing: '-0.03em', color: stats.todayCount > 0 ? 'var(--accent)' : 'var(--border-3)' }}>{stats.todayCount}</span>
                    <span style={{ fontSize: 10, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>today</span>
                  </div>
                  {/* yesterday */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 27, fontWeight: 500, letterSpacing: '-0.03em', color: stats.yesterdayCount > 0 ? '#7F77DD' : 'var(--border-3)' }}>{stats.yesterdayCount}</span>
                    <span style={{ fontSize: 10, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>yesterday</span>
                  </div>
                </div>
                {/* controls: type + range as matching pill groups */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 7, padding: 2, gap: 2 }}>
                    {[['calendar', 'Calendar'], ['bar', 'Bar'], ['curve', 'Curve']].map(([t, label]) => (
                      <button key={t} type="button" onClick={() => setChartType(t)} style={{
                        background: chartType === t ? 'var(--border)' : 'transparent',
                        color: chartType === t ? 'var(--t1)' : 'var(--t6)',
                        border: 'none', borderRadius: 5, padding: '3px 10px',
                        fontSize: 11, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                        transition: 'background 0.15s, color 0.15s',
                      }}>{label}</button>
                    ))}
                  </div>
                  {chartType !== 'calendar' && (
                  <div style={{ display: 'flex', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 7, padding: 2, gap: 2 }}>
                    {[['weekly', '7 days'], ['monthly', '30 days']].map(([r, label]) => (
                      <button key={r} type="button" onClick={() => setChartRange(r)} style={{
                        background: chartRange === r ? 'var(--border)' : 'transparent',
                        color: chartRange === r ? 'var(--t1)' : 'var(--t6)',
                        border: 'none', borderRadius: 5, padding: '3px 10px',
                        fontSize: 11, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                        transition: 'background 0.15s, color 0.15s',
                      }}>{label}</button>
                    ))}
                  </div>
                  )}
                </div>
              </div>
              {/* chart */}
              {chartType === 'calendar' ? (() => {
                const weeks = getMonthMatrix(jobs, calDate.y, calDate.m);
                const goPrev = () => setCalDate(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }));
                const goNext = () => setCalDate(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }));
                const now = new Date();
                const isCurrentMonth = calDate.y === now.getFullYear() && calDate.m === now.getMonth();
                return (
                  <div className="chart-box">
                    <div className="cal-month-head">
                      <button type="button" className="cal-nav-btn" onClick={goPrev} aria-label="Previous month">‹</button>
                      <span className="cal-month-title">{MONTH_FULL[calDate.m]} {calDate.y}</span>
                      <button type="button" className="cal-nav-btn" onClick={goNext} disabled={isCurrentMonth} aria-label="Next month">›</button>
                    </div>
                    <div className="cal-weekdays">
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i}>{d}</span>)}
                    </div>
                    <div className="cal-grid">
                      {weeks.flat().map((day, i) => {
                        if (!day) return <div key={`e${i}`} className="cal-day cal-day-empty" />;
                        const isToday = day.date === today;
                        return (
                          <div
                            key={day.date}
                            className={`cal-day${isToday ? ' cal-day-today' : ''}`}
                            title={`${day.date}: ${day.count} application${day.count !== 1 ? 's' : ''}`}
                            style={{ background: HEAT_COLOR(day.count) }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })() : chartType === 'bar' ? (
                <div className="chart-box">
                  <div className="bar-plot" style={{ gap: chartRange === 'monthly' ? 3 : 6 }}>
                    {activityData.map((d) => {
                      const isToday = d.label === 'Today';
                      const barH = d.count === 0 ? 5 : Math.max(10, Math.round((d.count / maxCount) * 100));
                      return (
                        <div key={d.date} title={`${d.date}: ${d.count}`} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%', cursor: 'default' }}>
                          <div style={{ width: '100%', height: `${barH}%`, background: isToday ? 'var(--accent)' : d.count > 0 ? 'color-mix(in srgb, var(--accent) 32%, transparent)' : 'var(--surface-2)', borderRadius: 4, transition: 'height 0.3s ease' }} />
                        </div>
                      );
                    })}
                  </div>
                  {chartRange === 'weekly' ? (
                    <div className="chart-axis" style={{ gap: 6 }}>
                      {activityData.map((d) => (
                        <span key={d.date} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: d.label === 'Today' ? 'var(--accent)' : 'var(--t8)', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>{d.label}</span>
                      ))}
                    </div>
                  ) : (
                    <div className="chart-axis" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 9, color: 'var(--t8)', fontFamily: "'DM Mono', monospace" }}>{activityData[0]?.date?.slice(5)}</span>
                      <span style={{ fontSize: 9, color: 'var(--accent)', fontFamily: "'DM Mono', monospace" }}>Today</span>
                    </div>
                  )}
                </div>
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
                return (
                  <div className="chart-box">
                    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', flex: 1, minHeight: 0, display: 'block' }} preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.22 }} />
                          <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
                        </linearGradient>
                      </defs>
                      {fillD && <path d={fillD} fill="url(#cg)" />}
                      {pathD && <path d={pathD} fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
                    </svg>
                    <div className="chart-axis" style={{ justifyContent: chartRange === 'weekly' ? 'space-around' : 'space-between' }}>
                      {chartRange === 'weekly'
                        ? activityData.map(d => (
                          <span key={d.date} style={{ fontSize: 9, color: d.label === 'Today' ? 'var(--accent)' : 'var(--t8)', fontFamily: "'DM Mono', monospace" }}>{d.label}</span>
                        ))
                        : <>
                          <span style={{ fontSize: 9, color: 'var(--t8)', fontFamily: "'DM Mono', monospace" }}>{activityData[0]?.date?.slice(5)}</span>
                          <span style={{ fontSize: 9, color: 'var(--accent)', fontFamily: "'DM Mono', monospace" }}>Today</span>
                        </>
                      }
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* ── Filters ── */}
        <p className="filters-label">Filter by status</p>
        <div className="filters-list">
          {['all', ...Object.keys(STATUS_CONFIG)].map(f => {
            const active = filter === f;
            const color = f === 'all' ? 'var(--accent)' : STATUS_CONFIG[f].color;
            const count = f === 'all' ? jobs.length : jobs.filter(j => j.status === f).length;
            const label = f === 'all' ? 'All applications' : STATUS_CONFIG[f].label;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`filter-row${active ? ' active' : ''}`}
                style={{ '--tile-color': color }}
              >
                <span className="filter-row-dot" />
                <span className="filter-row-label">{label}</span>
                <span className="filter-row-count">{count}</span>
              </button>
            );
          })}
        </div>

        </aside>{/* end dashboard-side */}

        <section className="dashboard-jobs">
        {/* ── Toolbar: count · view toggle · export ── */}
        <div className="jobs-toolbar">
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'var(--t5)' }}>
            {filtered.length} {filtered.length === 1 ? 'application' : 'applications'}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 7, padding: 2, gap: 2 }}>
              {[['list', 'List'], ['grid', 'Grid']].map(([v, label]) => (
                <button key={v} type="button" onClick={() => setViewMode(v)} style={{
                  background: viewMode === v ? 'var(--border)' : 'transparent',
                  color: viewMode === v ? 'var(--t1)' : 'var(--t6)',
                  border: 'none', borderRadius: 5, padding: '4px 12px',
                  fontSize: 11, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                  transition: 'background 0.15s, color 0.15s',
                }}>{label}</button>
              ))}
            </div>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!jobs.length}
              title="Export all applications as a CSV spreadsheet"
              style={{
                background: 'transparent', color: jobs.length ? '#1D9E75' : 'var(--t7)',
                border: `1px solid ${jobs.length ? '#1D9E7544' : 'var(--surface-3)'}`,
                borderRadius: 7, padding: '5px 12px', fontSize: 11,
                cursor: jobs.length ? 'pointer' : 'not-allowed', fontFamily: "'DM Sans', sans-serif",
                display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
              }}
            >
              ↓ Export CSV
            </button>
          </div>
        </div>

        <div style={s.jobScroll} className="jobs-scroll-area">
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
            const isCollapsed = collapsedDates.has(dateKey);
            const cnt = grouped[dateKey].length;
            const accentColor = dateKey === todayStr ? 'var(--accent)' : dateKey === yesterdayStr ? '#7F77DD' : 'var(--t6)';
            return (
              <div key={dateKey}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleDateCollapse(dateKey)}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 600, color: accentColor, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: accentColor, background: `color-mix(in srgb, ${accentColor} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${accentColor} 30%, transparent)`, borderRadius: 99, padding: '1px 7px' }}>{cnt} app{cnt !== 1 ? 's' : ''}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 10, color: 'var(--t7)', fontFamily: "'DM Mono', monospace" }}>{isCollapsed ? '▶ show' : '▼ hide'}</span>
                </div>
                {!isCollapsed && (
                  viewMode === 'grid'
                    ? <div className="jobs-grid-responsive">{grouped[dateKey].map(job => renderJobCard(job, true))}</div>
                    : grouped[dateKey].map(job => renderJobCard(job))
                )}
              </div>
            );
          });
        })()}
        </div>{/* end jobScroll */}
        </section>{/* end dashboard-jobs */}
        </div>{/* end dashboard-layout */}
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
  const [theme, setTheme] = useState(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
    return (
      <Auth
        onGuest={enterGuest}
        firebaseReady={isFirebaseConfigured()}
        theme={theme}
        setTheme={setTheme}
      />
    );
  }
  return (
    <JobTracker
      isGuest={guestMode}
      user={user}
      onLeave={leaveGuest}
      theme={theme}
      setTheme={setTheme}
    />
  );
}
