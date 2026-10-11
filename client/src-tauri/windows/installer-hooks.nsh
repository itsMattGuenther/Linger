; Hooks into Tauri CLI v2.11.4's NSIS installer template
; (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), through
; bundle > windows > nsis > installerHooks. Check them against the template
; when updating the Tauri CLI: they rely on PREINSTALL coming just before
; the template's `File "${MAINBINARYSRCPATH}"`, POSTINSTALL after it,
; POSTUNINSTALL after the uninstaller's own Delete and RMDir, on its
; $UpdateMode, and on $R9 being free.
;
; An update waits for a busy program instead of asking (#568). Windows reads
; a program for a moment now and then: Explorer for a shortcut's icon, the
; compatibility scanner (CompatTelRunner) after an install, and the app
; itself is still quitting when the updater starts the installer. If the
; template's File meets one of those, NSIS shows "Error opening file for
; writing" with Abort, Retry and Ignore, and a passive update waits for a
; click; on a CI runner nobody makes it, and the update check sat there
; (#414, #568). So when updating, write the program here first, trying again
; every 100 ms for up to ten seconds. "try" makes a busy file an error to
; act on, not a dialog. If it is still busy after that, the template's own
; File below behaves as before, dialog and all.

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    SetOverwrite try
    StrCpy $R9 0
    ${Do}
      ClearErrors
      File "${MAINBINARYSRCPATH}"
      ${IfNot} ${Errors}
        ${Break}
      ${EndIf}
      IntOp $R9 $R9 + 1
      ${If} $R9 >= 100
        ${Break}
      ${EndIf}
      Sleep 100
    ${Loop}
  ${EndIf}
  ; SetOverwrite is set when the installer is built, for the File commands
  ; that follow it. "ifdiff" makes the template's File skip a program that
  ; already has this build's date (written just above), and write any other.
  SetOverwrite ifdiff
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOverwrite on
!macroend

; The uninstaller's Delete gives up quietly on a busy program and leaves it
; behind, with its folder. Explorer reads a program again just after an
; update changes it, so an uninstall straight after an update can meet that.
; By this point the template has closed the app, so try again for up to ten
; seconds, then remove the folder if it is empty.
!macro NSIS_HOOK_POSTUNINSTALL
  StrCpy $R9 0
  ${DoWhile} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $R9 >= 100
      ${Break}
    ${EndIf}
    IntOp $R9 $R9 + 1
    Sleep 100
    Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  ${Loop}
  RMDir "$INSTDIR"
!macroend
