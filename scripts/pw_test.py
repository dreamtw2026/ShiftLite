# -*- coding: utf-8 -*-
"""PrintWindow 单帧验证：从 Excel 窗口提取客户区内容（不受前台遮挡影响）。"""
import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

user32.SetProcessDPIAware()
PW_CLIENTONLY = 0x01
PW_RENDERFULLCONTENT = 0x02
HWND_EXCLUDE = None

target = None
found = []


@ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
def enum_cb(hwnd, lparam):
    if user32.IsWindowVisible(hwnd):
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        t = buf.value
        if t.strip().endswith("Excel"):
            found.append((hwnd, t))
    return True


user32.EnumWindows(enum_cb, 0)
if not found:
    print("NO EXCEL WINDOW")
    sys.exit(1)

hwnd, title = found[0]
print(f"找到: {title}")

rc = wt.RECT()
user32.GetClientRect(hwnd, ctypes.byref(rc))
W, H = rc.right - rc.left, rc.bottom - rc.top
W -= W % 2
H -= H % 2
print(f"client: {W}x{H}")

hdc = user32.GetWindowDC(hwnd)
hmem = gdi32.CreateCompatibleDC(hdc)
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]

bi = BITMAPINFO()
bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.bmiHeader.biWidth = W
bi.bmiHeader.biHeight = -H      # top-down
bi.bmiHeader.biPlanes = 1
bi.bmiHeader.biBitCount = 32
bi.bmiHeader.biCompression = 0
pv = ctypes.c_void_p()
hbmp = gdi32.CreateDIBSection(None, ctypes.byref(bi), 0, ctypes.byref(pv), None, 0)
gdi32.SelectObject(hmem, hbmp)
ok = user32.PrintWindow(hwnd, hmem, PW_CLIENTONLY | PW_RENDERFULLCONTENT)
print(f"PrintWindow ok={ok}")
buf = ctypes.create_string_buffer(W * H * 4)
ctypes.memmove(buf, pv, W * H * 4)

import subprocess
FF = ("C:\\Users\\He-TW\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\"
      "site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe")
out = sys.argv[1] if len(sys.argv) > 1 else "hx_test.png"
p = subprocess.run([FF, "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", "1",
                    "-i", "-", "-frames:v", "1", out], input=buf.raw)
print("png:", p.returncode)
