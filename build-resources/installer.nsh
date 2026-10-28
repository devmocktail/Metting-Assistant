; Custom A2solveX installer step: on uninstall, wipe the app's data
; (the downloaded captions engine + session token), not just the program files.
!macro customUnInstall
  RMDir /r "$APPDATA\private-meeting-overlay"
!macroend
