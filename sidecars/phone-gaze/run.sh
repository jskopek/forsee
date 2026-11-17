#!/usr/bin/env bash
# Phone Gaze: install (first run only) and start the engine.
#
#   sidecars/phone-gaze/run.sh                 # start; the UI opens in the browser
#   sidecars/phone-gaze/run.sh --sim arkit     # with the simulated phone instead of the iPhone
#   sidecars/phone-gaze/run.sh --phone http://192.168.1.20:8080
#   sidecars/phone-gaze/run.sh --install-only  # set up and exit
#   sidecars/phone-gaze/run.sh doctor --phone http://192.168.1.20:8080   # checklist with fixes
#   sidecars/phone-gaze/run.sh bundle          # diagnostics folder to share
#   sidecars/phone-gaze/run.sh sweep RUN_ID    # replay a collection run through many settings
#   sidecars/phone-gaze/run.sh diagnose RUN_ID # why each setup's error is what it is
#
# Uses uv when it is installed (it can fetch a suitable Python by itself); otherwise the newest
# python3.x (3.10 or later) on the PATH with "python3 -m venv". The virtualenv lives in
# engine/.venv and is rebuilt only when requirements.txt or pyproject.toml change.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$HERE/engine"
VENV="$ENGINE/.venv"
PY="$VENV/bin/python"
STAMP="$VENV/.phonegaze-installed"

install_only=0
args=()
for a in "$@"; do
  if [ "$a" = "--install-only" ]; then install_only=1; else args+=("$a"); fi
done

want_stamp() {
  cat "$ENGINE/requirements.txt" "$ENGINE/pyproject.toml" | shasum -a 256 2>/dev/null | cut -c1-16 ||
    cat "$ENGINE/requirements.txt" "$ENGINE/pyproject.toml" | sha256sum | cut -c1-16
}

find_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 &&
      "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$c"
      return 0
    fi
  done
  return 1
}

install() {
  echo "Setting up Phone Gaze in $VENV (first run, takes a minute or two)..."
  if command -v uv >/dev/null 2>&1; then
    [ -x "$PY" ] || uv venv --python 3.12 "$VENV"
    uv pip install --python "$PY" -r "$ENGINE/requirements.txt"
    uv pip install --python "$PY" -e "$ENGINE"
  else
    local sys_py
    if ! sys_py="$(find_python)"; then
      echo "Phone Gaze needs Python 3.10 or newer (macOS ships 3.9)." >&2
      echo "Install uv (https://docs.astral.sh/uv/) or Python from python.org or Homebrew" >&2
      echo "(brew install python@3.12), then run this script again." >&2
      exit 1
    fi
    [ -x "$PY" ] || "$sys_py" -m venv "$VENV"
    "$PY" -m pip install --quiet --upgrade pip
    "$PY" -m pip install -r "$ENGINE/requirements.txt"
    "$PY" -m pip install -e "$ENGINE"
  fi
  (cd "$ENGINE" && "$PY" -m phonegaze.download)
  want_stamp >"$STAMP"
}

if [ ! -x "$PY" ] || [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$(want_stamp)" ]; then
  install
fi

if [ "$install_only" = 1 ]; then
  echo "Installed. Start with: $0"
  exit 0
fi

# Subcommands (doctor, bundle, lab, tune, ab, sweep, diagnose) go straight through: they take their own options and
# start no global shortcuts, so --no-hotkeys below must not be added to them.
subcommand=0
case "${args[0]-}" in
  doctor | bundle | lab | tune | ab | sweep | diagnose) subcommand=1 ;;
esac

# pynput (global shortcuts) can crash Python 3.14 on macOS 26: turn shortcuts off there.
if [ "$subcommand" = 0 ] && [ "$(uname)" = Darwin ] && "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 14) else 1)'; then
  case " ${args[*]-} " in
    *" --no-hotkeys "*) ;;
    *)
      echo "Note: Python 3.14 or newer; global shortcuts are off (pynput can crash it on macOS)." >&2
      echo "      For shortcuts, install uv and delete $VENV so run.sh rebuilds it with Python 3.12." >&2
      args+=(--no-hotkeys)
      ;;
  esac
fi

cd "$ENGINE"
exec "$PY" -m phonegaze ${args[@]+"${args[@]}"}
