#!/usr/bin/env python3
"""Convert JUnit XML test results to a markdown table.

Usage: junit-to-markdown.py [--summary] <title> <junit.xml> [<junit.xml> ...]
  --summary  Show only pass/fail counts, no detailed table
Output: Markdown to stdout
"""

import sys
import xml.etree.ElementTree as ET


def escape_md(text):
    return text.replace("|", "\\|")


def parse_junit(path):
    try:
        tree = ET.parse(path)
    except (FileNotFoundError, ET.ParseError) as e:
        print(f"Warning: Could not parse {path}: {e}", file=sys.stderr)
        return []

    root = tree.getroot()

    suites = root.findall(".//testsuite")
    if not suites:
        suites = [root] if root.tag == "testsuite" else []

    results = []
    for suite in suites:
        for tc in suite.findall("testcase"):
            name = tc.get("name", "unknown")
            suite_name = tc.get("classname", suite.get("name", ""))

            try:
                time_s = float(tc.get("time", "0"))
            except ValueError:
                time_s = 0.0

            if tc.find("failure") is not None:
                status = "failed"
                message = (tc.find("failure").get("message") or "")[:100]
            elif tc.find("skipped") is not None:
                status = "skipped"
                message = ""
            else:
                status = "passed"
                message = ""

            results.append({
                "suite": suite_name,
                "name": name,
                "status": status,
                "time_ms": time_s * 1000,
                "message": message,
            })

    return results


def to_markdown(title, results, summary_only=False):
    passed = sum(1 for r in results if r["status"] == "passed")
    failed = sum(1 for r in results if r["status"] == "failed")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    total = len(results)

    icon = "✅" if failed == 0 else "❌"
    status_icons = {"passed": "✅", "failed": "❌", "skipped": "⏭️"}

    lines = []

    if summary_only:
        total_time = sum(r["time_ms"] for r in results)
        if total_time >= 1000:
            time_str = f"{total_time / 1000:.1f}s"
        else:
            time_str = f"{total_time:.0f}ms"
        lines.append(f"| {title} | {icon} **{passed}** passed · {failed} failed · {skipped} skipped | {total} | {time_str} |")
        return "\n".join(lines)

    lines.append(f"### {title}")
    lines.append("")
    lines.append(f"**{passed} passed** · {failed} failed · {skipped} skipped · {total} total")
    lines.append("")

    if not results:
        lines.append("_No test results found._")
        return "\n".join(lines)

    # Only show table for failures, or full table if few results
    failures = [r for r in results if r["status"] == "failed"]
    show_results = failures if (failed > 0 and total > 20) else results
    show_results = sorted(show_results, key=lambda r: r["time_ms"], reverse=True)

    lines.append("| Suite | Test | Status | Time |")
    lines.append("|-------|------|--------|------|")

    for r in show_results:
        si = status_icons[r["status"]]
        time = f"{r['time_ms']:.0f}ms"
        name = escape_md(r["name"])
        suite = escape_md(r["suite"])
        if r["message"]:
            name = f"{name} — {escape_md(r['message'])}"
        lines.append(f"| {suite} | {name} | {si} | {time} |")

    return "\n".join(lines)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    summary_only = "--summary" in sys.argv

    if len(args) < 2:
        print("Usage: junit-to-markdown.py [--summary] <title> <junit.xml> [...]", file=sys.stderr)
        sys.exit(1)

    title = args[0]
    results = []
    for path in args[1:]:
        results.extend(parse_junit(path))

    print(to_markdown(title, results, summary_only))
