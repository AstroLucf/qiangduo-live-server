#!/bin/sh
# 抖音云 FaaS 运行时固定执行 /opt/application/run.sh 作为启动命令（忽略 Dockerfile CMD），
# 所以入口必须放这里。exec 让 node 接管 PID1、前台常驻。端口取 ENV PORT（Dockerfile 设 8000）。
exec node /opt/application/index.js
