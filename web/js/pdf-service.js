import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

import { PAGE_HORIZONTAL_PADDING } from "./constants.js";
import { clampByte, hexToRgb } from "./utils.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const DEFAULT_HIGHLIGHT_RGB = Object.freeze({ r: 255, g: 241, b: 118 });
const PDF_SAVE_OPTIONS = Object.freeze({
  useObjectStreams: false,
  addDefaultPage: false,
  updateFieldAppearances: false,
});
const PDF_LOAD_OPTIONS = Object.freeze({
  updateMetadata: false,
});

export async function loadPdfDocument(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  return loadingTask.promise;
}

export async function renderPdfPage({
  pdfDoc,
  pageNumber,
  viewerWidth,
  pdfCanvas,
  overlayCanvas,
}) {
  const page = await pdfDoc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });

  const width = Math.max(260, viewerWidth - PAGE_HORIZONTAL_PADDING);
  const scale = width / unscaled.width;
  const viewport = page.getViewport({ scale });

  pdfCanvas.width = Math.ceil(viewport.width);
  pdfCanvas.height = Math.ceil(viewport.height);
  overlayCanvas.width = pdfCanvas.width;
  overlayCanvas.height = pdfCanvas.height;

  const context = pdfCanvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;

  const [words, existingHighlightAnnotations] = await Promise.all([
    extractWords(page, viewport),
    extractHighlightAnnotations(page, viewport),
  ]);

  return {
    words,
    existingHighlightAnnotations,
    viewportInverseTransform: [...pdfjsLib.Util.inverseTransform(viewport.transform)],
  };
}

function getPageOrThrow(pdfDoc, pageNumber) {
  const page = pdfDoc.getPages()[pageNumber - 1];
  if (!page) {
    throw new Error(`Page ${pageNumber} is out of range.`);
  }
  return page;
}

function savePdfDocument(pdfDoc) {
  return pdfDoc.save(PDF_SAVE_OPTIONS);
}

async function extractWords(page, viewport) {
  const textContent = await page.getTextContent();
  const words = [];

  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) {
      continue;
    }

    const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const x = matrix[4];
    const y = matrix[5];

    const rawHeight = Math.abs((item.height || 0) * viewport.scale);
    const fallbackHeight = Math.max(10, Math.hypot(matrix[2], matrix[3]));
    const itemHeight = rawHeight > 0.5 ? rawHeight : fallbackHeight;

    const rawWidth = Math.abs((item.width || 0) * viewport.scale);
    const fallbackWidth = Math.max(10, item.str.length * itemHeight * 0.42);
    const totalWidth = rawWidth > 0.5 ? rawWidth : fallbackWidth;

    const chunks = item.str.split(/(\s+)/).filter(Boolean);
    const baseLength = Math.max(1, item.str.length);
    let cursorX = x;

    for (const chunk of chunks) {
      const chunkWidth = totalWidth * (chunk.length / baseLength);
      if (/^\s+$/.test(chunk)) {
        cursorX += chunkWidth;
        continue;
      }

      words.push({
        text: chunk,
        x0: cursorX,
        y0: y - itemHeight,
        x1: cursorX + chunkWidth,
        y1: y,
      });

      cursorX += chunkWidth;
    }
  }

  words.sort((left, right) => {
    const deltaY = left.y0 - right.y0;
    if (Math.abs(deltaY) < 0.8) {
      return left.x0 - right.x0;
    }
    return deltaY;
  });

  return words;
}

async function extractHighlightAnnotations(page, viewport) {
  const annotations = await page.getAnnotations({ intent: "display" });

  return annotations
    .filter((annotation) => annotation?.subtype === "Highlight")
    .map((annotation) => {
      const color = normalizeHighlightColor(annotation.color);
      const quadPoints = flattenQuadPoints(annotation.quadPoints);
      const rects = [];

      for (let index = 0; index <= quadPoints.length - 8; index += 8) {
        const viewQuad = [];
        for (let pointIndex = 0; pointIndex < 8; pointIndex += 2) {
          viewQuad.push(
            toViewportPoint(
              viewport,
              quadPoints[index + pointIndex],
              quadPoints[index + pointIndex + 1]
            )
          );
        }
        rects.push(quadToViewRect(viewQuad));
      }

      if (!rects.length && Array.isArray(annotation.rect) && annotation.rect.length >= 4) {
        const leftBottom = toViewportPoint(viewport, annotation.rect[0], annotation.rect[1]);
        const rightTop = toViewportPoint(viewport, annotation.rect[2], annotation.rect[3]);
        rects.push({
          x0: Math.min(leftBottom.x, rightTop.x),
          y0: Math.min(leftBottom.y, rightTop.y),
          x1: Math.max(leftBottom.x, rightTop.x),
          y1: Math.max(leftBottom.y, rightTop.y),
        });
      }

      return {
        fillStyle: `rgba(${color.r}, ${color.g}, ${color.b}, 0.34)`,
        strokeStyle: `rgba(${color.r}, ${color.g}, ${color.b}, 0.58)`,
        rects,
      };
    })
    .filter((annotation) => annotation.rects.length > 0);
}

export async function addPdfHighlightAnnotation({
  pdfBytes,
  pageNumber,
  quadPoints,
  colorHex = "#fff176",
  author = "PDF Reading Pacer",
}) {
  if (!pdfBytes || !quadPoints?.length) {
    return pdfBytes;
  }

  const pdfDoc = await PDFDocument.load(pdfBytes, PDF_LOAD_OPTIONS);
  const page = getPageOrThrow(pdfDoc, pageNumber);

  const flattenedQuadPoints = quadPoints.flatMap((quad) => quad);
  const rect = computeAnnotationRectFromQuads(quadPoints);
  const color = hexToPdfColor(colorHex);

  const annotationDict = pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: rect,
    QuadPoints: flattenedQuadPoints,
    C: color,
    F: PDFNumber.of(4),
    CA: PDFNumber.of(0.36),
    NM: PDFHexString.fromText(`hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    T: PDFHexString.fromText(author),
    M: PDFString.of(toPdfDate(new Date())),
    P: page.ref,
  });
  const annotationRef = pdfDoc.context.register(annotationDict);

  const annots = getAnnotsArray(page, pdfDoc.context, true);
  annots.push(annotationRef);

  return savePdfDocument(pdfDoc);
}

export async function removePdfHighlightAnnotationAtPoint({
  pdfBytes,
  pageNumber,
  x,
  y,
  tolerance = 1.2,
}) {
  if (!pdfBytes) {
    return { pdfBytes, removed: false };
  }

  const pdfDoc = await PDFDocument.load(pdfBytes, PDF_LOAD_OPTIONS);
  const page = getPageOrThrow(pdfDoc, pageNumber);
  const annots = getAnnotsArray(page, pdfDoc.context);
  if (!annots || annots.size() === 0) {
    return { pdfBytes, removed: false };
  }

  let removed = false;
  for (let index = annots.size() - 1; index >= 0; index -= 1) {
    const annotation = pdfDoc.context.lookup(annots.get(index));
    if (!annotation || typeof annotation.get !== "function") {
      continue;
    }

    const subtype = annotation.get(PDFName.of("Subtype"));
    if (!subtype || subtype.toString() !== "/Highlight") {
      continue;
    }

    if (!isPointInsideHighlightAnnotation(annotation, pdfDoc.context, x, y, tolerance)) {
      continue;
    }

    annots.remove(index);
    removed = true;
    break;
  }

  if (!removed) {
    return { pdfBytes, removed: false };
  }

  const nextPdfBytes = await savePdfDocument(pdfDoc);

  return { pdfBytes: nextPdfBytes, removed: true };
}

function getAnnotsArray(page, context, createIfMissing = false) {
  if (typeof page.node.Annots === "function") {
    const annots = page.node.Annots();
    if (annots) {
      return annots;
    }
  }

  const annotsKey = PDFName.of("Annots");
  const existing = page.node.get(annotsKey);
  if (existing) {
    const lookedUp = context.lookup(existing, PDFArray);
    if (lookedUp) {
      return lookedUp;
    }
  }

  if (!createIfMissing) {
    return null;
  }

  const annots = context.obj([]);
  page.node.set(annotsKey, annots);
  return annots;
}

function isPointInsideHighlightAnnotation(annotation, context, x, y, tolerance) {
  const quadPoints = extractQuadPointGroups(annotation, context);
  if (quadPoints.length) {
    return quadPoints.some((quad) => {
      return isPointInsideRect({
        x0: Math.min(quad[0], quad[2], quad[4], quad[6]),
        y0: Math.min(quad[1], quad[3], quad[5], quad[7]),
        x1: Math.max(quad[0], quad[2], quad[4], quad[6]),
        y1: Math.max(quad[1], quad[3], quad[5], quad[7]),
      }, x, y, tolerance);
    });
  }

  const rect = extractRect(annotation, context);
  if (rect) {
    return isPointInsideRect(rect, x, y, tolerance);
  }

  return false;
}

function extractQuadPointGroups(annotation, context) {
  const key = PDFName.of("QuadPoints");
  const raw = annotation.get(key);
  if (!raw) {
    return [];
  }

  const quadArray = context.lookup(raw, PDFArray);
  if (!quadArray) {
    return [];
  }

  const values = [];
  for (let index = 0; index < quadArray.size(); index += 1) {
    const value = numberFromPdfObject(quadArray.get(index), context);
    if (value !== null) {
      values.push(value);
    }
  }

  const groups = [];
  for (let index = 0; index <= values.length - 8; index += 8) {
    groups.push(values.slice(index, index + 8));
  }
  return groups;
}

function extractRect(annotation, context) {
  const key = PDFName.of("Rect");
  const raw = annotation.get(key);
  if (!raw) {
    return null;
  }

  const rectArray = context.lookup(raw, PDFArray);
  if (!rectArray || rectArray.size() < 4) {
    return null;
  }

  const rectValues = [];
  for (let index = 0; index < 4; index += 1) {
    const value = numberFromPdfObject(rectArray.get(index), context);
    if (value === null) {
      return null;
    }
    rectValues.push(value);
  }

  return {
    x0: Math.min(rectValues[0], rectValues[2]),
    y0: Math.min(rectValues[1], rectValues[3]),
    x1: Math.max(rectValues[0], rectValues[2]),
    y1: Math.max(rectValues[1], rectValues[3]),
  };
}

function numberFromPdfObject(object, context) {
  const resolved = object && typeof object === "object"
    ? context.lookup(object)
    : object;
  if (resolved && typeof resolved.asNumber === "function") {
    return resolved.asNumber();
  }

  const direct = resolved ?? object;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  const parsed = Number(direct);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPointInsideRect(rect, x, y, tolerance) {
  return (
    x >= rect.x0 - tolerance
    && x <= rect.x1 + tolerance
    && y >= rect.y0 - tolerance
    && y <= rect.y1 + tolerance
  );
}

function toPdfDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function hexToPdfColor(hexColor) {
  const validHex = hexToRgb(hexColor) ?? DEFAULT_HIGHLIGHT_RGB;
  return [
    validHex.r / 255,
    validHex.g / 255,
    validHex.b / 255,
  ];
}

function computeAnnotationRectFromQuads(quadPoints) {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  quadPoints.forEach((quad) => {
    for (let index = 0; index <= 6; index += 2) {
      const x = quad[index];
      const y = quad[index + 1];
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
  });

  return [xMin, yMin, xMax, yMax];
}

function flattenQuadPoints(quadPoints) {
  if (!Array.isArray(quadPoints) && !ArrayBuffer.isView(quadPoints)) {
    return [];
  }

  return Array.from(quadPoints, Number).filter(Number.isFinite);
}

function normalizeHighlightColor(color) {
  const values = (
    Array.isArray(color) || ArrayBuffer.isView(color)
      ? Array.from(color)
      : []
  ).slice(0, 3);
  if (!values.length) {
    return DEFAULT_HIGHLIGHT_RGB;
  }

  const normalized = values.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return 0;
    }
    return number <= 1 ? Math.round(number * 255) : Math.round(number);
  });

  return {
    r: clampByte(normalized[0] ?? DEFAULT_HIGHLIGHT_RGB.r),
    g: clampByte(normalized[1] ?? DEFAULT_HIGHLIGHT_RGB.g),
    b: clampByte(normalized[2] ?? DEFAULT_HIGHLIGHT_RGB.b),
  };
}

function quadToViewRect(points) {
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  return {
    x0: Math.min(...xValues),
    y0: Math.min(...yValues),
    x1: Math.max(...xValues),
    y1: Math.max(...yValues),
  };
}

function toViewportPoint(viewport, x, y) {
  if (typeof viewport.convertToViewportPoint === "function") {
    const [xView, yView] = viewport.convertToViewportPoint(x, y);
    return { x: xView, y: yView };
  }

  const [xView, yView] = pdfjsLib.Util.applyTransform([x, y], viewport.transform);
  return { x: xView, y: yView };
}
