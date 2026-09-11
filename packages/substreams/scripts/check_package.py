#!/usr/bin/env python3
"""Check a packed .spkg against its own contents before it is published.

A registry version cannot be replaced, only superseded, so everything below is
checked on the PACKED ARTIFACT rather than on the source files it was built
from. That distinction is the whole point: `package.doc` is silently ignored by
the CLI, which embeds whichever README.md sits beside the manifest, so a
manifest can look correct while the package ships somebody else's description.
That is exactly how v0.1.1 went out describing modules it does not contain.

Checks:
  1. The embedded documentation names no module the package does not contain.
     The module list is read from the package itself, so this keeps working as
     modules are added or removed.
  2. package.image is set, and package.url contains the URL you name with
     --url. The registry only warns about both and publishes anyway, and the
     omission cannot be fixed afterwards. package.url is write-only from the
     CLI's side: neither `info`, `info --json` nor `inspect` renders it, so it
     is asserted against the package bytes.
  3. Optionally, that module hashes match a reference package (--same-as),
     which is what makes a "documentation-only change" a claim rather than a
     hope.

Usage:
  python scripts/check_package.py <file.spkg> [--same-as <reference.spkg>]
                                  [--substreams <path to CLI>]
Exits non-zero on any failure.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys

MODULE_IN_PROSE = re.compile(r"\b((?:map|store)_[a-z0-9_]+)\b")


def known_names(present):
    """Module names as prose may write them. An imported module is listed
    qualified ("erc4626:map_events") but referred to either way, so both the
    qualified name and its suffix count as present."""
    return set(present) | {name.split(":")[-1] for name in present}


def info(cli, spkg):
    out = subprocess.run([cli, "info", spkg], capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        sys.exit(f"substreams info failed for {spkg}: {out.stderr.strip()[:400]}")
    return out.stdout


def info_json(cli, spkg):
    out = subprocess.run([cli, "info", spkg, "--json"], capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        sys.exit(f"substreams info --json failed for {spkg}: {out.stderr.strip()[:400]}")
    return out.stdout


def modules(text):
    return [m.group(1) for m in re.finditer(r"^Name: (\S+)", text, re.M)]


def hashes(text):
    pairs = re.findall(r"^Name: (\S+)\n(?:.*\n)*?Hash: (\S+)", text, re.M)
    return dict(pairs)


def doc_body(text):
    """The embedded documentation, which `info` prints indented under Doc:."""
    lines, keep = [], False
    for line in text.splitlines():
        if line.startswith("Doc:"):
            keep = True
            lines.append(line[4:])
            continue
        if keep:
            if line.startswith(("Image:", "Modules:", "Network:", "Package name:", "Version:")):
                break
            lines.append(line)
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spkg")
    ap.add_argument("--same-as", help="reference .spkg whose module hashes must match")
    ap.add_argument("--url", help="the package.url this artifact must contain, asserted against its bytes")
    ap.add_argument("--substreams", default=shutil.which("substreams") or "substreams")
    a = ap.parse_args()

    text = info(a.substreams, a.spkg)
    present = set(modules(text))
    doc = doc_body(text)
    fails = []
    documentation = json.loads(info_json(a.substreams, a.spkg)).get("documentation", "")

    # 1. Names that look like modules of ours, mentioned in the doc but absent here.
    mentioned = set(MODULE_IN_PROSE.findall(doc))
    absent = sorted(m for m in mentioned if m not in known_names(present))
    if absent:
        fails.append(f"embedded doc names modules this package does not contain: {', '.join(absent)}")
    print(f"modules in package: {len(present)}; module names in doc: {len(mentioned)}; absent: {len(absent)}")

    # 2. The fields the registry only warns about before publishing anyway.
    with open(a.spkg, "rb") as fh:
        raw = fh.read()
    if a.url:
        # Searching for any URL is useless: the embedded documentation and the
        # protobuf descriptors both carry links, which is how an earlier
        # version of this check passed a package whose package.url was unset.
        # So the caller states the URL it expects and this proves that exact
        # string reached the binary.
        if a.url.encode() in raw:
            print(f"package.url present in the artifact: {a.url}")
        else:
            fails.append(f"package.url {a.url} is not in the package, and a published version cannot be corrected")
    else:
        print("package.url not checked: pass --url to assert it (no CLI command reads the field back)")
    if not re.search(r"^Image: \[embedded", text, re.M):
        fails.append("package.image is not set, and a published version cannot be corrected")

    # 3. A documentation-only change must leave every module hash untouched.
    if a.same_as:
        ref = hashes(info(a.substreams, a.same_as))
        got = hashes(text)
        if ref != got:
            changed = sorted(k for k in set(ref) | set(got) if ref.get(k) != got.get(k))
            fails.append(f"module hashes differ from {a.same_as}: {', '.join(changed)}")
        else:
            print(f"module hashes identical to {a.same_as} ({len(got)} modules)")

    for f in fails:
        print(f"FAIL  {f}")
    print(f"\n{len(fails)} fail")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
