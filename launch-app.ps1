# Generic smart launcher for workbench shortcut buttons.
# - Target not running -> start it (exe or lnk).
# - Target running    -> bring its main window to the foreground:
#     * restore ONLY if minimized (IsIconic), so maximized windows stay
#       maximized (unconditional SW_RESTORE used to shrink them). If the
#       pre-activation restore gets dropped, retry it after activation;
#     * synthesize an ALT keypress AROUND SetForegroundWindow -- the
#       Windows foreground lock refuses focus changes from background
#       processes (we are spawned by the node server while the click
#       happened in the browser) unless our thread synthesized the last
#       input event, so the call order matters;
#     * success = target is foreground AND not minimized; otherwise retry
#       once with WScript AppActivate;
#     * if activation still fails (typical: minimized to tray, no window
#       handle to raise), relaunch the target once -- single-instance
#       apps (Obsidian / TickTick / Zotero / Anki ...) bring their own
#       window back up on a second launch. Pass -NoRelaunch to opt out
#       for multi-instance apps that would open a duplicate (SM18).
# Called by workbench shortcut buttons:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launch-app.ps1 "<target path>" [-NoRelaunch]
# IMPORTANT: keep this file pure ASCII. The target path (which may contain
# non-ASCII characters) is passed as a command-line argument, so this
# script itself needs no non-ASCII bytes.

param([string]$Target = '', [switch]$NoRelaunch)

if (-not $Target) { exit 1 }

$ErrorActionPreference = 'SilentlyContinue'

# Resolve the real executable for .lnk shortcuts (needed for process detection).
$real = $Target
if ($Target -like '*.lnk') {
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($Target)
    if ($s.TargetPath) { $real = $s.TargetPath }
}

# P/Invoke helpers. Compiled once into %TEMP% and cached across runs:
# Add-Type from source costs ~0.5 s on every click (visable lag), loading
# the cached DLL is nearly free. QUIRK: the .NET loader CACHES failed
# LoadFrom results per path -- if LoadFrom($dll) threw once (cache file
# deleted), a later LoadFrom($dll) fails again even after the file is
# recreated. So we always compile to a private $PID-suffixed path, load
# THAT (never failed before), and only then publish it as the shared DLL.
function Load-WBWin32 {
    $dll = Join-Path $env:TEMP 'workbench-wbwin32.dll'
    if (Test-Path $dll) {
        try { return [Reflection.Assembly]::LoadFrom($dll) } catch { }
    }
    $src = @'
using System;
using System.Runtime.InteropServices;
public static class WBWin32 {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
    $tmp = Join-Path $env:TEMP ("workbench-wbwin32-$PID.dll")
    Add-Type -TypeDefinition $src -OutputAssembly $tmp
    $asm = [Reflection.Assembly]::LoadFrom($tmp)
    try { Move-Item -Force $tmp $dll } catch { }
    return $asm
}

if ($real -like '*.exe') {
    $procName = [System.IO.Path]::GetFileNameWithoutExtension($real)
    # Suffix wildcard match: the real process name may carry extra suffixes
    # (e.g. Reasonix.exe runs as "reasonix-desktop"), which an exact-name
    # match would miss and then wrongly relaunch a running app.
    $procPattern = $procName + '*'
    # Prefer the process that actually owns a main window (multi-process apps).
    $p = Get-Process -Name $procPattern -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    if (-not $p) {
        $p = Get-Process -Name $procPattern -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($p) {
        $h = [IntPtr]$p.MainWindowHandle
        if ($h -ne [IntPtr]::Zero) {
            $null = Load-WBWin32
            # SW_RESTORE = 9 only when minimized (unconditional restore would
            # un-maximize maximized windows). Synchronous ShowWindow: the
            # async variant was observed to leave the window activated but
            # still minimized.
            if ([WBWin32]::IsIconic($h)) {
                [WBWin32]::ShowWindow($h, 9) | Out-Null
            }
            # Foreground-lock workaround: synthesize an ALT press AROUND the
            # call so this thread counts as "received the last input event".
            [WBWin32]::keybd_event(0x12, 0x38, 0, [UIntPtr]::Zero)
            $fw = [WBWin32]::SetForegroundWindow($h)
            [WBWin32]::keybd_event(0x12, 0x38, 2, [UIntPtr]::Zero)
            # Trust the API verdict: if the grant succeeded we are done, even
            # if the user types afterwards and takes focus back -- we must
            # NOT relaunch in that case (would open duplicate windows).
            if ($fw -or ([WBWin32]::GetForegroundWindow() -eq $h)) { exit 0 }
            # Rare: pre-activation restore dropped while minimized -> retry
            # the restore once AFTER activation.
            if ([WBWin32]::IsIconic($h)) {
                [WBWin32]::ShowWindow($h, 9) | Out-Null
                if ([WBWin32]::SetForegroundWindow($h)) { exit 0 }
            }
            # Second chance: WScript AppActivate uses its own activation
            # path and occasionally succeeds where SFW was refused.
            $w = New-Object -ComObject WScript.Shell
            try { $null = $w.SendKeys('%') } catch { }
            if ($w.AppActivate($p.Id)) { exit 0 }
        }
        # No window handle to raise (typical: minimized to tray) or all
        # activation attempts failed. Relaunch once: single-instance apps
        # (Obsidian / TickTick / Zotero / Anki ...) surface their existing
        # window on a second launch. -NoRelaunch opts out (multi-instance).
        if (-not $NoRelaunch) {
            Start-Process -FilePath $Target
            exit 0
        }
        exit 0
    }
}

# Not running: start the target (exe or lnk).
Start-Process -FilePath $Target
exit 0
