import { Platform } from "react-native";
import { MAX_ATTACHED_IMAGES } from "../shared/contracts";
import {
  shouldHideSidebarProjectGroup,
  type HiddenPinnedProjectsSpec,
} from "./sidebar-filter";

interface WebRect {
  width: number;
  height: number;
}

interface WebEvent {
  type?: string;
  defaultPrevented?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface WebFile {
  name?: string;
  type?: string;
  size: number;
}

interface WebDataTransferItem {
  kind: string;
  type: string;
  getAsFile(): WebFile | null;
}

interface WebDataTransfer {
  items?: ArrayLike<WebDataTransferItem>;
  files?: ArrayLike<WebFile>;
  types?: ArrayLike<string>;
  dropEffect?: string;
  getData?(format: string): string;
}

interface WebClipboardEvent extends WebEvent {
  clipboardData?: WebDataTransfer | null;
}

interface WebDragEvent extends WebEvent {
  dataTransfer?: WebDataTransfer | null;
}

interface WebElement {
  textContent?: string | null;
  id?: string;
  tagName?: string;
  isConnected?: boolean;
  isContentEditable?: boolean;
  type?: string;
  accept?: string;
  multiple?: boolean;
  files?: ArrayLike<WebFile> | null;
  style?: Record<string, string>;
  width?: number;
  height?: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): WebElement | null;
  contains?(other: unknown): boolean;
  querySelector(selector: string): WebElement | null;
  querySelectorAll(selector: string): ArrayLike<WebElement>;
  appendChild?(child: WebElement): WebElement;
  remove?(): void;
  click?(): void;
  getBoundingClientRect?(): WebRect;
  addEventListener?(
    type: string,
    listener: (event: WebEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener?(
    type: string,
    listener: (event: WebEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  getContext?(kind: "2d"): WebCanvas2DContext | null;
  toDataURL?(type?: string, quality?: number): string;
}

interface WebCanvas2DContext {
  drawImage(
    image: WebImageElement,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
}

interface WebImageElement {
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface WebFileReader {
  result: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: WebFile): void;
}

interface WebDocument {
  head?: WebElement | null;
  body?: WebElement | null;
  documentElement?: WebElement | null;
  activeElement?: WebElement | null;
  createElement(tagName: string): WebElement;
  getElementById(id: string): WebElement | null;
  querySelectorAll(selector: string): ArrayLike<WebElement>;
  addEventListener?(
    type: string,
    listener: (event: WebEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener?(
    type: string,
    listener: (event: WebEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
}

interface WebMutationObserver {
  observe(
    target: WebElement,
    options: {
      childList?: boolean;
      subtree?: boolean;
      attributes?: boolean;
      attributeFilter?: string[];
    },
  ): void;
  disconnect(): void;
}

type WebMutationObserverCtor = new (callback: () => void) => WebMutationObserver;
type WebFileReaderCtor = new () => WebFileReader;
type WebImageCtor = new () => WebImageElement;

interface WebGlobal {
  document?: WebDocument;
  MutationObserver?: WebMutationObserverCtor;
  FileReader?: WebFileReaderCtor;
  Image?: WebImageCtor;
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
}

export interface PastedImageItem {
  id: string;
  data: string;
  mimeType: string;
  previewUri: string;
  name?: string;
  sizeBytes?: number;
}

export type ImageInputErrorReason = "too_large" | "read_failed" | "unsupported";

export interface MountImagePasteOptions {
  container: unknown;
  captureWindowPaste?: boolean;
  onImages: (images: PastedImageItem[]) => void;
  onError?: (reason: ImageInputErrorReason) => void;
  onDragActiveChange?: (active: boolean) => void;
}

const STYLE_ELEMENT_ID = "paseo-bot-hide-pinned-projects-style";
const HIDDEN_ATTR = "data-paseo-bot-hidden-project";
const PROJECT_ROW_PREFIX = "sidebar-project-row-";
const PROJECT_ROW_SELECTOR = `[data-testid^="${PROJECT_ROW_PREFIX}"]`;
const WORKSPACE_ROW_SELECTOR = '[data-testid^="sidebar-workspace-row-"]';
const HIDDEN_SELECTOR = `[${HIDDEN_ATTR}="1"]`;

const MAX_RAW_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_BASE64_CHARS = 11 * 1024 * 1024;
const COMPRESS_TRIGGER_BYTES = 2 * 1024 * 1024;
const MAX_COMPRESSED_DIMENSION = 2048;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const handledPasteEvents = new WeakSet<object>();
let pastedImageSeq = 0;

function getWebGlobal(): WebGlobal | null {
  if (Platform.OS !== "web") return null;
  const g = globalThis as unknown as WebGlobal;
  if (!g.document || typeof g.document.querySelectorAll !== "function") return null;
  return g;
}

export function isWebImageInputSupported(): boolean {
  const g = getWebGlobal();
  return Boolean(g?.document && typeof g.FileReader === "function");
}

function createImageId(): string {
  pastedImageSeq += 1;
  return `img_${Date.now().toString(36)}_${pastedImageSeq}`;
}

function inferImageMimeType(file: WebFile, hintType?: string): string | null {
  const direct = (file.type || hintType || "").trim().toLowerCase();
  if (direct.startsWith("image/")) {
    return direct;
  }
  const name = (file.name || "").trim().toLowerCase();
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = name.slice(dotIdx);
    if (IMAGE_EXT_TO_MIME[ext]) {
      return IMAGE_EXT_TO_MIME[ext];
    }
  }
  return null;
}

function extractImageFilesFromTransfer(
  transfer: WebDataTransfer | null | undefined,
): Array<{ file: WebFile; mimeType: string }> {
  if (!transfer) return [];
  const results: Array<{ file: WebFile; mimeType: string }> = [];

  if (transfer.items && transfer.items.length > 0) {
    for (let i = 0; i < transfer.items.length; i += 1) {
      const item = transfer.items[i];
      if (!item || item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      const mimeType = inferImageMimeType(file, item.type);
      if (!mimeType) continue;
      results.push({ file, mimeType });
    }
  }

  if (results.length === 0 && transfer.files && transfer.files.length > 0) {
    for (let i = 0; i < transfer.files.length; i += 1) {
      const file = transfer.files[i];
      if (!file) continue;
      const mimeType = inferImageMimeType(file);
      if (!mimeType) continue;
      results.push({ file, mimeType });
    }
  }

  return results;
}

function hasFileTransferType(transfer: WebDataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  if (transfer.files && transfer.files.length > 0) return true;
  if (transfer.types) {
    for (let i = 0; i < transfer.types.length; i += 1) {
      if (transfer.types[i] === "Files") return true;
    }
  }
  if (transfer.items) {
    for (let i = 0; i < transfer.items.length; i += 1) {
      if (transfer.items[i]?.kind === "file") return true;
    }
  }
  return false;
}

function isPlainTextOnlyFilenames(
  plainText: string,
  files: ReadonlyArray<{ file: WebFile; mimeType: string }>,
): boolean {
  const trimmed = plainText.trim();
  if (!trimmed) return true;
  const fileNames = new Set(
    files
      .map((entry) => (entry.file.name || "").trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  if (fileNames.size === 0) return false;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  return lines.every((line) => fileNames.has(line));
}

function parseDataUrl(
  dataUrl: string,
  fallbackMime: string,
): { data: string; mimeType: string; previewUri: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const parsedMime = match[1].trim().toLowerCase();
  const mimeType = parsedMime.startsWith("image/") ? parsedMime : fallbackMime;
  const data = match[2].replace(/\s+/g, "");
  if (!data) return null;
  return {
    data,
    mimeType,
    previewUri: `data:${mimeType};base64,${data}`,
  };
}

function readFileAsDataUrl(g: WebGlobal, file: WebFile): Promise<string> {
  return new Promise((resolve, reject) => {
    const ReaderCtor = g.FileReader;
    if (!ReaderCtor) {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new ReaderCtor();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Empty FileReader result"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

async function maybeCompressDataUrl(
  g: WebGlobal,
  dataUrl: string,
  mimeType: string,
  originalSizeBytes: number,
): Promise<string> {
  if (
    mimeType === "image/gif" ||
    mimeType === "image/svg+xml" ||
    originalSizeBytes <= COMPRESS_TRIGGER_BYTES ||
    !g.document ||
    typeof g.Image !== "function"
  ) {
    return dataUrl;
  }

  try {
    const img = await new Promise<WebImageElement>((resolve, reject) => {
      const ImageCtor = g.Image!;
      const el = new ImageCtor();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = dataUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return dataUrl;

    const scale = Math.min(1, MAX_COMPRESSED_DIMENSION / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    const canvas = g.document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext?.("2d");
    if (!ctx || typeof canvas.toDataURL !== "function") return dataUrl;

    ctx.drawImage(img, 0, 0, targetW, targetH);

    // Prefer JPEG for huge screenshots/photos so payloads stay compact and snappy
    const jpegUrl = canvas.toDataURL("image/jpeg", 0.88);
    if (jpegUrl && jpegUrl.length < dataUrl.length) {
      return jpegUrl;
    }
    const webpUrl = canvas.toDataURL("image/webp", 0.88);
    if (webpUrl && webpUrl.length < dataUrl.length) {
      return webpUrl;
    }
    return dataUrl;
  } catch {
    return dataUrl;
  }
}

async function convertFilesToPastedImages(
  g: WebGlobal,
  entries: ReadonlyArray<{ file: WebFile; mimeType: string }>,
  onError?: (reason: ImageInputErrorReason) => void,
): Promise<PastedImageItem[]> {
  const limited = entries.slice(0, MAX_ATTACHED_IMAGES);
  const items: PastedImageItem[] = [];

  for (const { file, mimeType } of limited) {
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      onError?.("too_large");
      continue;
    }
    try {
      const rawDataUrl = await readFileAsDataUrl(g, file);
      const optimizedUrl = await maybeCompressDataUrl(g, rawDataUrl, mimeType, file.size);
      const parsed = parseDataUrl(optimizedUrl, mimeType);
      if (!parsed) {
        onError?.("read_failed");
        continue;
      }
      if (parsed.data.length > MAX_ENCODED_BASE64_CHARS) {
        onError?.("too_large");
        continue;
      }
      const approxBytes = Math.round((parsed.data.length * 3) / 4);
      items.push({
        id: createImageId(),
        data: parsed.data,
        mimeType: parsed.mimeType,
        previewUri: parsed.previewUri,
        name: file.name ? file.name.slice(0, 120) : undefined,
        sizeBytes: approxBytes,
      });
    } catch {
      onError?.("read_failed");
    }
  }

  return items;
}

function resolveDomElement(candidate: unknown): WebElement | null {
  if (!candidate || typeof candidate !== "object") return null;
  const el = candidate as WebElement;
  if (typeof el.addEventListener === "function") return el;
  return null;
}

function isEditableElement(el: WebElement | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const inputType = (el.getAttribute?.("type") || el.type || "text").toLowerCase();
    return inputType !== "button" && inputType !== "submit" && inputType !== "checkbox" && inputType !== "radio";
  }
  const role = (el.getAttribute?.("role") || "").toLowerCase();
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

function isElementVisible(el: WebElement): boolean {
  if (el.isConnected === false) return false;
  if (typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
  }
  return true;
}

/**
 * Mounts web/Electron clipboard paste + drag-and-drop image listeners onto a React Native View container.
 * Safe no-op on iOS/Android native platforms.
 */
export function mountWebImagePasteTarget(options: MountImagePasteOptions): () => void {
  const g = getWebGlobal();
  if (!g?.document) return () => {};
  const doc = g.document;
  const el = resolveDomElement(options.container);
  if (!el) return () => {};

  let disposed = false;
  let dragDepth = 0;

  const setDragActive = (active: boolean) => {
    if (!disposed) {
      options.onDragActiveChange?.(active);
    }
  };

  const handlePasteEvent = (rawEvent: WebEvent, isDocumentFallback: boolean) => {
    if (disposed || handledPasteEvents.has(rawEvent)) return;
    const event = rawEvent as WebClipboardEvent;

    if (isDocumentFallback) {
      if (!isElementVisible(el)) return;
      const activeEl = doc.activeElement;
      const activeInsideSelf = Boolean(activeEl && el.contains?.(activeEl));
      if (!activeInsideSelf) {
        if (isEditableElement(activeEl)) return;
        const activeModal = activeEl?.closest?.('[role="dialog"], [aria-modal="true"]');
        const selfModal = el.closest?.('[role="dialog"], [aria-modal="true"]');
        if (activeModal && activeModal !== selfModal) return;
      }
    }

    const imageEntries = extractImageFilesFromTransfer(event.clipboardData);
    if (imageEntries.length === 0) return;

    handledPasteEvents.add(rawEvent);
    const plainText = event.clipboardData?.getData?.("text/plain") ?? "";
    if (isPlainTextOnlyFilenames(plainText, imageEntries)) {
      event.preventDefault();
    }

    void convertFilesToPastedImages(g, imageEntries, options.onError).then((images) => {
      if (!disposed && images.length > 0) {
        options.onImages(images);
      }
    });
  };

  const onElementPaste = (ev: WebEvent) => handlePasteEvent(ev, false);
  const onDocumentPaste = (ev: WebEvent) => handlePasteEvent(ev, true);

  const onDragEnter = (rawEvent: WebEvent) => {
    const ev = rawEvent as WebDragEvent;
    if (!hasFileTransferType(ev.dataTransfer)) return;
    ev.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) setDragActive(true);
  };

  const onDragOver = (rawEvent: WebEvent) => {
    const ev = rawEvent as WebDragEvent;
    if (!hasFileTransferType(ev.dataTransfer)) return;
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = "copy";
    }
  };

  const onDragLeave = (rawEvent: WebEvent) => {
    const ev = rawEvent as WebDragEvent;
    if (!hasFileTransferType(ev.dataTransfer) && dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragActive(false);
  };

  const onDrop = (rawEvent: WebEvent) => {
    const ev = rawEvent as WebDragEvent;
    const hasFiles = hasFileTransferType(ev.dataTransfer);
    dragDepth = 0;
    setDragActive(false);
    if (!hasFiles) return;

    ev.preventDefault();
    ev.stopPropagation();
    const imageEntries = extractImageFilesFromTransfer(ev.dataTransfer);
    if (imageEntries.length === 0) {
      options.onError?.("unsupported");
      return;
    }
    void convertFilesToPastedImages(g, imageEntries, options.onError).then((images) => {
      if (!disposed && images.length > 0) {
        options.onImages(images);
      }
    });
  };

  el.addEventListener?.("paste", onElementPaste, true);
  el.addEventListener?.("dragenter", onDragEnter);
  el.addEventListener?.("dragover", onDragOver);
  el.addEventListener?.("dragleave", onDragLeave);
  el.addEventListener?.("drop", onDrop);
  if (options.captureWindowPaste) {
    doc.addEventListener?.("paste", onDocumentPaste, false);
  }

  return () => {
    disposed = true;
    dragDepth = 0;
    el.removeEventListener?.("paste", onElementPaste, true);
    el.removeEventListener?.("dragenter", onDragEnter);
    el.removeEventListener?.("dragover", onDragOver);
    el.removeEventListener?.("dragleave", onDragLeave);
    el.removeEventListener?.("drop", onDrop);
    if (options.captureWindowPaste) {
      doc.removeEventListener?.("paste", onDocumentPaste, false);
    }
  };
}

/**
 * Opens the native web/Electron file picker for selecting one or more images.
 * Returns an empty list on mobile/native platforms.
 */
export function pickWebImages(
  onError?: (reason: ImageInputErrorReason) => void,
): Promise<PastedImageItem[]> {
  const g = getWebGlobal();
  if (!g?.document || typeof g.FileReader !== "function") {
    return Promise.resolve([]);
  }
  const doc = g.document;
  const host = doc.body ?? doc.documentElement;
  if (!host || typeof host.appendChild !== "function") {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    if (input.style) {
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "-9999px";
      input.style.opacity = "0";
      input.style.pointerEvents = "none";
    }

    let settled = false;
    const finish = (images: PastedImageItem[]) => {
      if (settled) return;
      settled = true;
      input.remove?.();
      resolve(images);
    };

    const onChange = () => {
      const entries: Array<{ file: WebFile; mimeType: string }> = [];
      const files = input.files;
      if (files) {
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          if (!file) continue;
          const mimeType = inferImageMimeType(file);
          if (mimeType) {
            entries.push({ file, mimeType });
          } else {
            onError?.("unsupported");
          }
        }
      }
      if (entries.length === 0) {
        finish([]);
        return;
      }
      void convertFilesToPastedImages(g, entries, onError)
        .then((imgs) => finish(imgs))
        .catch(() => finish([]));
    };

    const onCancel = () => finish([]);

    input.addEventListener?.("change", onChange);
    input.addEventListener?.("cancel", onCancel);
    host.appendChild?.(input);
    input.click?.();
  });
}

function clearAllHiddenMarkers(doc: WebDocument): void {
  const marked = doc.querySelectorAll(HIDDEN_SELECTOR);
  for (let i = 0; i < marked.length; i += 1) {
    marked[i]?.removeAttribute(HIDDEN_ATTR);
  }
  const styleEl = doc.getElementById(STYLE_ELEMENT_ID);
  styleEl?.remove?.();
}

function ensureHideStyle(doc: WebDocument): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const container = doc.head ?? doc.documentElement;
  if (!container || typeof container.appendChild !== "function") return;
  const styleEl = doc.createElement("style");
  styleEl.id = STYLE_ELEMENT_ID;
  styleEl.textContent = `${HIDDEN_SELECTOR} { display: none !important; }`;
  container.appendChild(styleEl);
}

function applyHiddenProjects(doc: WebDocument, spec: HiddenPinnedProjectsSpec): void {
  const activeGroups = new Set<WebElement>();
  const rows = doc.querySelectorAll(PROJECT_ROW_SELECTOR);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const testId = row.getAttribute("data-testid") ?? "";
    if (!testId.startsWith(PROJECT_ROW_PREFIX)) continue;
    const viewKey = testId.slice(PROJECT_ROW_PREFIX.length);
    const groupEl = row.closest('[role="group"]');
    if (!groupEl) continue;

    activeGroups.add(groupEl);
    const groupLabel = groupEl.getAttribute("aria-label") ?? "";
    const hasVisibleWorkspaceRow = groupEl.querySelector(WORKSPACE_ROW_SELECTOR) !== null;

    const shouldHide = shouldHideSidebarProjectGroup({
      viewKey,
      groupLabel,
      hasVisibleWorkspaceRow,
      spec,
    });

    if (shouldHide) {
      if (groupEl.getAttribute(HIDDEN_ATTR) !== "1") {
        groupEl.setAttribute(HIDDEN_ATTR, "1");
      }
    } else if (groupEl.getAttribute(HIDDEN_ATTR) !== null) {
      groupEl.removeAttribute(HIDDEN_ATTR);
    }
  }

  // Sweep any previously marked element that no longer corresponds to a matched project group
  const marked = doc.querySelectorAll(HIDDEN_SELECTOR);
  for (let i = 0; i < marked.length; i += 1) {
    const el = marked[i];
    if (el && !activeGroups.has(el)) {
      el.removeAttribute(HIDDEN_ATTR);
    }
  }
}

/**
 * On Paseo Web & Electron Desktop, hides bottom-section sidebar project folders
 * whose workspaces are already pinned at the top and have no unpinned workspaces left.
 * Uses a data attribute + stylesheet rule so React inline style reconciliation cannot undo it.
 */
export function mountHiddenSidebarProjectsObserver(
  enabled: boolean,
  spec: HiddenPinnedProjectsSpec,
): () => void {
  const g = getWebGlobal();
  if (!g?.document) return () => {};
  const doc = g.document;

  const hasTargets = spec.viewKeys.size > 0 || spec.safeDisplayNames.size > 0;
  if (!enabled || !hasTargets) {
    clearAllHiddenMarkers(doc);
    return () => {};
  }

  ensureHideStyle(doc);
  applyHiddenProjects(doc, spec);

  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scheduleApply = () => {
    if (disposed || rafId !== null || timerId !== null) return;
    if (typeof g.requestAnimationFrame === "function") {
      rafId = g.requestAnimationFrame(() => {
        rafId = null;
        if (!disposed) applyHiddenProjects(doc, spec);
      });
    } else {
      timerId = setTimeout(() => {
        timerId = null;
        if (!disposed) applyHiddenProjects(doc, spec);
      }, 16);
    }
  };

  let observer: WebMutationObserver | null = null;
  const observeRoot = doc.body ?? doc.documentElement;
  if (observeRoot && typeof g.MutationObserver === "function") {
    observer = new g.MutationObserver(scheduleApply);
    observer.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid"],
    });
  }

  return () => {
    disposed = true;
    if (rafId !== null && typeof g.cancelAnimationFrame === "function") {
      g.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    observer?.disconnect();
    observer = null;
    clearAllHiddenMarkers(doc);
  };
}
