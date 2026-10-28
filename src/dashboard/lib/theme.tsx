import { useEffect, useState } from 'react';

// Follows the system setting until you pick one; the pick is remembered in this browser.
// index.html applies the same rule before the first paint, so the page never flashes light.
export type Theme = 'light' | 'dark';
const KEY = 'ml_theme';
const EVENT = 'ml:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

const current = (): Theme => stored() ?? (media.matches ? 'dark' : 'light');

function apply() {
  document.documentElement.classList.toggle('dark', current() === 'dark');
  window.dispatchEvent(new Event(EVENT));
}

media.addEventListener('change', apply);

export function toggleTheme() {
  try {
    localStorage.setItem(KEY, current() === 'dark' ? 'light' : 'dark');
  } catch {}
  apply();
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(current);
  useEffect(() => {
    const on = () => setTheme(current());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return theme;
}

/** Moon in light mode, sun in dark: the icon shows where a click takes you. */
export function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === 'dark' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ThemeButton() {
  const theme = useTheme();
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
  return (
    <button className="btn w-10 px-0" onClick={toggleTheme} aria-label={label} title={label}>
      <ThemeIcon theme={theme} />
    </button>
  );
}
