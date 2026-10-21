# 录制片头“真实 Excel 手工排班”素材。
# 流程：
#   1. 用真实 Excel 打开 scripts/output/intro_排班表.xlsx（全屏）
#   2. ffmpeg gdigrab 逐帧桌面录屏（真实窗口内容）
#   3. COM 自动化在 Excel 中做真实操作：切换工作表、逐格选中、滚动查看
#   4. 输出 scripts/output/recordings/intro_excel.mp4
# 注意：仅在本机交互桌面会话中运行。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$proj = "C:\Users\He-TW\Downloads\Project\claude code\shiftlite"
$ffmpeg = "C:\Users\He-TW\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
$xlsx = "$proj\scripts\output\intro_排班表.xlsx"
$outDir = "$proj\scripts\output\recordings"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = "$outDir\intro_excel.mp4"

# 1) 打开 Excel（真实应用）
$excelPath = "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"
if (-not (Test-Path $excelPath)) {
    $excelPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe' -ErrorAction SilentlyContinue).'(default)'
}
if (-not (Test-Path $excelPath)) { throw "未找到 EXCEL.EXE" }
Start-Process $excelPath -ArgumentList "`"$xlsx`" /r"
Start-Sleep -Seconds 6

# 新建/附加 COM 实例（不依赖 ROT；#/r 打开文件）
try {
    $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
} catch {
    $excel = New-Object -ComObject Excel.Application
    $excel.Workbooks.Open($xlsx) | Out-Null
}
$excel.Visible = $true
$excel.WindowState = -4137   # xlMaximized
Start-Sleep -Seconds 2

# 2) 计算窗口区域，仅录制 Excel 客户区
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct EXRECT { public int L, T, R, B; }
public struct EXPOINT { public int X, Y; }
public class EXWIN {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out EXRECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref EXPOINT p);
}
"@
[EXWIN]::SetProcessDPIAware() | Out-Null
$proc = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'EXCEL' } | Select-Object -First 1
if (-not $proc) { throw "未找到 Excel 窗口" }
$h = $proc.MainWindowHandle
$rc = New-Object EXRECT
[EXWIN]::GetClientRect($h, [ref]$rc) | Out-Null
$pt = New-Object EXPOINT; $pt.X = 0; $pt.Y = 0
[EXWIN]::ClientToScreen($h, [ref]$pt) | Out-Null
$w = $rc.R - $rc.L; $hgt = $rc.B - $rc.T
$w = $w - ($w % 2); $hgt = $hgt - ($hgt % 2)
Write-Host "capture rect: x=$($pt.X) y=$($pt.Y) w=$w h=$hgt"

# 3) 启动录屏（仅 Excel 客户区，30fps，时长 34 秒）
$cap = Start-Process -FilePath $ffmpeg -ArgumentList @(
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "gdigrab", "-framerate", "30",
    "-offset_x", "$($pt.X)", "-offset_y", "$($pt.Y)", "-video_size", "$(($w))x$(($hgt))",
    "-i", "desktop",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-t", "34", "`"$out`""
) -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 900

# 3) 真实操作序列（COM）
try {
    $wb = $excel.Workbooks | Where-Object { $_.Name -like "*排班表*" } | Select-Object -First 1
    if (-not $wb) { $wb = $excel.Workbooks.Open($xlsx) }
    $ws = $wb.Worksheets.Item("本周排班")
    $ws.Activate()
    $app = $excel
    # 逐格“检查”整行：选中 A1 → 逐格向右看首行冲突
    $app.Goto($ws.Range("A2"), $true);                      Start-Sleep -Milliseconds 2600
    foreach ($cell in @("F7","G7","H7","I7")) {
        $ws.Range($cell).Select();                          Start-Sleep -Milliseconds 900
    }
    foreach ($cell in @("G11","H11")) {                     # 冯婷周六“？”和许阳周六 早班
        $ws.Range($cell).Select();                          Start-Sleep -Milliseconds 1000
    }
    $app.Goto($ws.Range("A12"), $true);                     Start-Sleep -Milliseconds 1400
    # 切到“工时统计(手算)”工作表查看范围
    $wb.Worksheets.Item("工时统计(手算)").Activate();        Start-Sleep -Milliseconds 2200
    foreach ($cell in @("B8","C8","D8")) {
        $excel.ActiveSheet.Range($cell).Select();           Start-Sleep -Milliseconds 1200
    }
    Start-Sleep -Seconds 2
    # 回到排班表收尾
    $wb.Worksheets.Item("本周排班").Activate()
    $app.Goto($ws.Range("A1"), $true)
    Start-Sleep -Seconds 1
}
finally {
    # 4) 等录屏结束并关闭 Excel（不保存）
    try { $cap.WaitForExit(60000) | Out-Null } catch {}
    $excel.DisplayAlerts = $false
    $excel.Quit()
}

if (Test-Path $out) {
    "已录制：$out ($([math]::Round((Get-Item $out).Length/1MB,1)) MB)"
} else {
    throw "录屏输出不存在"
}
