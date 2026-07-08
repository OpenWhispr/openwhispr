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

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SHERPA_FIREWALL_RULE}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SHERPA_FIREWALL_RULE}" dir=in action=block program="$INSTDIR\resources\bin\sherpa-onnx-ws-win32-x64.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SHERPA_FIREWALL_RULE}"'
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed OpenWhispr cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
  ${endIf}
!macroend
