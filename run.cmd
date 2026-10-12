@echo off
rem cute-pet 启动器
rem 关键：若从 Electron 宿主（如 DSH）里继承到 ELECTRON_RUN_AS_NODE=1，
rem require('electron') 会退化成返回二进制路径字符串，应用直接崩。
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
"%~dp0node_modules\.bin\electron.cmd" . %*
