; Harmless launch fixture: writes only its own log, no registry or app changes.
Unicode true
Name "Moyu updater launch fixture"
OutFile "moyu-update-fixture.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  FileOpen $0 "$EXEDIR\launched.txt" w
  FileWriteUTF16LE $0 "$CMDLINE$\r$\n$INSTDIR"
  FileClose $0
SectionEnd
