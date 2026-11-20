#!/usr/bin/env python3
# lib/ssh_exec.py —— 服务器运维台的 SSH 执行助手（paramiko）。
#
# 为什么是一个外部 Python 进程而不是纯 JS：
#   Node 侧要自己实现 SSH 协议 + 密钥解析成本太高，本机已装 paramiko，
#   子进程还能把「长命令不阻塞宿主事件循环」和「超时可硬杀」一并解决。
#
# 协议：**凭证从 stdin 进**（不出现在进程命令行、不进日志），stdout 输出 NDJSON 事件流：
#   {"t":"begin","pid":...}
#   {"t":"out","d":"..."} / {"t":"err","d":"..."}
#   {"t":"end","code":0,"durationMs":123,"host":"..."}
#   {"t":"fail","kind":"auth|network|hostkey|timeout|exec","message":"..."}
# 事件本身不含凭证；调用方（Node）仍会再脱敏一遍。

import json
import os
import socket
import sys
import time

try:
    import paramiko
except Exception as exc:  # pragma: no cover - 环境问题
    sys.stdout.write(json.dumps({"t": "fail", "kind": "env", "message": "paramiko 不可用: %s" % exc}) + "\n")
    sys.stdout.flush()
    sys.exit(3)

# Windows 控制台默认 GBK：强制 UTF-8，否则中文事件在 Node 侧会变成乱码。
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_request():
    raw = sys.stdin.buffer.read()
    if not raw.strip():
        emit({"t": "fail", "kind": "input", "message": "stdin 没有请求 JSON"})
        sys.exit(4)
    return json.loads(raw.decode("utf-8", "replace"))


def build_client(req):
    client = paramiko.SSHClient()
    policy = req.get("hostKeyPolicy") or "accept-new"
    if policy == "strict":
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    elif policy == "off":
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    else:
        # accept-new 语义：已知主机校验，未知主机自动接受并记住
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    return client


def connect(req, client):
    host = req["host"]
    port = int(req.get("port") or 22)
    user = req["user"]
    timeout = float(req.get("connectTimeoutMs") or 20000) / 1000.0
    kwargs = {
        "hostname": host,
        "port": port,
        "username": user,
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": max(timeout, 30.0),
        "allow_agent": False,
        "look_for_keys": False,
    }
    if req.get("authType") == "key":
        key_file = req.get("keyFile")
        private_key = req.get("privateKey")
        passphrase = req.get("passphrase") or None
        if private_key:
            from io import StringIO
            pkey = None
            for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey, paramiko.DSSKey):
                try:
                    pkey = cls.from_private_key(StringIO(private_key), password=passphrase)
                    break
                except Exception:
                    continue
            if pkey is None:
                raise ValueError("无法解析私钥（格式不支持或 passphrase 错误）")
            kwargs["pkey"] = pkey
        else:
            kwargs["key_filename"] = key_file
            if passphrase:
                kwargs["passphrase"] = passphrase
    else:
        password = req.get("password")
        if not password:
            raise ValueError("缺少密码")
        kwargs["password"] = password
    client.connect(**kwargs)


def remote_hostname(client):
    """
    在同一条已建立的连接上再开一个 channel 取主机名（不额外建连接，约几十毫秒）。

    控制台要把输入行画成真终端的样子（`用户@主机:~#`），主机名只有远端知道；
    拿不到就返回空串，调用方退回用地址显示 —— **不能因为这一步失败就中断命令**。
    """
    try:
        _in, out, _err = client.exec_command("hostname 2>/dev/null || cat /etc/hostname 2>/dev/null", timeout=5)
        name = out.read(256).decode("utf-8", "replace").strip().splitlines()
        return name[0].strip() if name else ""
    except Exception:
        return ""


def classify(exc):
    name = type(exc).__name__
    text = str(exc)
    if isinstance(exc, paramiko.AuthenticationException):
        return "auth", "认证失败（用户名/密码或密钥不被接受）"
    if isinstance(exc, paramiko.BadHostKeyException):
        return "hostkey", "主机密钥与已知记录不一致（可能重装过系统，确认后更新）"
    if isinstance(exc, paramiko.BadAuthenticationType):
        return "auth", "服务器拒绝该认证方式：%s" % text
    if isinstance(exc, (socket.timeout, TimeoutError)) or name == "timeout":
        return "network", "连接超时（地址/端口/防火墙）"
    if isinstance(exc, socket.gaierror):
        return "network", "域名解析失败：%s" % text
    if isinstance(exc, ConnectionRefusedError) or "refused" in text.lower():
        return "network", "端口拒绝连接（服务未开或防火墙）"
    if isinstance(exc, paramiko.ssh_exception.NoValidConnectionsError):
        return "network", "连不上该端口：%s" % text
    if isinstance(exc, ValueError):
        return "input", text
    return "network", "%s: %s" % (name, text)


def run(req):
    command = req.get("command") or "true"
    timeout = float(req.get("timeoutMs") or 120000) / 1000.0
    login_shell = req.get("loginShell", True)
    client = build_client(req)
    started = time.time()
    try:
        connect(req, client)
    except Exception as exc:
        kind, message = classify(exc)
        emit({"t": "fail", "kind": kind, "message": message})
        try:
            client.close()
        except Exception:
            pass
        return 2

    emit({"t": "begin", "host": req["host"], "port": int(req.get("port") or 22), "user": req["user"],
          "hostname": remote_hostname(client)})

    wrapped = "bash -lc %s" % quote(command) if login_shell else command
    try:
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)
        # color=True 时申请 PTY：远端程序（docker/systemctl/ls/git…）只有在 tty 上才会输出颜色。
        # 代价是 stderr 会并进 stdout、换行变 CRLF —— 调用方已知这两点（journal 会去 \r）。
        use_pty = bool(req.get("color", True))
        if use_pty:
            # 环境变量**内联进命令**，不用 exec_command(environment=...)：后者依赖服务端
            # AcceptEnv 白名单，绝大多数机器默认拒收，会静默失效。
            # 同时把分页器钉死成 cat：PTY 下 systemctl/git 会进分页器等按键，非交互场景等于卡死。
            wrapped = (
                "export TERM=xterm-256color COLORTERM=truecolor "
                "PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat MANPAGER=cat LESS=FRX "
                "SYSTEMD_COLORS=1 CLICOLOR_FORCE=1 FORCE_COLOR=1; "
                + wrapped
            )
        stdin, stdout, stderr = client.exec_command(
            wrapped,
            timeout=timeout,
            get_pty=use_pty,
        )
        if use_pty:
            # 让 bash 别以为窗口是 0 列（有些程序会因此不换行）
            try:
                channel = stdout.channel
                channel.resize_pty(width=200, height=50)
            except Exception:
                pass
        channel = stdout.channel
        deadline = started + timeout
        code = None
        while True:
            if channel.recv_ready():
                chunk = channel.recv(65536)
                if chunk:
                    emit({"t": "out", "d": chunk.decode("utf-8", "replace")})
                    continue
            if channel.recv_stderr_ready():
                chunk = channel.recv_stderr(65536)
                if chunk:
                    emit({"t": "err", "d": chunk.decode("utf-8", "replace")})
                    continue
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                code = channel.exit_status
                break
            if time.time() > deadline:
                emit({"t": "fail", "kind": "timeout", "message": "远程命令超过 %d 秒未结束，已中断" % int(timeout)})
                try:
                    channel.close()
                except Exception:
                    pass
                code = 124
                break
            time.sleep(0.03)
        # 收尾把缓冲区读干净
        while channel.recv_ready():
            emit({"t": "out", "d": channel.recv(65536).decode("utf-8", "replace")})
        while channel.recv_stderr_ready():
            emit({"t": "err", "d": channel.recv_stderr(65536).decode("utf-8", "replace")})
        emit({"t": "end", "code": int(code if code is not None else 0), "durationMs": int((time.time() - started) * 1000)})
        return 0
    except Exception as exc:
        kind, message = classify(exc)
        emit({"t": "fail", "kind": kind, "message": message})
        return 2
    finally:
        try:
            client.close()
        except Exception:
            pass


def quote(text):
    return "'" + str(text).replace("'", "'\\''") + "'"


if __name__ == "__main__":
    try:
        req = load_request()
    except Exception as exc:
        emit({"t": "fail", "kind": "input", "message": "请求 JSON 解析失败: %s" % exc})
        sys.exit(4)
    sys.exit(run(req))
