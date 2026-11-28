import { Platform } from "react-native";

export interface RelativeTimeLabels {
  justNow: string;
  minsAgo: (count: number) => string;
  todayAt: (time: string) => string;
  yesterdayAt: (time: string) => string;
}

export function formatShortTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

export function formatSmartTime(
  iso: string | undefined,
  labels: RelativeTimeLabels,
  nowMs = Date.now(),
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return iso;

  const diffSec = Math.floor((nowMs - ts) / 1000);
  if (diffSec >= -30 && diffSec < 60) {
    return labels.justNow;
  }
  if (diffSec >= 60 && diffSec < 3600) {
    return labels.minsAgo(Math.max(1, Math.floor(diffSec / 60)));
  }

  return formatStreamDividerTime(iso, labels, nowMs);
}

export function formatStreamDividerTime(
  iso: string | undefined,
  labels: Pick<RelativeTimeLabels, "todayAt" | "yesterdayAt">,
  nowMs = Date.now(),
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const hhmm = `${hh}:${min}`;

  const now = new Date(nowMs);
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return labels.todayAt(hhmm);
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return labels.yesterdayAt(hhmm);
  }

  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd} ${hhmm}`;
}

export function shouldInsertTimeDivider(
  prevIso: string | undefined,
  currIso: string,
  thresholdMs = 15 * 60 * 1000,
): boolean {
  if (!prevIso) return true;
  const prevDate = new Date(prevIso);
  const currDate = new Date(currIso);
  const prevTs = prevDate.getTime();
  const currTs = currDate.getTime();
  if (Number.isNaN(prevTs) || Number.isNaN(currTs)) return false;
  if (Math.abs(currTs - prevTs) > thresholdMs) return true;
  return (
    prevDate.getFullYear() !== currDate.getFullYear() ||
    prevDate.getMonth() !== currDate.getMonth() ||
    prevDate.getDate() !== currDate.getDate()
  );
}

export function formatElapsedDuration(startIso: string | undefined, nowMs = Date.now()): string {
  if (!startIso) return "";
  const ts = Date.parse(startIso);
  if (!Number.isFinite(ts)) return "";
  const sec = Math.max(1, Math.floor((nowMs - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

export function minutesUntilTomorrowMorning(
  targetHour = 9,
  targetMinute = 0,
  now = new Date(),
): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    targetHour,
    targetMinute,
    0,
    0,
  );
  const diffMin = Math.round((next.getTime() - now.getTime()) / 60_000);
  return Math.max(15, diffMin);
}

export function isSameLocalDay(iso: string, refDate: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === refDate.getFullYear() &&
    d.getMonth() === refDate.getMonth() &&
    d.getDate() === refDate.getDate()
  );
}

export function isModifierSubmitKey(event: unknown): boolean {
  if (Platform.OS !== "web" || !event || typeof event !== "object") return false;
  const ev = event as {
    nativeEvent?: {
      key?: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      isComposing?: boolean;
      keyCode?: number;
    };
    preventDefault?: () => void;
  };
  const ne = ev.nativeEvent;
  if (!ne || ne.isComposing || ne.keyCode === 229 || ne.key === "Process") return false;
  if (ne.key === "Enter" && (ne.metaKey || ne.ctrlKey)) {
    ev.preventDefault?.();
    return true;
  }
  return false;
}

/**
 * Desktop web chat composer key handler:
 * - Enter (without Shift) -> submit
 * - Cmd+Enter / Ctrl+Enter -> submit
 * - Shift+Enter -> newline
 * - IME composition (`isComposing` / keyCode 229) -> never submit
 */
export function isChatEnterSubmitKey(event: unknown): boolean {
  if (Platform.OS !== "web" || !event || typeof event !== "object") return false;
  const ev = event as {
    nativeEvent?: {
      key?: string;
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
      isComposing?: boolean;
      keyCode?: number;
    };
    preventDefault?: () => void;
  };
  const ne = ev.nativeEvent;
  if (!ne || ne.isComposing || ne.keyCode === 229 || ne.key === "Process") {
    return false;
  }
  if (ne.key !== "Enter") return false;
  if (ne.shiftKey && !ne.metaKey && !ne.ctrlKey) {
    return false;
  }
  ev.preventDefault?.();
  return true;
}

export function shortenPathForDisplay(rawPath: string): string {
  const clean = rawPath.trim();
  if (!clean) return "";
  return clean.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/**
 * Estimates whether a CSS color token represents a dark surface so bubbles and
 * avatars can pick the most legible theme surface token (`surface1` vs `surface2`).
 */
export function isDarkSurfaceColor(rawColor: string): boolean {
  const c = rawColor.trim();
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(c);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r =
      hex.length === 3
        ? Number.parseInt(hex[0] + hex[0], 16)
        : Number.parseInt(hex.slice(0, 2), 16);
    const g =
      hex.length === 3
        ? Number.parseInt(hex[1] + hex[1], 16)
        : Number.parseInt(hex.slice(2, 4), 16);
    const b =
      hex.length === 3
        ? Number.parseInt(hex[2] + hex[2], 16)
        : Number.parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.45;
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (rgbMatch) {
    const r = Number.parseInt(rgbMatch[1], 10);
    const g = Number.parseInt(rgbMatch[2], 10);
    const b = Number.parseInt(rgbMatch[3], 10);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.45;
  }
  return false;
}
