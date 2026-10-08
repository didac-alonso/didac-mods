#!/usr/bin/env bash
# Copies pace-line's pure Slurm parsers, metric math, alert rules and terminal
# charts into job-watch, which can't import another plugin's files.
#   scripts/sync-shared.sh          copy them
#   scripts/sync-shared.sh --check  exit 1 if a copy differs from its source
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/plugins/pace-line/hooks"
dst="$root/plugins/job-watch/hooks"
files=(format.ts slurm.ts jobs/parse.ts jobs/metrics.ts jobs/alerts.ts jobs/chart.ts)

header() { printf '// Copied from plugins/pace-line/hooks/%s by scripts/sync-shared.sh: edit it there.\n' "$1"; }

status=0
for f in "${files[@]}"; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! diff -q <(header "$f"; cat "$src/$f") "$dst/$f" >/dev/null 2>&1; then
      echo "drift: $f" >&2
      status=1
    fi
  else
    mkdir -p "$(dirname "$dst/$f")"
    { header "$f"; cat "$src/$f"; } > "$dst/$f"
  fi
done
[[ "${1:-}" == "--check" && $status -eq 0 ]] && echo "job-watch: shared files match pace-line"
exit $status
