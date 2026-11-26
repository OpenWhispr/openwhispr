// The dictation window's input region as the renderer measures it: a rect in
// CSS pixels plus the viewport it was measured in.
function isValidWindowInputRegion(region) {
  const values = [
    region?.viewportWidth,
    region?.viewportHeight,
    region?.x,
    region?.y,
    region?.width,
    region?.height,
  ];
  return (
    values.every(Number.isFinite) &&
    region.viewportWidth > 0 &&
    region.viewportHeight > 0 &&
    region.width >= 0 &&
    region.height >= 0
  );
}

module.exports = { isValidWindowInputRegion };
