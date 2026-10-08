# -*- coding: utf-8 -*-
"""screen_ocr.py —— 屏幕字幕识别（框一块固定区域，实时认字）

用途：抖音不给下载 → 那就**直接在电脑上看**，本工具盯着屏幕上字幕那一块，
边播边认，播完文案就有了。**不需要视频文件、不需要下载。**

用法：
    python screen_ocr.py                  # 用上次区域开始识别（在控制台按回车停止）
    python screen_ocr.py --pick           # 重新框选区域（拖一个框）
    python screen_ocr.py --once           # 只认一次（先验证区域框对没）
    python screen_ocr.py --duration 600   # 最多识别 10 分钟，自动停
    python screen_ocr.py --interval 0.6   # 每 0.6 秒抓一次
    python screen_ocr.py --scale 2        # 区域放大 2 倍再认（字小的时候用）

区域存：同目录 screen_region.txt （一行 x1,y1,x2,y2，屏幕物理像素）

设计要点：
    - 抓屏用 PIL.ImageGrab（Windows 原生）；识别用 easyocr（中文模型已本地缓存）
    - 进程设为 DPI 感知，保证「框选坐标」与「抓屏坐标」一致（缩放屏不会错位）
    - 行级去重（与最近若干行比对），同一句字幕停留多帧不会重复
    - 全程 UTF-8 无 BOM
"""
import argparse
import io
import os
import re
import sys
import threading
import time
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.abspath(__file__))
GUAN = os.path.dirname(HERE)                                  # ...\副官脚本
OUT_DIR = os.path.join(GUAN, '输出', '屏幕字幕')
REGION_FILE = os.path.join(HERE, 'screen_region.txt')

# 平台水印/UI 噪音
WM_PAT = re.compile(
    r'^\s*(抖音|快手|小红书|视频号|哔哩哔哩|bilibili|TikTok|剪映|西瓜视频)'
    r'\s*(号)?\s*[:：]?\s*[A-Za-z0-9_\-]*\s*$', re.I)


def log(msg):
    """写日志：有控制台就写 stderr；pythonw 下 stderr 是 None → 退化为写日志文件"""
    line = str(msg) + '\n'
    try:
        if sys.stderr is not None:
            sys.stderr.write(line)
            sys.stderr.flush()
            return
    except Exception:
        pass
    try:
        with io.open(os.path.join(HERE, 'screen_ocr.log'), 'a', encoding='utf-8') as f:
            f.write(time.strftime('%H:%M:%S ') + line)
    except Exception:
        pass


def set_dpi_aware():
    """让进程 DPI 感知：框选坐标 = 抓屏坐标（否则缩放屏会整体错位）"""
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PER_MONITOR_AWARE
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def norm(s):
    return re.sub(r"""[\s，。、！？!?,.:;；：'"“”‘’()（）\-—_·|]+""", '', s or '')


def similar(a, b):
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if len(na) >= 4 and (na in nb or nb in na):
        return 0.95
    return SequenceMatcher(None, na, nb).ratio()


def is_noise(t):
    n = norm(t)
    if len(n) < 2:
        return True
    if re.fullmatch(r'[0-9:.\-—/年月日秒分]+', n):
        return True
    if WM_PAT.match(t or ''):
        return True
    return False


# ─────────────────────────── 区域框选 ───────────────────────────
def detect_region(reader, shot=None):
    """自动猜「字幕区域」：抓屏 → 检测所有文字框 → 聚成横向带 → 返回建议区域

    思路：字幕通常是一条**横向的长条**（若干行字、跨度宽、位于中下部），
    所以把检测到的文字框按纵向聚成"带"，挑覆盖宽度最大、位置最像字幕的那条。
    返回 (x1, y1, x2, y2)，找不到返回 None。
    """
    from PIL import ImageGrab
    import cv2
    import numpy as np

    img = shot or ImageGrab.grab()
    arr = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2BGR)
    H, W = arr.shape[:2]

    boxes = []
    try:
        horiz, free = reader.detect(arr, min_size=8)
        for x_min, x_max, y_min, y_max in (horiz[0] if horiz and horiz[0] else []):
            boxes.append((int(x_min), int(y_min), int(x_max), int(y_max)))
        for poly in (free[0] if free else []):
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            boxes.append((int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))))
    except Exception as e:
        log('[预选] 文字检测失败: {}'.format(e))

    # 只留"像一行字"的框
    cand = []
    for (x1, y1, x2, y2) in boxes:
        w, h = x2 - x1, y2 - y1
        if h < 8 or h > 140 or w <= 0:
            continue
        if w / float(h) < 2.0:
            continue
        cand.append((x1, y1, x2, y2))
    if not cand:
        log('[预选] 没检测到像字幕的文字')
        return None

    cand.sort(key=lambda b: (b[1] + b[3]) / 2.0)

    # 关键：聚类阈值必须用「固定的」中位文字高度，不能用"带子当前高度"——
    # 否则带子越高阈值越大 → 越聚越多 → 最后把满屏文字串成一大坨（链式合并失控）。
    heights = sorted(b[3] - b[1] for b in cand)
    med_h = heights[len(heights) // 2]
    tol = max(1.6 * med_h, 16)

    bands = []
    for b in cand:
        cy = (b[1] + b[3]) / 2.0
        hit = None
        for band in bands:
            if abs(cy - band['cy']) <= tol:      # ← 固定阈值
                hit = band
                break
        if hit is None:
            bands.append({'boxes': [b], 'x1': b[0], 'x2': b[2], 'y1': b[1], 'y2': b[3],
                          'cy': cy, 'h': b[3] - b[1]})
        else:
            hit['boxes'].append(b)
            ys = [q[1] for q in hit['boxes']] + [q[3] for q in hit['boxes']]
            xs = [q[0] for q in hit['boxes']] + [q[2] for q in hit['boxes']]
            hit['x1'], hit['x2'] = min(xs), max(xs)
            hit['y1'], hit['y2'] = min(ys), max(ys)
            hit['h'] = hit['y2'] - hit['y1']
            hit['cy'] = (hit['y1'] + hit['y2']) / 2.0

    # 字幕一定是"细长横条"：太高的带子直接淘汰（挡住上面那个失控 bug 的产物）
    max_band_h = max(0.30 * H, 4 * med_h)
    bands = [b for b in bands if b['h'] <= max_band_h and (b['x2'] - b['x1']) >= 60]
    if not bands:
        log('[预选] 没有找到符合"细长横条"特征的字幕区')
        return None

    def score(band):
        width = band['x2'] - band['x1']
        n = len(band['boxes'])
        rel = band['cy'] / float(H)
        pos = 1.35 if 0.32 <= rel <= 0.92 else 1.0        # 中下部更像字幕
        size = 1.0 + min(1.0, band['h'] / float(max(med_h, 1))) * 0.4   # 字大一点更像字幕
        return width * (1 + 0.25 * (n - 1)) * pos * size

    best = max(bands, key=score)
    pad_x, pad_y = 14, 10
    x1 = max(0, best['x1'] - pad_x)
    x2 = min(W, best['x2'] + pad_x)
    y1 = max(0, best['y1'] - pad_y)
    y2 = min(H, best['y2'] + pad_y)
    if x2 - x1 < 40 or y2 - y1 < 14:
        return None
    # 兜底：占屏面积过半 → 明显不是字幕，判失败（让长官手拖或先把视频画面开出来）
    if (x2 - x1) * (y2 - y1) > 0.55 * W * H:
        log('[预选] 候选区域过大（占屏 {}%），判为不可靠'.format(
            int(100 * (x2 - x1) * (y2 - y1) / float(W * H))))
        return None
    log('[预选] 建议区域: ({}, {}, {}, {})  来自 {} 个文字框（中位字高 {}px）'.format(
        x1, y1, x2, y2, len(best['boxes']), med_h))
    return (x1, y1, x2, y2)


def pick_region(initial=None, parent=None):
    """半透明覆盖层：直接在长官"真实的画面"上拖框。

    为什么不用"冻结截图"方案：截图必须先把屏幕拍下来再由 tkinter 显示，
    一旦渲染/缩放出问题就是一整片白，长官根本不知道自己在框什么。
    半透明覆盖层不需要显示任何图片 —— 你看到的就是实时屏幕，拖框即可。

    ⚠️ 必须传 parent（主界面窗口）：一个进程里**不能有两个 tk.Tk() 根窗口**，
    否则第二个销毁后主界面会被搞坏/消失（表现为"闪退"）。
    initial 给定时先画好（自动预选），按回车确认。
    """
    import tkinter as tk

    result = {}
    own_root = parent is None
    root = tk.Tk() if own_root else tk.Toplevel(parent)
    root.title('拖框选字幕区域')
    root.attributes('-fullscreen', True)
    root.attributes('-topmost', True)
    try:
        root.attributes('-alpha', 0.30)          # 半透明：仍看得见自己的画面
    except Exception:
        pass
    root.configure(bg='#0d0d0d')
    canvas = tk.Canvas(root, bg='#0d0d0d', highlightthickness=0, cursor='crosshair')
    canvas.pack(fill='both', expand=True)

    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()

    hint = ('已自动预选 → 按【回车】确认；不对就重新拖一个框。Esc 取消'
            if initial else '拖一个框，把「字幕」框住 → 松开即确认（Esc 取消）')
    canvas.create_text(sw // 2, 56, text=hint, fill='#00ff88',
                       font=('Microsoft YaHei', 22, 'bold'))
    canvas.create_text(sw // 2, 100,
                       text='注意：画面上要有字幕（视频暂停在带字幕那一帧），工具才认得到',
                       fill='#ffd54f', font=('Microsoft YaHei', 13))

    state = {'x0': 0, 'y0': 0, 'rect': None}
    if initial:
        x1, y1, x2, y2 = initial
        state['rect'] = canvas.create_rectangle(x1, y1, x2, y2, outline='#ff2222', width=4)
        result['box'] = (x1, y1, x2, y2)

    def on_press(e):
        state['x0'], state['y0'] = e.x, e.y
        if state['rect']:
            canvas.delete(state['rect'])
        state['rect'] = canvas.create_rectangle(e.x, e.y, e.x, e.y, outline='#ff2222', width=4)
        result.pop('box', None)

    def on_drag(e):
        if state['rect']:
            canvas.coords(state['rect'], state['x0'], state['y0'], e.x, e.y)

    def on_release(e):
        x1, x2 = sorted((state['x0'], e.x))
        y1, y2 = sorted((state['y0'], e.y))
        if x2 - x1 < 20 or y2 - y1 < 12:
            log('[框选] 框太小，重新拖大一点的')
            return
        result['box'] = (x1, y1, x2, y2)
        root.destroy()

    def on_enter(e=None):
        if result.get('box'):
            root.destroy()
        else:
            log('[框选] 还没框，先拖一个框')

    def on_cancel(e=None):
        result.clear()
        root.destroy()

    canvas.bind('<ButtonPress-1>', on_press)
    canvas.bind('<B1-Motion>', on_drag)
    canvas.bind('<ButtonRelease-1>', on_release)
    root.bind('<Return>', on_enter)
    root.bind('<Escape>', on_cancel)
    root.focus_force()
    if own_root:
        root.mainloop()
    else:
        parent.wait_window(root)      # 子窗口：等它关闭即可，不新开主循环

    return result.get('box')


def save_region(box):
    with io.open(REGION_FILE, 'w', encoding='utf-8', newline='\n') as f:
        f.write('# 屏幕字幕识别区域（物理像素） x1,y1,x2,y2\n')
        f.write('{},{},{},{}\n'.format(*box))


def load_region():
    try:
        with io.open(REGION_FILE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    nums = [int(x) for x in re.findall(r'\d+', line)][:4]
                    if len(nums) == 4:
                        return tuple(nums)
    except Exception:
        pass
    return None


# ─────────────────────────── 抓屏 + 识别 ───────────────────────────
def grab_region(box, scale=1.0):
    from PIL import ImageGrab
    img = ImageGrab.grab(bbox=box)      # bbox=(x1,y1,x2,y2)
    if scale and scale != 1.0:
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    return img


def accept_conf(conf_value, text, base_conf):
    """按字数动态放宽置信度阈值。

    ⚠️ 两个实测数据（这是本工具最关键的一处经验）：
      1) 合成图（干净背景）：8 字 0.77 → 50 字 0.52 —— 长行天然分低
      2) **真实视频字幕（白字黑描边压在复杂背景上、且经视频压缩）：只有 0.22**
         （2026-09-21 长官实测："跟长官谈一谈分析市场的一些主要的视角" conf=0.22）
    → 所以基准阈值必须低（默认 0.2），再按字数继续放宽，否则真实字幕全被误杀。
    """
    n = len(norm(text))
    eff = max(base_conf * 0.6, base_conf - 0.03 * (n // 10))
    return conf_value >= eff


class PaddleAdapter:
    """把 PaddleOCR 包装成 easyocr 的 readtext 接口，两个引擎可无缝互换。

    为什么用 PaddleOCR（2026-09-21 实测对照，同一条真实字幕）：
        EasyOCR   : "锇们要把眼光放在更多的放在其他市场里面"  ← 首字形近字错（我→锇）
        PaddleOCR : "我们要把眼光放在更多的放在其他市场里面"  ← 全对（PP-OCRv6 中文模型）
    ⚠️ 本机必须 enable_mkldnn=False，否则 paddle 3.x 报
       "ConvertPirAttribute2RuntimeAttribute not support (onednn_instruction.cc)"
    """

    name = 'PaddleOCR'

    def __init__(self):
        from paddleocr import PaddleOCR
        # ⚠️ 关键性能参数：PP-OCRv6 默认是 "medium" 大模型，CPU 单帧要 **4.5 秒**
        #    → 每 0.8 秒认一次的循环会把 CPU 吃满，界面（选择/复制/滚动）全卡死，
        #      看起来像"不识别"（2026-09-21 长官实测反馈）。
        #    换 mobile 轻量模型后 **0.9 秒/帧（快 5 倍）**，同一字幕精度一致。
        self.ocr = PaddleOCR(
            lang='ch',
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name='PP-OCRv5_mobile_det',
            text_recognition_model_name='PP-OCRv5_mobile_rec',
        )

    def readtext(self, img, detail=1, paragraph=False, mag_ratio=1.0):
        import numpy as np
        res = self.ocr.predict(np.asarray(img))
        out = []
        for item in res:
            d = getattr(item, 'json', None)
            data = d.get('res', d) if isinstance(d, dict) else {}
            texts = list(data.get('rec_texts') or [])
            scores = list(data.get('rec_scores') or [])
            polys = data.get('rec_polys')
            if polys is None:
                polys = data.get('dt_polys')
            polys = list(polys) if polys is not None else []
            for i, t in enumerate(texts):
                s = float(scores[i]) if i < len(scores) else 0.0
                if i < len(polys):
                    pts = np.asarray(polys[i]).reshape(-1, 2)
                    bbox = [[float(x), float(y)] for x, y in pts]
                else:
                    bbox = [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
                out.append((bbox, t, s))
        return out


def make_reader(engine='auto'):
    """按优先级创建识别引擎：auto → 优先 PaddleOCR，失败退回 EasyOCR"""
    if engine in ('auto', 'paddle'):
        try:
            r = PaddleAdapter()
            log('[OCR] 使用 PaddleOCR（中文更准）')
            return r, 'paddle'
        except Exception as e:
            if engine == 'paddle':
                raise
            log('[OCR] PaddleOCR 不可用，退回 EasyOCR：{}'.format(str(e)[:120]))
    import easyocr
    log('[OCR] 使用 EasyOCR（加载模型中...）')
    return easyocr.Reader(['ch_sim'], gpu=False, verbose=False), 'easy'


def frame_fp(img, size=(64, 24)):
    """取一个小尺寸灰度指纹，用于判断"画面变没变" """
    import cv2
    import numpy as np
    g = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2GRAY)
    return cv2.resize(g, size)


def same_frame(img, prev, tol=1.5):
    """画面几乎没变 → 字幕不可能变 → 可以跳过这次 OCR（关键性能优化）

    PaddleOCR 在 CPU 上每帧要 1~3 秒；字幕通常停留 1~3 秒，
    不去重的话每 0.8 秒硬认一次，会把 CPU 打满导致界面卡死。
    """
    if prev is None:
        return False
    import numpy as np
    cur = frame_fp(img)
    return float(np.mean(np.abs(cur.astype('int16') - prev.astype('int16')))) < tol


def ocr_pil(reader, img, conf, debug=False):
    """识别一块图像，返回按纵向排好的文字行。

    debug=True 时，把**每一行识别出的原文 + 置信度 + 是否采纳**写进日志，
    方便排查"明明看得到却没认出来"（是置信度被卡？还是检测没框到？）。
    """
    import cv2
    import numpy as np
    arr = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2BGR)
    # mag_ratio=1.5：内部放大再识别 —— 真实视频字幕（压缩+复杂背景）识别质量明显更好
    res = reader.readtext(arr, detail=1, paragraph=False, mag_ratio=1.5)

    if debug:
        hs = [max(1, b[2][1] - b[0][1]) for b, _, _ in res] or [0]
        hs.sort()
        log('[诊断] 共检测到 {} 个文字框，中位框高 {}px，区域尺寸 {}x{}'.format(
            len(res), hs[len(hs) // 2], img.width, img.height))

    items = []
    for bbox, text, c in res:
        t = (text or '').strip()
        n = len(norm(t))
        eff = max(conf * 0.6, conf - 0.03 * (n // 10))
        x1 = int(min(p[0] for p in bbox)); x2 = int(max(p[0] for p in bbox))
        y1 = int(min(p[1] for p in bbox)); y2 = int(max(p[1] for p in bbox))
        if debug:
            why = ''
            if not t:
                why = '空'
            elif is_noise(t):
                why = '噪音/水印/太短'
            elif c < eff:
                why = '置信度 {:.3f} < 需要 {:.3f}'.format(c, eff)
            log('[诊断] conf={:.3f} 需{:.3f} 框{}x{} "{}" {}'.format(
                c, eff, x2 - x1, y2 - y1, t[:40], ('→ 采纳' if not why else '→ 丢弃(' + why + ')')))
        if not t:
            continue
        if c < eff:
            continue
        items.append({'t': t, 'c': c, 'y1': y1, 'y2': y2, 'x1': x1, 'x2': x2,
                      'h': max(1, y2 - y1)})

    items.sort(key=lambda d: d['y1'])

    # ── 折行续行拼接：长字幕折成两行时，第二行常只有 1~3 个字 ──
    # 若某行很短、紧贴在上一行下方、且横向落在上一行范围内 → 拼回上一行
    # （否则那句会以"…同步的抛"结尾，"售"被当成"太短噪音"丢掉，句子就残了）
    # 注意：必须**先拼接、后过滤**，否则单字的续行根本活不到拼接这一步。
    merged = []
    for it in items:
        if merged:
            p = merged[-1]
            short = len(norm(it['t'])) <= 3
            adjacent = (it['y1'] - p['y2']) <= 0.9 * max(p['h'], it['h'])
            inside = it['x1'] >= p['x1'] - 25 and it['x2'] <= p['x2'] + 25
            if short and adjacent and inside:
                p['t'] += it['t']
                p['y2'] = max(p['y2'], it['y2'])
                p['x1'] = min(p['x1'], it['x1'])
                p['x2'] = max(p['x2'], it['x2'])
                continue
        merged.append(dict(it))

    out = []
    for m in merged:
        if is_noise(m['t']):
            if debug:
                log('[诊断] 合并后丢弃（噪音/太短）: "{}"'.format(m['t'][:40]))
            continue
        out.append(m['t'])
    return out


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--pick', action='store_true', help='重新框选区域')
    ap.add_argument('--once', action='store_true', help='只识别一次（验证区域）')
    ap.add_argument('--duration', type=float, default=0, help='最长识别秒数（0=手动停）')
    ap.add_argument('--interval', type=float, default=0.8, help='抓屏间隔秒（默认 0.8）')
    ap.add_argument('--conf', type=float, default=0.01,
                    help='OCR 置信度基准阈值（默认 0.01≈不过滤）。原因：真实视频字幕（白字黑描边）'
                         'easyocr 打分极低（实测 0.019）但文字是对的 → 区域已框死，不该再用置信度筛')
    ap.add_argument('--scale', type=float, default=1.0, help='区域放大倍数（字小时用 2）')
    ap.add_argument('--lang', default='ch_sim')
    ap.add_argument('--out', default='', help='输出 txt 路径')
    ap.add_argument('--no-clip', action='store_true', help='不复制到剪贴板')
    a = ap.parse_args(argv)

    set_dpi_aware()

    box = None
    if not a.pick:
        box = load_region()
    if not box:
        log('[区域] 还没有区域，先框选一次（在弹出的图上拖一个框住字幕的矩形）')
        box = pick_region()
        if not box:
            log('[区域] 已取消')
            return 2
        save_region(box)
        log('[区域] 已保存: {}   (以后直接跑本工具即可，加 --pick 可重选)'.format(box))

    log('[区域] 使用 {}'.format(box))

    import easyocr
    log('[OCR] 加载 EasyOCR 模型（{}）...'.format(a.lang))
    reader = easyocr.Reader([a.lang], gpu=False, verbose=False)

    if a.once:
        lines = ocr_pil(reader, grab_region(box, a.scale), a.conf)
        log('[单次] 认出 {} 行：'.format(len(lines)))
        for t in lines:
            sys.stdout.write(t + '\n')
        return 0

    log('')
    log('=== 开始识别 ===')
    log('现在去播放抖音视频。字幕会被自动收录。')
    log('停止：在本窗口按【回车】（或 Ctrl+C）')
    log('')

    stop = threading.Event()

    def waiter():
        try:
            input()
        except Exception:
            pass
        stop.set()

    t = threading.Thread(target=waiter, daemon=True)
    t.start()

    lines, recent = [], []
    t0 = time.time()
    grabs = 0
    try:
        while not stop.is_set():
            if a.duration and (time.time() - t0) >= a.duration:
                log('[时间到] 达到 --duration 上限，停止')
                break
            try:
                img = grab_region(box, a.scale)
                cur = ocr_pil(reader, img, a.conf)
            except Exception as e:
                log('[警告] 单次抓屏/识别失败（忽略）: {}'.format(e))
                time.sleep(a.interval)
                continue
            grabs += 1
            for tx in cur:
                if any(similar(tx, r) >= 0.85 for r in recent[-15:]):
                    continue
                lines.append(tx)
                recent.append(tx)
                sys.stdout.write(tx + '\n')      # 实时打印
                sys.stdout.flush()
            time.sleep(a.interval)
    except KeyboardInterrupt:
        log('\n[中断] Ctrl+C')

    if not lines:
        log('[结果] 一条都没认到。检查：①区域框住了字幕没有（--pick 重选 / --once 验证）'
            '②字太小就加 --scale 2 ③置信度调低 --conf 0.4')
        return 3

    body = '\n'.join(lines)
    if not a.out:
        os.makedirs(OUT_DIR, exist_ok=True)
        a.out = os.path.join(OUT_DIR, time.strftime('屏幕字幕_%Y%m%d_%H%M%S.txt'))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with io.open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)

    log('')
    log('=== 结束 ===')
    log('抓屏 {} 次，收录 {} 行 / {} 字'.format(grabs, len(lines), len(norm(body))))
    log('已保存: ' + a.out)

    if not a.no_clip:
        try:
            import pyperclip
            pyperclip.copy(body)
            log('已复制到剪贴板，可直接粘给 NC')
        except Exception as e:
            log('[剪贴板] 复制失败: {}'.format(e))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
