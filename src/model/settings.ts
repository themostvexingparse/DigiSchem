/** User preferences, persisted in localStorage (survives restarts of the desktop app). */

export interface Settings {
  /** Deleting a component also removes wires left dangling from its pins (cascading). */
  sweepOrphanWires: boolean;
  /** Show alignment / equal-spacing guides while moving components. */
  showGuides: boolean;
  /** Snap the dragged component onto a guide when within `guideSnapCells` grid cells. */
  snapToGuides: boolean;
  guideSnapCells: number;
  /** Show small markers on pins that have nothing connected. */
  showUnconnectedPins: boolean;
  /** Show the dotted grid on the canvas. */
  showGrid: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sweepOrphanWires: true,
  showGuides: true,
  snapToGuides: true,
  guideSnapCells: 2,
  showUnconnectedPins: true,
  showGrid: true,
};

const KEY = "digischem.settings.v1";
type Listener = (s: Settings) => void;

function load(): Settings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) (out as Record<string, unknown>)[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current: Settings = load();
const listeners = new Set<Listener>();

export function getSettings(): Readonly<Settings> {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable (tests) — keep in memory */
  }
  for (const l of listeners) l(current);
}

export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
