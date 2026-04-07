#!/usr/bin/env python3
"""Replace CI benchmark section in BENCHMARK.md between markers.

Usage: update-benchmark-md.py <results-file> <benchmark-md>
"""

import re
import sys

if len(sys.argv) != 3:
    print("Usage: update-benchmark-md.py <results-file> <benchmark-md>", file=sys.stderr)
    sys.exit(1)

results_path = sys.argv[1]
benchmark_path = sys.argv[2]

content = open(benchmark_path).read()
replacement = open(results_path).read()

pattern = r"(<!-- CI-BENCHMARK-START -->).*?(<!-- CI-BENCHMARK-END -->)"
updated = re.sub(pattern, r"\1\n" + replacement + r"\n\2", content, flags=re.DOTALL)

if updated == content:
    print("WARNING: CI-BENCHMARK markers not found in BENCHMARK.md", file=sys.stderr)
    sys.exit(1)

open(benchmark_path, "w").write(updated)
