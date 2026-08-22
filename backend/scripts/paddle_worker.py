#!/usr/bin/env python3
"""Batch PaddleOCR worker for ocr_calibrate.js.

Reads image paths from argv, prints ONE JSON line per image:
    {"file": "<path>", "texts": [...], "boxes": [[x1,y1,x2,y2], ...]}

Boxes are emitted because reading order is NOT row order on an EC8A: PaddleOCR
returns "ADC", "THREE", "4", "3" for a row whose figure is 3 -- pairing on token
order alone would bind a party to the wrong number. Callers group by box
geometry instead (see services/ec8a_words.js).

Model load costs ~10s (and the FIRST run downloads ~5 model files), so every
path goes through a SINGLE process — the caller must batch, not invoke per
image. Same reason trocr_worker.js exists.

ONEDNN IS DISABLED ON PURPOSE. Paddle 3.3.1 + PaddleOCR 3.7.0 on this CPU
raises, for every image:

    (Unimplemented) ConvertPirAttribute2RuntimeAttribute not support
    [pir::ArrayAttribute<pir::DoubleAttribute>]  ... onednn_instruction.cc

That is the oneDNN path of the new PIR executor, not our input — the images are
plain 1500x2000 JPEGs. Forcing the non-oneDNN kernels costs some speed and
makes it actually run. Re-test before removing.

Lives outside the Node tree deliberately: PaddlePaddle publishes no wheels for
the Homebrew Python 3.14 that this box's login shell resolves, so it runs on
/usr/bin/python3.12 via ~/paddle/venv. Point PADDLE_PY elsewhere to move it.
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# Must be set BEFORE paddle is imported — these are read at library init.
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ.setdefault("FLAGS_call_stack_level", "0")
os.environ.setdefault("GLOG_minloglevel", "2")


def build_ocr():
    """Newer signatures accept the pipeline toggles; older ones reject them."""
    from paddleocr import PaddleOCR

    attempts = [
        dict(
            lang="en",
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        ),
        dict(lang="en", enable_mkldnn=False),
        dict(lang="en"),
    ]
    last = None
    for kwargs in attempts:
        try:
            return PaddleOCR(**kwargs)
        except TypeError as e:
            last = e
            continue
    raise last


def _box(obj):
    """Normalise whatever geometry we get to [x1, y1, x2, y2] ints."""
    try:
        pts = [[float(a), float(b)] for a, b in obj]      # polygon
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
    except Exception:
        try:
            v = [int(float(x)) for x in obj]              # already a box
            return v[:4] if len(v) >= 4 else None
        except Exception:
            return None


def texts_from(res):
    """Return (texts, boxes). PaddleOCR's shape moved between 2.x and 3.x."""
    texts, boxes = [], []
    if res is None:
        return texts, boxes
    for page in res:
        if page is None:
            continue
        got = False
        try:
            if "rec_texts" in page:
                t = list(page["rec_texts"])
                b = None
                for key in ("rec_boxes", "rec_polys", "dt_polys"):
                    try:
                        if key in page and page[key] is not None:
                            b = list(page[key])
                            break
                    except TypeError:
                        pass
                for i, txt in enumerate(t):
                    texts.append(str(txt))
                    boxes.append(_box(b[i]) if b is not None and i < len(b) else None)
                got = True
        except TypeError:
            pass
        if got:
            continue
        if isinstance(page, (list, tuple)):              # 2.x: [[box, (text, score)], ...]
            for line in page:
                if isinstance(line, (list, tuple)) and len(line) >= 2:
                    t = line[1]
                    texts.append(str(t[0]) if isinstance(t, (list, tuple)) else str(t))
                    boxes.append(_box(line[0]))
    return texts, boxes


def main():
    paths = sys.argv[1:]
    if not paths:
        return
    try:
        ocr = build_ocr()
    except Exception as e:  # import/model failure is fatal for the whole batch
        print(json.dumps({"fatal": str(e)[:300]}), flush=True)
        sys.exit(1)

    for p in paths:
        try:
            res = ocr.predict(p) if hasattr(ocr, "predict") else ocr.ocr(p)
            texts, boxes = texts_from(res)
            print(json.dumps({"file": p, "texts": texts, "boxes": boxes}), flush=True)
        except Exception as e:
            print(json.dumps({"file": p, "error": str(e)[:200]}), flush=True)


main()
