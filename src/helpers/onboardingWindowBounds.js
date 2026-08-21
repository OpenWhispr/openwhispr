function centeredBounds(current, target, workArea) {
  const width = Math.min(target.width, workArea.width);
  const height = Math.min(target.height, workArea.height);
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const x = Math.round(
    Math.max(workArea.x, Math.min(centerX - width / 2, workArea.x + workArea.width - width))
  );
  const y = Math.round(
    Math.max(workArea.y, Math.min(centerY - height / 2, workArea.y + workArea.height - height))
  );
  return { x, y, width, height };
}

function clampedBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.round(
    Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))
  );
  const y = Math.round(
    Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))
  );
  return { x, y, width, height };
}

module.exports = { centeredBounds, clampedBounds };
