# Extract the icon(s) embedded in an exe (or a .lnk shortcut's target exe)
# and save them as a multi-size ICO file.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File extract-app-icon.ps1 "<exe or lnk path>" "<out .ico path>"
# Used by the workbench to generate public/icons/*.ico for shortcut buttons.
# Reads the exe's RT_GROUP_ICON / RT_ICON resources directly (LoadLibraryEx +
# FindResource) so the full-color large icon (up to 256x256, PNG or BMP) is
# captured - the same art Windows shows on the desktop. Falls back to
# System.Drawing.Icon.ExtractAssociatedIcon (32x32) when the exe has no icons.
# For .lnk shortcuts the real target is resolved first (no shortcut-arrow overlay).
# IMPORTANT: keep this file pure ASCII.

param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$OutPath
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class ExeIcon {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeLibrary(IntPtr hModule);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindResource(IntPtr hModule, IntPtr lpName, IntPtr lpType);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LockResource(IntPtr hResData);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpType, EnumResNameProc lpEnumFunc, IntPtr lParam);

    public delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);

    public const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    public static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;
    public static readonly IntPtr RT_ICON = (IntPtr)3;

    private static readonly List<IntPtr> _groupNames = new List<IntPtr>();

    private static bool EnumGroup(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam) {
        _groupNames.Add(lpszName);
        return true;
    }

    // Extract every size in the first icon group, largest first, as a multi-size ICO.
    public static bool Extract(string exePath, string outPath) {
        _groupNames.Clear();
        IntPtr hMod = LoadLibraryEx(exePath, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (hMod == IntPtr.Zero) return false;
        try {
            if (!EnumResourceNames(hMod, RT_GROUP_ICON, EnumGroup, IntPtr.Zero) || _groupNames.Count == 0) return false;
            IntPtr hRes = FindResource(hMod, _groupNames[0], RT_GROUP_ICON);
            if (hRes == IntPtr.Zero) return false;
            IntPtr hData = LoadResource(hMod, hRes);
            if (hData == IntPtr.Zero) return false;
            IntPtr pGroup = LockResource(hData);
            if (pGroup == IntPtr.Zero || SizeofResource(hMod, hRes) < 6) return false;

            ushort count = (ushort)Marshal.ReadInt16(pGroup, 4);
            if (count == 0 || count > 64) return false;

            int[] widths = new int[count];
            int[] heights = new int[count];
            ushort[] ids = new ushort[count];
            // GRPICONDIRENTRY = 14 bytes each (no imageOffset; wID at +12)
            for (int i = 0; i < count; i++) {
                int off = 6 + i * 14;
                byte w = Marshal.ReadByte(pGroup, off);
                byte h = Marshal.ReadByte(pGroup, off + 1);
                widths[i] = w == 0 ? 256 : w;
                heights[i] = h == 0 ? 256 : h;
                ids[i] = (ushort)Marshal.ReadInt16(pGroup, off + 12);
            }

            List<Tuple<int, int, byte[]>> imgs = new List<Tuple<int, int, byte[]>>();
            for (int i = 0; i < count; i++) {
                IntPtr hIconRes = FindResource(hMod, (IntPtr)ids[i], RT_ICON);
                if (hIconRes == IntPtr.Zero) continue;
                IntPtr hIconData = LoadResource(hMod, hIconRes);
                IntPtr pIcon = LockResource(hIconData);
                uint sz = SizeofResource(hMod, hIconRes);
                if (pIcon == IntPtr.Zero || sz == 0) continue;
                byte[] buf = new byte[sz];
                Marshal.Copy(pIcon, buf, 0, (int)sz);
                imgs.Add(Tuple.Create(widths[i], heights[i], buf));
            }
            if (imgs.Count == 0) return false;

            // largest first
            imgs.Sort((a, b) => (b.Item1 * b.Item2).CompareTo(a.Item1 * a.Item2));

            using (FileStream fs = File.Create(outPath)) {
                BinaryWriter bw = new BinaryWriter(fs);
                bw.Write((ushort)0);
                bw.Write((ushort)1);
                bw.Write((ushort)imgs.Count);
                int dataOff = 6 + imgs.Count * 16;
                foreach (var img in imgs) {
                    int w = img.Item1 >= 256 ? 0 : img.Item1;
                    int h = img.Item2 >= 256 ? 0 : img.Item2;
                    bw.Write((byte)w);
                    bw.Write((byte)h);
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)32);
                    bw.Write((int)img.Item3.Length);
                    bw.Write((int)dataOff);
                    dataOff += img.Item3.Length;
                }
                foreach (var img in imgs) bw.Write(img.Item3);
            }
            return true;
        } finally {
            FreeLibrary(hMod);
        }
    }
}
"@

$iconSource = $ExePath
if ($ExePath -like '*.lnk') {
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($ExePath)
    if ($s.TargetPath -and [System.IO.File]::Exists($s.TargetPath)) {
        $iconSource = $s.TargetPath
    }
}

function Extract-From([string]$target, [string]$out) {
    if ([ExeIcon]::Extract($target, $out)) { return $true }
    # Target may be locked (e.g. the app is currently running): copy to a temp
    # file and extract from the copy, then retry once.
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Copy-Item -LiteralPath $target -Destination $tmp -Force -ErrorAction Stop
        return [ExeIcon]::Extract($tmp, $out)
    } catch {
        return $false
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

$ok = Extract-From $iconSource $OutPath

if (-not $ok) {
    # Fallback: default 32x32 associated icon
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconSource)
    if (-not $icon) { exit 1 }
    $fs = [System.IO.File]::Create($OutPath)
    $icon.Save($fs)
    $fs.Close()
    $icon.Dispose()
    exit 0
}

exit 0
