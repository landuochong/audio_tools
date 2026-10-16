#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo '安装 BlackHole 2ch 虚拟麦克风。系统可能会要求输入本机管理员密码。'
brew install --cask blackhole-2ch
echo '安装完成。按安装器提示重启电脑，然后重新启动声间。'
