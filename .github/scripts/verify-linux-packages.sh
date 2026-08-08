#!/usr/bin/env bash
# Installs the built .deb for real rather than trusting nfpm's exit code: a package whose
# payload path or dependency set is wrong builds cleanly and fails on the user's machine.
set -euo pipefail

DIR="${1:-dist/linux-packages}"

dpkg-deb --info "$DIR"/*.deb
dpkg-deb --contents "$DIR"/*.deb

sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends rpm
rpm -qip "$DIR"/*.rpm
rpm -qlp "$DIR"/*.rpm

sudo apt install -y "$DIR"/*.deb
kesha --version
kesha install --plan
sudo apt remove -y kesha-voice-kit
