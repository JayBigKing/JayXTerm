#!/bin/bash
# tun-guard: TUN 关闭时用 hosts 屏蔽域名，TUN 开启时自动解除
# 事件驱动：读取内核路由套接字（route -n monitor），网卡创建/地址分配/路由变化时立即同步；
# 无事件时每 FALLBACK_SECS 秒兜底同步一次（顺带发现域名清单的改动）。
# 支持任意多个域名：编辑 /usr/local/etc/tun-guard.domains，一行一个。
set -u

CONF=/usr/local/etc/tun-guard.domains   # 域名清单：一行一个，# 开头为注释
TUN_IPS="198.18.0.1 28.0.0.1"           # 支持的 TUN 地址（空格分隔）：NinjaDesktop=198.18.0.1，Clash Verge=28.0.0.1
FALLBACK_SECS=10                        # 兜底同步间隔（秒）：也是"改清单多久生效"的上限
TAG="# tun-guard"                       # 标记由本脚本写入的行
HOSTS=/etc/hosts
ROUTE=/sbin/route                       # 事件源；改成别的可执行文件即可用于自测

require_root() {
  [ "$(/usr/bin/id -u)" -eq 0 ] || { echo "tun-guard: 需要 root 权限运行" >&2; exit 1; }
}

# TUN 网卡是否已分配到该地址
# 只 fork 一次 ifconfig，用 bash 内置字符串匹配，省掉一个 grep 进程
tun_up() {
  local out ip
  out=$(/sbin/ifconfig 2>/dev/null) || return 1
  for ip in $TUN_IPS; do
    [[ $out == *"inet ${ip} "* ]] && return 0
  done
  return 1
}

flush_dns() {
  /usr/bin/dscacheutil -flushcache 2>/dev/null
  /usr/bin/killall -HUP mDNSResponder 2>/dev/null
  return 0
}

# 读取清单：去 CR、去行内注释、去首尾空白、去空行、去重、校验字符、跳过通配符
load_domains() {
  [ -r "$CONF" ] || return 0
  /usr/bin/awk '
    {
      sub(/\r$/, "")
      sub("^\357\273\277", "")       # 去掉 Windows/编辑器可能留下的 BOM
      sub(/[ \t]*#.*$/, "")
      gsub(/^[ \t]+|[ \t]+$/, "")
      if ($0 == "") next
      if ($0 ~ /^\*\./) {
        print "tun-guard: 跳过通配符 " $0 "（hosts 不支持，子域名需逐个列出）" > "/dev/stderr"
        next
      }
      if ($0 !~ /^[A-Za-z0-9._-]+$/) {
        print "tun-guard: 跳过非法条目 " $0 > "/dev/stderr"
        next
      }
      if (seen[$0]++) next
      print
    }
  ' "$CONF"
}

# 由域名列表生成期望写入的完整内容（A + AAAA 双栈）
build_want() {
  local d out=""
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    # 用 printf -v 累加，不能用 $(printf ...)：命令替换会把每条末尾的换行吃掉
    printf -v out '%s0.0.0.0 %s %s\n:: %s %s\n' "$out" "$d" "$TAG" "$d" "$TAG"
  done <<< "$1"
  printf '%s' "$out"
}

# 清单没变就不重新生成；mtime + size 变化即视为改过
refresh_domains() {
  local sig next
  if [ -r "$CONF" ]; then
    sig=$(/usr/bin/stat -f '%m-%z' "$CONF" 2>/dev/null) || sig="missing"
  else
    sig="missing"
  fi
  [ "$sig" = "$CONF_SIG" ] && return 0
  CONF_SIG=$sig
  if [ "$sig" = "missing" ]; then
    echo "tun-guard: 找不到域名清单 ${CONF}，保留上次有效清单和已有屏蔽" >&2
    return 0
  fi
  next=$(build_want "$(load_domains)")
  if [ -z "$next" ]; then
    echo "tun-guard: 清单没有有效域名，保留上次有效清单和已有屏蔽" >&2
    return 0
  fi
  WANT=$next
  echo "tun-guard: 清单已加载，共 $(printf '%s' "$WANT" | /usr/bin/grep -c .) 条 hosts 记录" >&2
}

current_block() { /usr/bin/grep -F -- "$TAG" "$HOSTS" 2>/dev/null; }
has_block()     { /usr/bin/grep -qF -- "$TAG" "$HOSTS" 2>/dev/null; }

# 删除所有带 TAG 的行；不依赖 sed 方言，保留 inode/权限/属主，失败不动原文件
strip_block() {
  local tmp rc
  tmp=$(/usr/bin/mktemp /tmp/tun-guard.XXXXXX) || return 1
  /usr/bin/grep -vF -- "$TAG" "$HOSTS" > "$tmp"
  rc=$?
  if [ "$rc" -gt 1 ]; then         # 2=真出错（读不了/写不了），别拿空文件覆盖 hosts
    /bin/rm -f "$tmp"
    return 1
  fi
  /bin/cat "$tmp" > "$HOSTS" || { /bin/rm -f "$tmp"; return 1; }
  /bin/rm -f "$tmp"
  return 0
}

unblock() {
  has_block || return 0
  strip_block && flush_dns
}

sync_state() {
  local cur
  if tun_up; then
    has_block && unblock
    return 0
  fi
  refresh_domains
  if [ -z "$WANT" ]; then
    # 尚未读到有效清单时保留现有屏蔽，避免清单丢失导致意外放行。
    return 0
  fi
  cur=$(current_block)
  [ "$WANT" = "$cur" ] && return 0    # 内容完全一致，什么都不做
  strip_block || return 0             # 清理失败就别追加，否则会写出一堆重复行
  [ -s "$HOSTS" ] && [ -n "$(/usr/bin/tail -c 1 "$HOSTS")" ] && printf '\n' >> "$HOSTS"
  printf '%s\n' "$WANT" >> "$HOSTS"
  flush_dns
}

# 只关心网卡状态、地址增删、路由增删改；
# RTM_MISS（连接/查询失败）这类噪声不触发同步，否则浏览网页时会疯狂同步
event_relevant() {
  case $1 in
    RTM_IFINFO*|RTM_NEWADDR*|RTM_DELADDR*) return 0 ;;
    RTM_ADD*|RTM_DELETE*|RTM_CHANGE*)      return 0 ;;
    *) return 1 ;;
  esac
}

# 主循环：阻塞在内核路由消息上，有相关事件就同步，超时则兜底同步
main_loop() {
  local line rc deadline remaining t0
  deadline=$((SECONDS + FALLBACK_SECS))   # 重连事件源不重置兜底期限
  while :; do
    exec 3< <("$ROUTE" -n monitor 2>/dev/null)
    while :; do
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -le 0 ]; then
        sync_state
        deadline=$((SECONDS + FALLBACK_SECS))
        continue
      fi
      t0=$SECONDS
      IFS= read -r -t "$remaining" line <&3
      rc=$?
      if [ "$rc" -eq 0 ]; then
        if event_relevant "$line"; then
          # 事件到达立即同步；相同状态不会重复改 hosts 或刷新 DNS。
          sync_state
          deadline=$((SECONDS + FALLBACK_SECS))
        fi
      elif [ $((SECONDS - t0)) -ge "$remaining" ]; then
        # 注意：macOS 自带的 bash 3.2 里 read -t 超时返回 1，和 EOF 一样，
        # 只有 bash 4+ 才返回 142，所以这里靠实际耗时来区分超时和 EOF
        sync_state
        deadline=$((SECONDS + FALLBACK_SECS))
      else
        sync_state                  # EOF 也检查一次，重连期间继续保护
        break                       # 事件源退出了，重开
      fi
    done
    exec 3<&-
    /bin/sleep 1                    # 重开前稍等，避免疯狂重启
  done
}

# 自检：在临时目录里用 hosts 副本跑一遍完整流程，不碰真实 /etc/hosts、不刷 DNS 缓存
# 用法：./tun-guard.sh --selftest
selftest() {
  local tmpd got fails=0 p
  flush_dns() { :; }
  tmpd=$(/usr/bin/mktemp -d /tmp/tun-guard-selftest.XXXXXX) || { echo "无法创建临时目录"; return 1; }
  HOSTS="$tmpd/hosts"
  printf '127.0.0.1\tlocalhost\n::1\tlocalhost\n' > "$HOSTS"
  /bin/cp "$HOSTS" "$tmpd/baseline"

  if [ ! -r "$CONF" ]; then
    echo "FAIL: 找不到域名清单 ${CONF}，先创建它再自检"
    /bin/rm -rf "$tmpd"
    return 1
  fi
  echo "域名清单: ${CONF}"

  # 1) 模拟 TUN 关闭：203.0.113.77 是保留测试地址，本机永远不会有
  TUN_IPS="203.0.113.77"; CONF_SIG=""; WANT=""
  sync_state
  got=$(/usr/bin/grep -cF -- "$TAG" "$HOSTS" 2>/dev/null); got=${got:-0}
  if [ "$got" -gt 0 ]; then echo "1) 模拟 TUN 关闭 -> 写入 ${got} 条记录    PASS"
  else echo "1) 模拟 TUN 关闭 -> 写入 ${got} 条记录    FAIL"; fails=$((fails+1)); fi

  # 2) 模拟 TUN 开启：127.0.0.1 一定存在
  TUN_IPS="127.0.0.1"
  sync_state
  got=$(/usr/bin/grep -cF -- "$TAG" "$HOSTS" 2>/dev/null); got=${got:-0}
  if [ "$got" -eq 0 ]; then echo "2) 模拟 TUN 开启 -> 残留 ${got} 条记录      PASS"
  else echo "2) 模拟 TUN 开启 -> 残留 ${got} 条记录      FAIL"; fails=$((fails+1)); fi

  # 3) 还原后应与初始内容逐字节一致
  if /usr/bin/cmp -s "$HOSTS" "$tmpd/baseline"; then
    echo "3) hosts 还原后与原始内容一致         PASS"
  else
    echo "3) hosts 还原后与原始内容一致         FAIL"; fails=$((fails+1))
  fi

  # 4) 事件源是否能启动（失败时仍在重连和兜底路径检查状态）
  "$ROUTE" -n monitor >/dev/null 2>&1 & p=$!
  /bin/sleep 0.5
  if kill -0 "$p" 2>/dev/null; then
    echo "4) 事件源 route -n monitor 可用       PASS"
    kill "$p" 2>/dev/null
  else
    echo "4) 事件源 route -n monitor 可用       FAIL（重连期间仍检查状态）"; fails=$((fails+1))
  fi
  # 有界等待：route -n monitor 有时不吃 TERM，无限 wait 会把调用方挂死
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$p" 2>/dev/null || break
    /bin/sleep 0.2
  done
  kill -9 "$p" 2>/dev/null

  /bin/rm -rf "$tmpd"
  if [ "$fails" -eq 0 ]; then echo "自检通过"; else echo "自检失败（${fails} 项）"; fi
  return "$fails"
}

# 被 launchd stop / kill 时尽量还原，避免卸载后域名一直被屏蔽
on_exit() {
  has_block && unblock
  exit 0
}
trap on_exit TERM INT

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

require_root
WANT=""
CONF_SIG="__init__"
sync_state        # 启动先同步一次
main_loop
