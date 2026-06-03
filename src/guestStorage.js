const GUEST_JOBS_KEY = 'job_tracker_guest_jobs';
const GUEST_SESSION_KEY = 'job_tracker_guest_session';
const LEGACY_JOBS_KEY = 'job_tracker_guest_v1';
const LEGACY_SESSION_KEY = 'job_tracker_guest_session_v1';

export function isGuestSession() {
  try {
    if (localStorage.getItem(GUEST_SESSION_KEY) === '1') return true;
    if (localStorage.getItem(LEGACY_SESSION_KEY) === '1') {
      localStorage.setItem(GUEST_SESSION_KEY, '1');
      localStorage.removeItem(LEGACY_SESSION_KEY);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function startGuestSession() {
  localStorage.setItem(GUEST_SESSION_KEY, '1');
}

export function endGuestSession() {
  localStorage.removeItem(GUEST_SESSION_KEY);
  localStorage.removeItem(LEGACY_SESSION_KEY);
}

export function loadGuestJobs() {
  try {
    let raw = localStorage.getItem(GUEST_JOBS_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_JOBS_KEY);
      if (raw) {
        localStorage.setItem(GUEST_JOBS_KEY, raw);
        localStorage.removeItem(LEGACY_JOBS_KEY);
      }
    }
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveGuestJobs(jobs) {
  try {
    localStorage.setItem(GUEST_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    /* storage full or unavailable */
  }
}

export function normalizeGuestJobs(list) {
  return list
    .map((j) => ({ ...j, docId: String(j.id) }))
    .sort((a, b) => b.id - a.id);
}
