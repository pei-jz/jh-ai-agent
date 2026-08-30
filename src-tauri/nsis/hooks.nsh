; Installer hooks: record where the app was installed.
;
; The updater downloads this installer and runs it with /UPDATE and no /D, so it
; always writes to the registered location. A portable copy that took an update
; would leave the new version in the install directory while the copy being run
; stayed as it was -- nothing failing, nothing reported, and the next launch
; still the old build. The app therefore has to know whether it IS the installed
; copy, and this value is how it finds out. See is_installed() in
; src/commands/install.rs.
;
; Comments and strings here are ASCII on purpose. This file is spliced into
; Tauri's installer.nsi and compiled by makensis; an encoding mismatch fails the
; BUILD rather than a test.

!macro NSIS_HOOK_POSTINSTALL
  ; SHCTX follows the install mode the user chose (per-user or per-machine), so
  ; this lands in the same hive as the rest of the install.
  WriteRegStr SHCTX "Software\io.github.pei-jz.jhaiagent" "InstallLocation" "$INSTDIR"
!macroend

; Delete from both hives by name rather than through SHCTX.
;
; SHCTX follows the install mode, and on uninstall it does not reliably come back
; as the hive the value was written to: a per-machine install can leave
; HKLM\Software\io.github.pei-jz.jhaiagent behind after its files are gone. A key
; that outlives the install is worse than untidy -- is_installed() reads it, so a
; portable copy dropped into the old directory would be told it is the installed
; build and offered updates it cannot apply.
;
; Deleting a key that was never there is not an error, so naming both is safe
; whichever mode was used.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\io.github.pei-jz.jhaiagent"
  DeleteRegKey HKLM "Software\io.github.pei-jz.jhaiagent"
!macroend
