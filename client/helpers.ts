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

export function minutesUntilTomorrowMorning(targetHour = 9, targetMinute = 0, now = new Date()): number {
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
    };
    preventDefault?: () => void;
  };
  const ne = ev.nativeEvent;
  if (!ne || ne.isComposing) return false;
  if (ne.key === "Enter" && (ne.metaKey || ne.ctrlKey)) {
    ev.preventDefault?.();
    return true;
  }
  return false;
}

export function shortenPathForDisplay(rawPath: string): string {
  const clean = rawPath.trim();
  if (!clean) return "";
  return clean.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
