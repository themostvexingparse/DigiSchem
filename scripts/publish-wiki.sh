#!/usr/bin/env bash
# Publishes docs/*.md to the repository's GitHub wiki.
#
# The pages in docs/ link to each other as files (Getting-Started.md) so they read correctly on
# GitHub and in an editor. A wiki links to pages by name (Getting-Started) and cannot show files
# from the repository, so links are rewritten on the way:
#   (Page.md) and (Page.md#anchor)   ->  (Page) and (Page#anchor)
#   (images/x.svg)                   ->  the file in the repository
#   (../FILE)                        ->  the file in the repository
#
# Usage: scripts/publish-wiki.sh [commit message]
# The wiki must exist: enable it in the repository settings and create any first page once.
set -euo pipefail

repo_url="$(git config --get remote.origin.url)"
slug="$(echo "$repo_url" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
wiki_url="https://github.com/${slug}.wiki.git"
blob="https://github.com/${slug}/blob/main"
raw="https://github.com/${slug}/raw/main"
msg="${1:-Update wiki from docs/ at $(git rev-parse --short HEAD)}"

root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet "$wiki_url" "$work/wiki"
# replace every page (pages removed from docs/ disappear from the wiki too)
find "$work/wiki" -maxdepth 1 -name '*.md' -delete
for f in "$root"/docs/*.md; do
  sed -E \
    -e "s#\]\(images/([^)]+)\)#](${raw}/docs/images/\1)#g" \
    -e "s#\]\(\.\./([^)]+)\)#](${blob}/\1)#g" \
    -e 's#\]\(([A-Za-z0-9_-]+)\.md(\#[^)]*)?\)#](\1\2)#g' \
    "$f" > "$work/wiki/$(basename "$f")"
done

cd "$work/wiki"
git add -A
if git diff --cached --quiet; then
  echo "wiki is up to date"
  exit 0
fi
git commit --quiet -m "$msg"
git push --quiet origin HEAD
echo "published $(ls *.md | wc -l) pages to ${wiki_url%.git}"
