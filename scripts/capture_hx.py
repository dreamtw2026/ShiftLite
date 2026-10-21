# -*- coding: utf-8 -*-
"""PrintWindow 捕获 Excel 客户区（不受前台其他窗口/弹窗遮挡影响）。

用法：python capture_hx.py <输出.mp4> [时长秒=23]
必须先存在打开的 "xx - Excel" 窗口。每帧 PrintWindow(PW_CLIENTONLY|
PW_RENDERFULLCONTENT) 取客户区 BGRA，经 rawvideo 流式交给 ffmpeg 编码。
"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys
import time

OUT = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 23.0

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

user32.SetProcessDPIAware()
PW_CLIENTONLY = 0x01
PW_RENDERFULLCONTENT = 0x02


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]


@ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
def enum_cb(hwnd, lparam):
    if user32.IsWindowVisible(hwnd):
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if buf.value.strip().endswith("Excel"):
            found.append(hwnd)
    return True


found = []
user32.EnumWindows(enum_cb, 0)
if not found:
    print("capture_hx: 未找到 Excel 窗口", flush=True)
    sys.exit(1)
hwnd = found[0]

rc = wt.RECT()
user32.GetClientRect(hwnd, ctypes.byref(rc))
W, H = rc.right - rc.left, rc.bottom - rc.top
W -= W % 2
H -= H % 2
print(f"capture_hx: hwnd={hwnd:#x} client={W}x{H}", flush=True)

FF = ("C:\\Users\\He-TW\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\"
      "site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe")
args = [FF, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", "30",
        "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-t", f"{DUR:.1f}", OUT]
proc = subprocess.Popen(args, stdin=subprocess.PIPE)

hdc = user32.GetWindowDC(hwnd)
hmem = gdi32.CreateCompatibleDC(hdc)
bi = BITMAPINFO()
bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.bmiHeader.biWidth = W
bi.bmiHeader.biHeight = -H
bi.bmiHeader.biPlanes = 1
bi.bmiHeader.biBitCount = 32
bi.bmiHeader.biCompression = 0
pv = ctypes.c_void_p()
hbmp = gdi32.CreateDIBSection(None, ctypes.byref(bi), 0, ctypes.byref(pv), None, 0)
gdi32.SelectObject(hmem, hbmp)
frame = ctypes.create_string_buffer(W * H * 4)

interval = 1.0 / 30.0
t0 = time.perf_counter()
n_frames = int(DUR * 30)
for i in range(n_frames):
    deadline = t0 + (i + 1) * interval
    user32.PrintWindow(hwnd, hmem, PW_CLIENTONLY | PW_RENDERFULLCONTENT)
    ctypes.memmove(frame, pv, W * H * 4)
    try:
        proc.stdin.write(frame.raw)
    except OSError:
        print("capture_hx: ffmpeg stdin 已关闭，提前结束", flush=True)
        break
    delay = deadline - time.perf_counter()
    if delay > 0:
        time.sleep(delay)

try:
    proc.stdin.close()
except OSError:
    pass
proc.wait(timeout=30)
gdi32.DeleteObject(hbmp)
gdi32.DeleteDC(hmem)
user32.ReleaseDC(hwnd, hdc)
print(f"capture_hx: 完成 {OUT} rc={proc.returncode}", flush=True)
