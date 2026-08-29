function centeredBounds(current, target, workArea) {
  const cur = current && typeof current === "object" ? current : {};
  const tgt = target && typeof target === "object" ? target : {};
  const area = workArea && typeof workArea === "object" ? workArea : {};

  const areaWidth = typeof area.width === "number" ? area.width : 0;
  const areaHeight = typeof area.height === "number" ? area.height : 0;
  const areaX = typeof area.x === "number" ? area.x : 0;
  const areaY = typeof area.y === "number" ? area.y : 0;

  const targetWidth = typeof tgt.width === "number" ? tgt.width : 0;
  const targetHeight = typeof tgt.height === "number" ? tgt.height : 0;

  const width = Math.min(targetWidth, areaWidth);
  const height = Math.min(targetHeight, areaHeight);

  const curX = typeof cur.x === "number" ? cur.x : areaX;
  const curY = typeof cur.y === "number" ? cur.y : areaY;
  const curWidth = typeof cur.width === "number" ? cur.width : width;
  const curHeight = typeof cur.height === "number" ? cur.height : height;

  const centerX = curX + curWidth / 2;
  const centerY = curY + curHeight / 2;
  const x = Math.round(
    Math.max(areaX, Math.min(centerX - width / 2, areaX + areaWidth - width))
  );
  const y = Math.round(
    Math.max(areaY, Math.min(centerY - height / 2, areaY + areaHeight - height))
  );
  return { x, y, width, height };
}

function clampedBounds(bounds, workArea) {
  const b = bounds && typeof bounds === "object" ? bounds : {};
  const area = workArea && typeof workArea === "object" ? workArea : {};

  const areaWidth = typeof area.width === "number" ? area.width : 0;
  const areaHeight = typeof area.height === "number" ? area.height : 0;
  const areaX = typeof area.x === "number" ? area.x : 0;
  const areaY = typeof area.y === "number" ? area.y : 0;

  const bWidth = typeof b.width === "number" ? b.width : 0;
  const bHeight = typeof b.height === "number" ? b.height : 0;
  const bX = typeof b.x === "number" ? b.x : areaX;
  const bY = typeof b.y === "number" ? b.y : areaY;

  const width = Math.min(bWidth, areaWidth);
  const height = Math.min(bHeight, areaHeight);
  const x = Math.round(
    Math.max(areaX, Math.min(bX, areaX + areaWidth - width))
  );
  const y = Math.round(
    Math.max(areaY, Math.min(bY, areaY + areaHeight - height))
  );
  return { x, y, width, height };
}

module.exports = { centeredBounds, clampedBounds };
