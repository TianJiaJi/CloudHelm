#!/bin/sh
# ---------------------------------------------------------------------------
# 启用仓库级 Git hooks（core.hooksPath 指向版本化的 .githooks/ 目录）
#
# 用法：
#   sh scripts/install-hooks.sh
#
# 说明：core.hooksPath 是本地配置，不会随克隆分发，因此克隆后需要执行一次。
# ---------------------------------------------------------------------------

set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if [ ! -d .githooks ]; then
	echo "✗ 未找到 .githooks 目录，请在仓库根目录执行" >&2
	exit 1
fi

git config --local core.hooksPath .githooks

# 在类 Unix 环境下补齐可执行位；Windows 上失败可忽略
chmod +x .githooks/* 2>/dev/null || true

echo "✓ 已启用仓库级 Git hooks：core.hooksPath=.githooks"
echo "  已生效的 hook："
for hook in .githooks/*; do
	[ -f "$hook" ] || continue
	echo "    - $(basename "$hook")"
done
echo ""
echo "  自检：git config --local --get core.hooksPath"
