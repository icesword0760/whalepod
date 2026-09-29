#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
NODE_VERSION=$(tr -d '[:space:]' < "$PROJECT_ROOT/.node-version")
PNPM_VERSION=$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').packageManager.split('@').at(-1))")

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) NODE_PLATFORM=darwin-arm64 ;;
  Darwin-x86_64) NODE_PLATFORM=darwin-x64 ;;
  Linux-aarch64) NODE_PLATFORM=linux-arm64 ;;
  Linux-x86_64) NODE_PLATFORM=linux-x64 ;;
  *)
    printf 'Unsupported development platform: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

ARCHIVE="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.xz"
RUNTIME_BASE=${DSH_PLUGIN_RUNTIME_DIR:-"$HOME/.cache/dsh-plugin-matou-layout"}
NODE_HOME="$RUNTIME_BASE/node-v${NODE_VERSION}-${NODE_PLATFORM}"

if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  mkdir -p "$RUNTIME_BASE/downloads"
  DOWNLOAD="$RUNTIME_BASE/downloads/$ARCHIVE"
  SHASUMS="$RUNTIME_BASE/downloads/SHASUMS256-v${NODE_VERSION}.txt"
  curl --fail --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE" \
    --output "$DOWNLOAD"
  curl --fail --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    --output "$SHASUMS"
  EXPECTED=$(awk -v archive="$ARCHIVE" '$2 == archive { print $1 }' "$SHASUMS")
  if [[ -z "$EXPECTED" ]]; then
    printf 'Node checksum entry is missing for %s\n' "$ARCHIVE" >&2
    exit 1
  fi
  ACTUAL=$(shasum -a 256 "$DOWNLOAD" | awk '{ print $1 }')
  if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    printf 'Node checksum mismatch for %s\n' "$ARCHIVE" >&2
    exit 1
  fi
  tar -xJf "$DOWNLOAD" -C "$RUNTIME_BASE"
fi

export PATH="$NODE_HOME/bin:$PATH"

GIT_COMMON=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir)
if [[ "$GIT_COMMON" != /* ]]; then
  GIT_COMMON="$PROJECT_ROOT/$GIT_COMMON"
fi
MAIN_CHECKOUT=$(cd "$(dirname "$GIT_COMMON")" && pwd -P)
DSH_ROOT=${DSH_REPO:-"$(dirname "$MAIN_CHECKOUT")/deepseek-harness"}
if [[ ! -f "$DSH_ROOT/packages/client/ui-layout/package.json" ]]; then
  printf 'DSH source was not found at %s\n' "$DSH_ROOT" >&2
  printf 'Set DSH_REPO to the DeepSeek Harness checkout and run this command again.\n' >&2
  exit 1
fi

LINK_PARENT=$(dirname "$PROJECT_ROOT")
EXPECTED_LINK="$LINK_PARENT/deepseek-harness"
if [[ ! -e "$EXPECTED_LINK" ]]; then
  ln -s "$DSH_ROOT" "$EXPECTED_LINK"
fi
LINKED_DSH=$(cd "$EXPECTED_LINK" && pwd -P)
REAL_DSH=$(cd "$DSH_ROOT" && pwd -P)
if [[ "$LINKED_DSH" != "$REAL_DSH" ]]; then
  printf 'The development dependency path points to %s instead of %s\n' "$LINKED_DSH" "$REAL_DSH" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
corepack pnpm@"$PNPM_VERSION" install --frozen-lockfile
corepack pnpm@"$PNPM_VERSION" peers check

printf 'export PATH=%q:$PATH\n' "$NODE_HOME/bin" > "$PROJECT_ROOT/.dev-env"

printf 'Development environment ready.\n'
printf '  project: %s\n' "$PROJECT_ROOT"
printf '  Node:   %s\n' "$(node --version)"
printf '  pnpm:   %s\n' "$(corepack pnpm@"$PNPM_VERSION" --version)"
printf '  DSH:    %s\n' "$REAL_DSH"
printf 'Activate this runtime in the current shell with:\n'
printf '  source %s/.dev-env\n' "$PROJECT_ROOT"
