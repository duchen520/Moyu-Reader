; Retire the old product registration only when upgrading the very same folder.
; Separate installations and the shared reading-data directory remain untouched.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tomato Reader" "InstallLocation"
  StrCpy $R1 '$\"$INSTDIR$\"'
  ${If} $R0 == $R1
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tomato Reader"
  ${EndIf}
!macroend
