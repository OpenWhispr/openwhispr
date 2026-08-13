!macro customHeader
  ManifestDPIAware true
!macroend

; The bundled sherpa-onnx server (local Parakeet transcription) only serves
; this app over 127.0.0.1, but the upstream binary has no loopback-only bind
; option, so its wildcard listener triggers a Windows Firewall prompt. A
; scoped inbound BLOCK rule suppresses the prompt and closes the port to the
; network; loopback is never filtered, so transcription is unaffected.
; netsh needs elevation — per-user installs skip this silently.
!define SHERPA_FIREWALL_RULE "OpenWhispr Local Transcription Server (sherpa-onnx)"

; Electron writes the launch-at-login entry itself, so nothing in the generated
; uninstaller knows to remove it, and Windows keeps listing a startup item that
; points at a deleted executable. The Run value is named after the
; AppUserModelId main.js sets, which appends the release channel for non-
; production builds (keep in sync with BASE_WINDOWS_APP_ID and VALID_CHANNELS
; there). Disabling an item leaves a second value behind under StartupApproved,
; so both have to go.
!define OW_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define OW_STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

!macro DeleteAutoStartEntry NAME
  DeleteRegValue HKCU "${OW_RUN_KEY}" "${NAME}"
  DeleteRegValue HKCU "${OW_STARTUP_APPROVED_KEY}" "${NAME}"
!macroend

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SHERPA_FIREWALL_RULE}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SHERPA_FIREWALL_RULE}" dir=in action=block program="$INSTDIR\resources\bin\sherpa-onnx-ws-win32-x64.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  ; Guarded by isUpdated so an in-place update does not silently turn launch at
  ; login off for a user who had enabled it.
  ${ifNot} ${isUpdated}
    !insertmacro DeleteAutoStartEntry "com.gizmolabs.openwhispr"
    !insertmacro DeleteAutoStartEntry "com.gizmolabs.openwhispr.staging"
    !insertmacro DeleteAutoStartEntry "com.gizmolabs.openwhispr.development"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SHERPA_FIREWALL_RULE}"'
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed OpenWhispr cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
  ${endIf}
!macroend
