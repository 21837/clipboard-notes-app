# -*- coding: utf-8 -*-
"""llm_fix.py —— 用大模型修正 OCR 形近字错误

背景（2026-09-21 实测）：
    easyocr 对「白字+黑描边」的视频字幕会犯形近字错误：
        金→全、『→球、宝→主、黉→英、戳→我、冀→英
    实测能修对的模型：
        ✅ kimi-k3      （4 个错字全修对，数字原样保留）
        ❌ glm-4-flash  （免费但太弱，修不对）
        ❌ glm-4.6 等   （智谱该账号余额不足 1113）

配置读取顺序：环境变量 > llm-config.json > 从 openclaw.json 里取 kimi key（开箱可用）
"""
import io
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, 'llm-config.json')
TERMS_FILE = os.path.join(HERE, '术语表.txt')
OPENCLAW_CFG = os.path.join(os.path.expanduser('~'), '.openclaw', 'openclaw.json')

DEFAULT_BASE = 'https://api.moonshot.cn/v1'
DEFAULT_MODEL = 'kimi-k3'


def load_terms():
    """读术语表：返回 (易错对照[(错,对)], 参考术语[词])"""
    repl, vocab = [], []
    section = ''
    try:
        with io.open(TERMS_FILE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('[') and line.endswith(']'):
                    section = line.strip('[]')
                    continue
                if section == '易错对照' and '→' in line:
                    a, b = line.split('→', 1)
                    a, b = a.strip(), b.strip()
                    if a and b and a != b:
                        repl.append((a, b))
                elif section == '参考术语':
                    vocab.append(line)
    except Exception:
        pass
    return repl, vocab


def apply_terms(text):
    """① 确定性术语替换（不依赖大模型，百分百生效）—— 在调模型之前先跑一遍"""
    repl, _ = load_terms()
    if not repl or not text:
        return text
    for a, b in repl:
        if a in text:
            text = text.replace(a, b)
    return text


def build_sys_prompt():
    """② 把参考术语喂给大模型做词汇提示（让它优先选这些写法）"""
    base = (
        '你是中文 OCR 结果纠错器。输入是视频字幕 OCR 出来的文本，常见错误是形近字，'
        '例如：金→全、『→球、宝→主、黉→英、戳→我、冀→英。\n'
        '规则：\n'
        '1. 只修正明显的字形识别错误；不要改写、润色、增删、翻译\n'
        '2. 数字、小数点、百分号、日期一律保持原样（即使你觉得不合理）\n'
        '3. 保持原来的换行\n'
        '4. 只输出修正后的文本，不加任何解释、不加引号'
    )
    _, vocab = load_terms()
    if vocab:
        base += ('\n\n【该领域常用术语，遇到相近写法请优先采用这些】\n'
                 + '、'.join(vocab[:150]))
    return base


SYS_PROMPT = (  # 兜底用（术语表读不到时）
    '你是中文 OCR 结果纠错器。只修正明显的字形识别错误；数字一律保持原样；'
    '保持换行；只输出修正后的文本。'
)


def load_config():
    cfg = {}
    try:
        with io.open(CONFIG_FILE, encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    base = os.environ.get('LLM_FIX_BASE') or cfg.get('baseUrl') or DEFAULT_BASE
    model = os.environ.get('LLM_FIX_MODEL') or cfg.get('model') or DEFAULT_MODEL
    key = os.environ.get('LLM_FIX_KEY') or cfg.get('apiKey') or ''
    if not key:                       # 兜底：复用 openclaw.json 里的 kimi key（开箱可用）
        try:
            j = json.load(io.open(OPENCLAW_CFG, encoding='utf-8'))
            kimi = (j.get('models', {}).get('providers', {}).get('kimi') or {})
            key = kimi.get('apiKey', '')
            if kimi.get('baseUrl'):
                base = kimi['baseUrl'] + '' if kimi['baseUrl'].endswith('/v1') else base
        except Exception:
            pass
    return {'baseUrl': base.rstrip('/'), 'model': model, 'apiKey': key}


def _post(url, key, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def fix_ocr_text(text, timeout=120):
    """返回 (ok, 结果或错误信息)

    流程：先做确定性术语替换 → 再交给大模型修正形近字（数字保持不变）
    """
    text = apply_terms((text or '').strip())
    if not text:
        return False, '内容为空'
    cfg = load_config()
    if not cfg['apiKey']:
        return False, '没有可用的模型 API Key（可写进 llm-config.json）'
    url = cfg['baseUrl'] + '/chat/completions'
    payload = {
        'model': cfg['model'],
        'messages': [{'role': 'system', 'content': build_sys_prompt()},
                     {'role': 'user', 'content': text}],
        'temperature': 0,
        'stream': False,
    }
    try:
        j = _post(url, cfg['apiKey'], payload, timeout)
    except Exception as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8')[:200]
        except Exception:
            pass
        # kimi 系列只接受 temperature=1
        if 'temperature' in detail:
            payload['temperature'] = 1
            try:
                j = _post(url, cfg['apiKey'], payload, timeout)
            except Exception as e2:
                return False, '调用失败: %s' % str(e2)[:200]
        else:
            return False, '调用失败: %s %s' % (str(e)[:120], detail)
    try:
        out = j['choices'][0]['message']['content'].strip()
    except Exception:
        return False, '返回格式异常'
    if not out:
        return False, '模型返回空内容'
    return True, out
