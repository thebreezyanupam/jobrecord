export const THEMES = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'light', label: 'Daylight' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'rose', label: 'Rose' },
];

export const DEFAULT_THEME = 'midnight';
const STORAGE_KEY = 'jobtracker-theme';

export const loadTheme = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
};

export const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
};

export default function ThemePicker({ theme, setTheme }) {
  return (
    <label className="theme-select-wrap" title="Color theme">
      <span className="theme-select-icon" aria-hidden="true">◐</span>
      <select
        className="theme-select"
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        aria-label="Color theme"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </label>
  );
}
