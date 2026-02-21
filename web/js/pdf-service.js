import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

import { PAGE_HORIZONTAL_PADDING } from "./constants.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

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

  const words = await extractWords(page, viewport);
  return {
    words,
    width: pdfCanvas.width,
    height: pdfCanvas.height,
  };
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
