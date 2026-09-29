#!/usr/bin/env bash
# Usage: offline.sh <command…> — run a command with the network blocked by the OS, so any runtime download fails (#1277).
set -euo pipefail

case "$(uname -s)" in
  Linux)
    if unshare -rn true 2>/dev/null; then
      block=(unshare -rn)
    else
      # Ubuntu 24.04's AppArmor can refuse unprivileged user namespaces; root makes the netns, setpriv drops back.
      block=(sudo env "PATH=$PATH" "HOME=$HOME" unshare --net
        setpriv "--reuid=$(id -u)" "--regid=$(id -g)" --init-groups --)
    fi
    ;;
  Darwin)
    block=(sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))')
    ;;
  *)
    echo "offline.sh: no network block for $(uname -s)" >&2
    exit 2
    ;;
esac

probe=(curl -sS --max-time 10 -o /dev/null https://github.com)
if ! "${probe[@]}"; then
  echo "offline.sh: github.com is unreachable even without the block, so a failure inside it would prove nothing" >&2
  exit 2
fi
if "${block[@]}" "${probe[@]}" 2>/dev/null; then
  echo "offline.sh: curl reached github.com through the block (${block[0]}), so it does not hold" >&2
  exit 2
fi
echo "offline.sh: network blocked via ${block[0]}; running $*" >&2

if ! "${block[@]}" "$@"; then
  echo "FAIL: \`$*\` failed with the network blocked. After \`kesha install\` nothing may download (#823, #1277); a network error above means it tried." >&2
  exit 1
fi
