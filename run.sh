#!/bin/sh
# 抖音云 FaaS 运行时固定执行 /opt/application/run.sh 作为启动命令（忽略 Dockerfile CMD）。
# FaaS 期望服务监听 8000（实例日志：restarting user function at port 8000），但它不透传
# Dockerfile 的 ENV，所以这里显式 export PORT=8000，确保 node 监听 8000。exec 让 node 接管 PID1。
export PORT=8000
exec node /opt/application/index.js
