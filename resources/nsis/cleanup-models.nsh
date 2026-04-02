!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed OpenWhispr cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
  ${endIf}
!macroend
