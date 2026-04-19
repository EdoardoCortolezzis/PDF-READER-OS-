import { darkenRgb, lightenRgb } from "./utils.js";

export function drawTriangleIndicator({
  overlayContext,
  pointer,
  triangleSize,
  themeRgb,
}) {
  if (!pointer) {
    return null;
  }

  const centerX = pointer.x;
  const top = pointer.y0;
  const triangleHeight = Math.max(18, triangleSize?.height ?? 20);
  const triangleWidth = Math.max(24, triangleSize?.width ?? 26);

  const glowWidth = triangleWidth * 1.35;
  const glowHeight = triangleHeight * 1.25;

  const edgeColor = darkenRgb(themeRgb, 0.52);
  const gradientStart = lightenRgb(themeRgb, 0.25);
  const gradientEnd = darkenRgb(themeRgb, 0.14);

  overlayContext.save();
  overlayContext.fillStyle = `rgba(${themeRgb.r}, ${themeRgb.g}, ${themeRgb.b}, 0.45)`;
  overlayContext.shadowColor = `rgba(${themeRgb.r}, ${themeRgb.g}, ${themeRgb.b}, 0.8)`;
  overlayContext.shadowBlur = 18;
  overlayContext.beginPath();
  overlayContext.moveTo(centerX, top + 1);
  overlayContext.lineTo(centerX - glowWidth / 2, top - glowHeight);
  overlayContext.lineTo(centerX + glowWidth / 2, top - glowHeight);
  overlayContext.closePath();
  overlayContext.fill();
  overlayContext.restore();

  const gradient = overlayContext.createLinearGradient(
    centerX,
    top - triangleHeight,
    centerX,
    top + 1
  );
  gradient.addColorStop(
    0,
    `rgba(${gradientStart.r}, ${gradientStart.g}, ${gradientStart.b}, 0.9)`
  );
  gradient.addColorStop(
    1,
    `rgba(${gradientEnd.r}, ${gradientEnd.g}, ${gradientEnd.b}, 0.96)`
  );

  overlayContext.fillStyle = gradient;
  overlayContext.strokeStyle = `rgba(${edgeColor.r}, ${edgeColor.g}, ${edgeColor.b}, 0.92)`;
  overlayContext.lineWidth = 2;
  overlayContext.lineJoin = "round";
  overlayContext.beginPath();
  overlayContext.moveTo(centerX, top - 2);
  overlayContext.lineTo(centerX - triangleWidth / 2, top - triangleHeight);
  overlayContext.lineTo(centerX + triangleWidth / 2, top - triangleHeight);
  overlayContext.closePath();
  overlayContext.fill();
  overlayContext.stroke();

  return {
    y0: pointer.y0,
    y1: pointer.y1,
  };
}
