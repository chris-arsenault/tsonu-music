#!/usr/bin/env bash
set -euo pipefail

max_lines=600
failed=0

while IFS= read -r -d '' file; do
  line_count=$(wc -l < "$file")
  if (( line_count > max_lines )); then
    printf '%s has %d lines; limit is %d\n' "$file" "$line_count" "$max_lines" >&2
    failed=1
  fi
done < <(find backend -type f -name '*.rs' -not -path '*/target/*' -print0)

exit "$failed"
