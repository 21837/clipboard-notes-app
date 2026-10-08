# -*- coding: utf-8 -*-
"""screen_ocr_service.py —— 供 Electron「功能笔记」调用的字幕识别服务

通信：stdin/stdout 每行一个 JSON（NDJSON），UTF-8
请求（Electron → Python）：
    {"cmd":"ping"}
    {"cmd":"region"}                         查当前区域
    {"cmd":"pick"}                           弹出框选覆盖层，返回 {"ev":"region","box":[...]}
    {"cmd":"start","conf":0.01,"gap":0.3}    开始识别
    {"cmd":"stop"}
    {"cmd":"once","conf":0.01}               单次识别（测试）
    {"cmd":"fix","text":"..."}               大模型纠错
    {"cmd":"exit"}
事件（Python → Electron）：
    {"ev":"ready"}
    {"ev":"started"} / {"ev":"stopped","count":N}
    {"ev":"status","msg":"..."}
    {"ev":"region","box":[x1,y1,x2,y2]|null}
    {"ev":"preview","png":"<base64 PNG>"}
    {"ev":"line","text":"..."}
    {"ev":"result","lines":[...]}
    {"ev":"fixed","ok":true,"text":"..."}
    {"ev":"error","msg":"..."}
"""
import base64
import io
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen_ocr as core            # noqa: E402

# ⚠️ 中文 Windows 下，stdout 被重定向到管道时默认用 GBK 编码 →
#    父进程按 UTF-8 读会 UnicodeDecodeError。必须强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
except Exception:
    pass

STATE = {
    'reader': None, 'engine': '', 'stop': threading.Event(), 'thread': None,
    'lines': [], 'recent': [], 'conf': 0.01, 'gap': 0.3, 'region': None,
}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def ensure_reader():
    if STATE['reader'] is None:
        r, eng = core.make_reader('auto')
        STATE['reader'] = r
        STATE['engine'] = eng
        emit({'ev': 'status', 'msg': '识别引擎：' + ('PaddleOCR' if eng == 'paddle' else 'EasyOCR')})
    return STATE['reader']


def preview_png(img, maxw=760):
    try:
        im = img
        if im.width > maxw:
            im = im.resize((maxw, max(1, int(im.height * maxw / im.width))))
        buf = io.BytesIO()
        im.save(buf, 'PNG')
        return base64.b64encode(buf.getvalue()).decode('ascii')
    except Exception:
        return ''


def worker():
    try:
        reader = ensure_reader()
        region = STATE['region']
        conf = STATE['conf']
        gap = STATE['gap']
        last_fp, skipped = None, 0
        while not STATE['stop'].is_set():
            try:
                img = core.grab_region(region, 1.0)
                if core.same_frame(img, last_fp):
                    skipped += 1
                    if skipped % 8 == 0:
                        emit({'ev': 'preview', 'png': preview_png(img)})
                    time.sleep(0.25)
                    continue
                last_fp = core.frame_fp(img)
                emit({'ev': 'preview', 'png': preview_png(img)})
                cur = core.ocr_pil(reader, img, conf)
            except Exception as e:
                emit({'ev': 'error', 'msg': '抓屏/识别出错（继续尝试）: %s' % e})
                time.sleep(0.5)
                continue
            for t in cur:
                if any(core.similar(t, r) >= 0.85 for r in STATE['recent'][-15:]):
                    continue
                STATE['lines'].append(t)
                STATE['recent'].append(t)
                emit({'ev': 'line', 'text': t})
            time.sleep(gap)
    except Exception as e:
        emit({'ev': 'error', 'msg': str(e)})
    finally:
        emit({'ev': 'stopped', 'count': len(STATE['lines'])})


def handle(req):
    cmd = req.get('cmd')
    if cmd == 'ping':
        emit({'ev': 'pong'})
    elif cmd == 'region':
        emit({'ev': 'region', 'box': core.load_region()})
    elif cmd == 'pick':
        emit({'ev': 'status', 'msg': '请在屏幕上拖框选中字幕区域...'})
        try:
            box = core.pick_region()
        except Exception as e:
            emit({'ev': 'error', 'msg': '框选失败: %s' % e})
            return
        if box:
            core.save_region(box)
        emit({'ev': 'region', 'box': box})
    elif cmd == 'start':
        if STATE['thread'] and STATE['thread'].is_alive():
            emit({'ev': 'status', 'msg': '已在识别中'})
            return
        box = core.load_region()
        if not box:
            emit({'ev': 'error', 'msg': '还没设置识别区域，先点「框选区域」'})
            return
        STATE['region'] = box
        STATE['conf'] = float(req.get('conf', 0.01) or 0.01)
        STATE['gap'] = float(req.get('gap', 0.3) or 0.3)
        STATE['lines'] = []
        STATE['recent'] = []
        STATE['stop'].clear()
        STATE['thread'] = threading.Thread(target=worker, daemon=True)
        STATE['thread'].start()
        emit({'ev': 'started'})
    elif cmd == 'stop':
        STATE['stop'].set()
    elif cmd == 'once':
        box = core.load_region()
        if not box:
            emit({'ev': 'error', 'msg': '还没设置识别区域，先点「框选区域」'})
            return
        try:
            reader = ensure_reader()
            img = core.grab_region(box, 1.0)
            emit({'ev': 'preview', 'png': preview_png(img)})
            lines = core.ocr_pil(reader, img, float(req.get('conf', 0.01) or 0.01))
            emit({'ev': 'result', 'lines': lines})
        except Exception as e:
            emit({'ev': 'error', 'msg': str(e)})
    elif cmd == 'fix':
        try:
            import llm_fix
            ok, res = llm_fix.fix_ocr_text(req.get('text', ''))
            if ok:
                emit({'ev': 'fixed', 'ok': True, 'text': res})
            else:
                emit({'ev': 'fixed', 'ok': False, 'msg': str(res)})
        except Exception as e:
            emit({'ev': 'fixed', 'ok': False, 'msg': str(e)})
    elif cmd == 'exit':
        STATE['stop'].set()
        emit({'ev': 'bye'})
        sys.stdout.flush()
        os._exit(0)
    else:
        emit({'ev': 'error', 'msg': 'unknown cmd: %s' % cmd})


def main():
    emit({'ev': 'ready', 'engine': 'auto'})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:
            emit({'ev': 'error', 'msg': str(e)})


if __name__ == '__main__':
    main()
