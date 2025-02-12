#!/bin/bash
if ! command -v bun; then
  npm install -g bun
fi
cur_dir=$(pwd)
cli_dir=$(dirname "$BASH_SOURCE")
cd $cli_dir
bun install
full_cli_dir_path=$(pwd)
alias ozy="bun $full_cli_dir_path/src/index.ts"
cd $cur_dir
