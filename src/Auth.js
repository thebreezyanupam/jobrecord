import { useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { getAuth, initFirebase, isFirebaseConfigured } from './firebase';

export default function Auth({ onGuest, firebaseReady = true }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!isFirebaseConfigured()) {
      setError('Account sign-in is not configured. Use guest mode or set up environment variables.');
      return;
    }
    setBusy(true);
    try {
      initFirebase();
      const auth = getAuth();
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (err) {
      const msg = err.code === 'auth/email-already-in-use'
        ? 'Email already in use — try logging in.'
        : err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
          ? 'Invalid email or password.'
          : err.code === 'auth/weak-password'
            ? 'Password must be at least 6 characters.'
            : err.code === 'auth/invalid-email'
              ? 'Enter a valid email address.'
              : err.message || 'Something went wrong.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const input = {
    background: '#111',
    border: '1px solid #222',
    borderRadius: 6,
    padding: '10px 12px',
    fontSize: 14,
    color: '#e8e6e0',
    fontFamily: "'DM Sans', sans-serif",
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const label = {
    fontSize: 11,
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 5,
    display: 'block',
  };

  const primaryBtn = {
    background: '#378ADD',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? 'wait' : 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    width: '100%',
    opacity: busy ? 0.7 : 1,
  };

  const guestBtn = {
    background: 'transparent',
    color: '#888',
    border: '1px solid #222',
    borderRadius: 6,
    padding: '10px 20px',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    width: '100%',
  };

  const tabBtn = (active) => ({
    flex: 1,
    background: active ? '#1e1e1e' : 'transparent',
    color: active ? '#e8e6e0' : '#555',
    border: `1px solid ${active ? '#333' : '#1e1e1e'}`,
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  });

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <p className="auth-title">Job Tracker</p>
          <p className="auth-subtitle">Sign in to sync across devices</p>
        </div>

        <div className="auth-tabs">
          <button type="button" style={tabBtn(mode === 'login')} onClick={() => { setMode('login'); setError(''); }}>
            Log in
          </button>
          <button type="button" style={tabBtn(mode === 'signup')} onClick={() => { setMode('signup'); setError(''); }}>
            Sign up
          </button>
        </div>

        {!firebaseReady && (
          <p className="auth-error" style={{ marginBottom: 16 }}>
            Cloud sync is unavailable. Add a `.env` file (see `.env.example`) and restart the dev server, or continue without an account.
          </p>
        )}

        <form onSubmit={submit} className="auth-form">
          <div>
            <label style={label}>Email</label>
            <input
              type="email"
              style={input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label style={label}>Password</label>
            <input
              type="password"
              style={input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'min 6 characters' : '••••••••'}
              required
              minLength={6}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" style={primaryBtn} disabled={busy || !firebaseReady}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
        </form>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <button type="button" style={guestBtn} className="guest-btn" onClick={onGuest}>
          Continue without account
        </button>

        <p className="auth-footer">
          {mode === 'login' ? (
            <>No account? <button type="button" className="auth-link" onClick={() => { setMode('signup'); setError(''); }}>Sign up</button></>
          ) : (
            <>Have an account? <button type="button" className="auth-link" onClick={() => { setMode('login'); setError(''); }}>Log in</button></>
          )}
        </p>
      </div>
    </div>
  );
}
