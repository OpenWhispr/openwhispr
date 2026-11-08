// Missing or stale activity reports must prevent an unattended restart.
function canRestart({
  enabled,
  downloaded,
  idleSeconds,
  panelVisible,
  dictationState,
  mainBusy,
  now,
  renderers,
}) {
  return (
    enabled === true &&
    downloaded === true &&
    idleSeconds >= 60 &&
    panelVisible === false &&
    dictationState === "idle" &&
    mainBusy === false &&
    renderers.length > 0 &&
    renderers.every(
      (state) => state?.busy === false && now - state.at >= 0 && now - state.at < 30000
    )
  );
}
module.exports = { canRestart };
