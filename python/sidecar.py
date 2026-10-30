"""尚搏 Agent 的 Python 边车进程（预留通道）。

主进程与边车之间只走一条协议：
    请求（stdin，一行 JSON）： {"id": 1, "method": "ping", "params": {...}}
    响应（stdout，一行 JSON）： {"id": 1, "result": {...}}
                              {"id": 1, "error": "错误信息", "traceback": "..."}

当前只实现 ping，用于验证通道连通性。后续的复杂文档解析、本地向量化、
本地模型推理都会作为新的 method 追加在这里，协议本身不需要改动。
"""

import json
import sys
import traceback


def handle(method: str, params: dict) -> dict:
    if method == "ping":
        return {
            "pong": True,
            "python": sys.version.split()[0],
            "executable": sys.executable,
        }
    if method == "parse_document":
        return parse_document(params.get("path", ""))
    raise ValueError(f"未知方法: {method}")


def parse_document(path: str) -> dict:
    """Word/表格转 HTML（右侧查看器用）：只保留内容结构，不保精确排版。"""
    import html as html_lib
    import os

    if not path or not os.path.isfile(path):
        raise ValueError(f"文件不存在: {path}")
    ext = os.path.splitext(path)[1].lower()
    truncated = False

    if ext == ".docx":
        try:
            from docx import Document
        except ImportError:
            raise ValueError("缺少 python-docx，请执行 pip install python-docx")
        doc = Document(path)
        parts: list[str] = []
        # 表格上限：防超大文档打爆内存
        count = 0
        for block in doc.element.body.iterchildren():
            if count > 2000:
                truncated = True
                break
            tag = block.tag.split("}")[-1]
            if tag == "p":
                text = "".join(n.text or "" for n in block.iter() if n.tag.endswith("}t"))
                if text.strip():
                    parts.append(f"<p>{html_lib.escape(text)}</p>")
                    count += 1
            elif tag == "tbl":
                rows = []
                for tr in block.iter():
                    if not tr.tag.endswith("}tr"):
                        continue
                    cells = [
                        html_lib.escape("".join(n.text or "" for n in tc.iter() if n.tag.endswith("}t")))
                        for tc in tr.iter()
                        if tc.tag.endswith("}tc")
                    ]
                    if cells:
                        rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
                    if len(rows) >= 200:
                        truncated = True
                        break
                if rows:
                    parts.append("<table>" + "".join(rows) + "</table>")
                    count += len(rows)
        return {"html": "".join(parts) or "<p>（空文档）</p>", "truncated": truncated}

    if ext in (".xlsx", ".xls", ".csv"):
        try:
            import openpyxl
        except ImportError:
            raise ValueError("缺少 openpyxl，请执行 pip install openpyxl")
        if ext == ".csv":
            import csv

            rows: list[list[str]] = []
            with open(path, newline="", encoding="utf-8-sig") as f:
                for i, row in enumerate(csv.reader(f)):
                    if i >= 500:
                        truncated = True
                        break
                    rows.append(row[:50])
            sheets = [("CSV", rows)]
        else:
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
            sheets = []
            for ws in wb.worksheets[:10]:
                rows = []
                for i, row in enumerate(ws.iter_rows(values_only=True)):
                    if i >= 500:
                        truncated = True
                        break
                    rows.append([(("" if v is None else str(v))[:200] for v in list(row)[:50]])
                sheets.append((ws.title, rows))
            if len(wb.worksheets) > 10:
                truncated = True
        parts = []
        for title, rows in sheets:
            parts.append(f"<h3>{html_lib.escape(str(title))}</h3>")
            if not rows:
                parts.append("<p>（空表）</p>")
                continue
            parts.append(
                "<table>"
                + "".join(
                    "<tr>" + "".join(f"<td>{html_lib.escape(c)}</td>" for c in r) + "</tr>"
                    for r in rows
                )
                + "</table>"
            )
        return {"html": "".join(parts), "truncated": truncated}

    raise ValueError(f"不支持的文档类型: {ext}")


def main() -> None:
    # 确保中文输出不被终端编码破坏
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            print(
                json.dumps({"id": None, "error": f"请求不是合法 JSON: {exc}"}, ensure_ascii=False),
                flush=True,
            )
            continue

        request_id = request.get("id")
        try:
            result = handle(request.get("method", ""), request.get("params") or {})
            payload = {"id": request_id, "result": result}
        except Exception as exc:  # noqa: BLE001 - 边车必须把任何异常转成响应而不是崩溃
            payload = {
                "id": request_id,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }

        print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()