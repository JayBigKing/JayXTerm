param([int]$X, [int]$Y, [ValidateSet('cancel','drop')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeDragMouse {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
}
'@
$previous = New-Object NativeDragMouse+Point
[NativeDragMouse]::GetCursorPos([ref]$previous) | Out-Null
try {
 [NativeDragMouse]::SetCursorPos($X,$Y) | Out-Null
 [NativeDragMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 Write-Output 'pressed'
 Start-Sleep -Milliseconds 500
 [NativeDragMouse]::SetCursorPos(($X+40),($Y+20)) | Out-Null
 Start-Sleep -Milliseconds 400
 if ($Action -eq 'cancel') {
  [NativeDragMouse]::keybd_event(27,0,0,[UIntPtr]::Zero)
  [NativeDragMouse]::keybd_event(27,0,2,[UIntPtr]::Zero)
 }
} finally {
 [NativeDragMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 100
 [NativeDragMouse]::SetCursorPos($previous.X,$previous.Y) | Out-Null
}
