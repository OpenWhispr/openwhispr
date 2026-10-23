// A slot can own several bindings, one per configured hotkey row. Index 0
// keeps the bare slot name so gsettings paths, KGlobalAccel action ids and
// Hyprland binds written for a single hotkey stay byte-identical.
//
// Its own module so both hotkeyManager and the desktop backends can use it
// without a require cycle (hotkeyManager already requires all three backends).

function bindingIdFor(slotName, index) {
  return index === 0 ? slotName : `${slotName}#${index}`;
}

function slotOfBindingId(bindingId) {
  if (typeof bindingId !== "string") return "";
  const marker = bindingId.indexOf("#");
  return marker === -1 ? bindingId : bindingId.slice(0, marker);
}

// The row a binding id names. Hyprland sends slot and index as two D-Bus
// arguments rather than the id itself, because a literal "#" in a hyprlang
// line starts a comment.
function indexOfBindingId(bindingId) {
  if (typeof bindingId !== "string") return 0;
  const marker = bindingId.indexOf("#");
  if (marker === -1) return 0;
  const index = Number(bindingId.slice(marker + 1));
  return Number.isInteger(index) && index > 0 ? index : 0;
}

module.exports = { bindingIdFor, slotOfBindingId, indexOfBindingId };
