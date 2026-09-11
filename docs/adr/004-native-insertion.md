# ADR 004: Native insertion before clipboard fallback

Auto-paste already defaults on in upstream settings and can be disabled under
General / Clipboard. Preserve this existing setting and finalized-speech delivery.

Try direct insertion into the currently focused editable field first: Windows
standard Edit controls use EM_REPLACESEL; macOS uses settable AXSelectedText.
Other fields, including browser editors that do not expose this contract, use
the existing native paste shortcut and guarded clipboard restoration. Password
fields are excluded from direct insertion. Helpers receive UTF-8 over stdin,
not shell arguments. No additional transcript logging is introduced.

An explicit unsupported response permits fallback. Timeout or uncertain mutation
must surface an error instead of risking duplicate insertion. Unsupported native
insertion is expected in many apps; clipboard paste remains essential. Native
success leaves every clipboard format intact unless the user explicitly chose
to keep the transcript in the clipboard.
