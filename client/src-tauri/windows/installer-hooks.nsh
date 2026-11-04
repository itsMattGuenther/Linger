; Hooks into Tauri CLI v2.12.4's NSIS installer template
; (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), through
; bundle > windows > nsis > installerHooks. Check them against the template
; when updating the Tauri CLI: they rely on PREINSTALL and PREUNINSTALL
; coming just before the template's CheckIfAppIsRunning, PREINSTALL before
; its `File "${MAINBINARYSRCPATH}"` and POSTINSTALL after it, POSTUNINSTALL
; after the uninstaller's own Delete and RMDir, on its $UpdateMode, on
; Win\RestartManager.nsh and ERROR_MORE_DATA (the template's includes), and
; on $R8 and $R9 being free. scripts/tauri-versions.test.mjs fails until the
; version above is the pinned CLI's.
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

; Wait, for up to ten seconds, while anything holds the program open, so the
; template's CheckIfAppIsRunning meets it unheld. Since Tauri CLI 2.12 that
; check asks Windows' Restart Manager which processes hold the program file
; and force-closes every one (tauri-apps/tauri#14479), where 2.11 closed only
; processes named like the program. So Explorer reading its icon, the
; compatibility scanner, or the app still quitting after it started an
; update (tauri-apps/tauri#16277) would be closed, or make the update fail
; with "Failed to kill". Asking Restart Manager the same question first, and
; waiting, leaves the check only a Linger that really is running, which it
; closes as it should (#836). A Restart Manager that can't answer leaves the
; decision to the check.
!macro LINGER_WAIT_WHILE_HELD
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Push $0
    Push $1
    Push $2
    Push $3
    StrCpy $R9 0
    ${Do}
      StrCpy $0 0
      !insertmacro RestartManager_StartSession $R8
      ${If} $R8 != ""
        !insertmacro RestartManager_RegisterFile $R8 "$INSTDIR\${MAINBINARYNAME}.exe"
        ${If} $0 = 0
          System::Call 'RSTRTMGR::RmGetList(p R8, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${EndIf}
        !insertmacro RestartManager_EndSession $R8
      ${EndIf}
      ${If} $0 <> ${ERROR_MORE_DATA}
        ${Break}
      ${EndIf}
      IntOp $R9 $R9 + 1
      ${If} $R9 >= 100
        ${Break}
      ${EndIf}
      Sleep 100
    ${Loop}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LINGER_WAIT_WHILE_HELD
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

; An uninstall waits for a held program before the template's check too: the
; check would close whatever holds it (LINGER_WAIT_WHILE_HELD, above).
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LINGER_WAIT_WHILE_HELD
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
