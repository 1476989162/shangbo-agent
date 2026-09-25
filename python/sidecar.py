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
    raise ValueError(f"未知方法: {method}")


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