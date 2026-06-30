#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
autopilot-switch — Cursor Agents Window「自动续跑」开关（Tkinter 独立小窗）。

一个置顶小窗 + 一个大开关按钮：
  - 点击 OFF→ON：创建信号文件 .autopilot.on，并 spawn `node agents-autopilot.mjs`（无终端窗口）。
  - 点击 ON→OFF：删信号文件（引擎下轮自停）+ 终止引擎进程。
  - 引擎「长期 stop 自动松手」会自己删信号文件 → 本窗每 1.5s 轮询同步按钮回 OFF。

前提：Cursor 带 --remote-debugging-port=9223 + Agents Window 打开 + 选中一个 agent 对话。
用法：python autopilot-switch.py   （或 pythonw 无控制台）
"""
import os
import sys
import subprocess
import tkinter as tk
from pathlib import Path

HERE = Path(__file__).resolve().parent
FLAG = HERE / ".autopilot.on"
ENGINE = HERE / "agents-autopilot.mjs"


class App:
    def __init__(self, root):
        self.root = root
        self.proc = None
        root.title("Cursor 续跑")
        root.geometry("280x160")
        root.attributes("-topmost", True)
        root.resizable(False, False)

        self.btn = tk.Button(
            root, text="● OFF", font=("Segoe UI", 22, "bold"),
            bg="#888888", fg="white", activebackground="#999999",
            relief="flat", command=self.toggle,
        )
        self.btn.pack(fill="both", expand=True, padx=14, pady=(14, 6))

        self.status = tk.Label(root, text="点击开启 · 模拟按住 Enter", font=("Segoe UI", 9), fg="#555")
        self.status.pack(pady=(0, 10))

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.refresh()
        self.poll()

    def is_on(self):
        return FLAG.exists()

    def toggle(self):
        if self.is_on():
            self.stop()
        else:
            self.start()

    def start(self):
        try:
            FLAG.write_text("on", encoding="utf-8")
        except Exception as e:
            self.status.config(text="开启失败: %s" % e)
            return
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            self.proc = subprocess.Popen(
                ["node", str(ENGINE)], cwd=str(HERE), creationflags=flags
            )
        except Exception as e:
            self.status.config(text="引擎启动失败: %s" % e)
            try:
                FLAG.unlink()
            except Exception:
                pass
            return
        self.refresh()

    def stop(self):
        try:
            if FLAG.exists():
                FLAG.unlink()
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass
        self.proc = None
        self.refresh()

    def refresh(self):
        if self.is_on():
            self.btn.config(text="● ON", bg="#2e8b57", activebackground="#3a9e68")
            self.status.config(text="按住 Enter 中…（仅可发送态按 · 点 OFF/关窗 停）", fg="#2e8b57")
        else:
            self.btn.config(text="● OFF", bg="#888888", activebackground="#999999")
            self.status.config(text="点击开启 · 模拟按住 Enter", fg="#555")

    def poll(self):
        # 引擎自停（长期 stop）会删信号文件 → 同步 UI 回 OFF
        self.refresh()
        self.root.after(1500, self.poll)

    def on_close(self):
        # 关窗时若还开着，顺手停掉引擎，避免遗留后台进程
        if self.is_on():
            self.stop()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
