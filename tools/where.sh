#!/usr/bin/env bash
#
# where.sh — locate a feature across chalk's vertical stack.
#
# chalk features cut vertically: schema -> wire frame -> ws handler -> store ->
# client proto -> reducer -> component. Finding one means running the same six
# greps in the same order every time. This does it in one pass and groups the
# hits by layer, annotating each with the enclosing func/const/case so a hit in
# a 5000-line file is readable without opening it.

set -uo pipefail

usage() {
	cat >&2 <<'EOF'
usage: tools/where.sh [-c] [-t] [-n N] <pattern>

Case-insensitive ripgrep across the repo, grouped by layer in request-path
order, each hit annotated with its enclosing symbol.

  -c     per-layer counts only (a map before you commit to reading)
  -t     include tests (excluded by default)
  -n N   max hits shown per layer (default 40, 0 = unlimited)

examples:
  tools/where.sh thread_reply        # where does one wire frame live?
  tools/where.sh -c parking          # which layers does the parking lot touch?
  tools/where.sh -t 'space ?key'     # regex, tests included
EOF
	exit 2
}

per_layer=40
show_tests=0
counts_only=0

while getopts ':ctn:h' opt; do
	case "$opt" in
	c) counts_only=1 ;;
	t) show_tests=1 ;;
	n) per_layer="$OPTARG" ;;
	*) usage ;;
	esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
pattern="$1"

command -v rg >/dev/null || { echo "where.sh: needs ripgrep" >&2; exit 1; }
cd "$(dirname "$0")/.." || exit 1

if [ -t 1 ]; then
	bold=$'\033[1m'; dim=$'\033[2m'; cyan=$'\033[36m'; off=$'\033[0m'
else
	bold=''; dim=''; cyan=''; off=''
fi

hits=$(mktemp) || exit 1
annot=$(mktemp) || exit 1
trap 'rm -f "$hits" "$annot"' EXIT

# Excludes itself: the usage examples above would otherwise be a standing hit
# for whatever feature names they mention.
rg -n -i --no-heading --color never --field-match-separator $'\t' \
	--glob '!tools/where.sh' -e "$pattern" >"$hits"
if [ ! -s "$hits" ]; then
	echo "no hits for ${bold}${pattern}${off}" >&2
	exit 1
fi

# Layers in request-path order. A path falls into the first one it matches, so
# ordering here doubles as precedence — tests before everything, since a
# _test.go under internal/server/ is a test first.
layer_of() {
	awk -F'\t' -v tests="$show_tests" '
	{
		p = $1
		is_test = (p ~ /_test\.go$/ || p ~ /\.test\.(ts|tsx|mjs)$/ || p ~ /^test\//)
		if (is_test) { if (!tests) next; l = "0 tests" }
		else if (p ~ /^migrations\//)                             l = "1 schema"
		else if (p ~ /^internal\/proto\// || p == "web/src/proto.ts") l = "2 wire"
		else if (p ~ /^internal\/(server|auth|config)\//)         l = "3 server"
		else if (p ~ /^internal\/store\//)                        l = "4 store"
		else if (p ~ /^internal\//)                               l = "5 server-lib"
		else if (p ~ /^web\/src\/(state|ws-client)/)              l = "6 client-state"
		else if (p ~ /^web\/src\/components\//)                   l = "7 client-ui"
		else if (p ~ /^web\/src\//)                               l = "8 client-lib"
		else if (p ~ /^(docs|README|CHANGELOG|CLAUDE)/)           l = "9 docs"
		else                                                      l = "9z other"
		print l "\t" $0
	}' "$hits"
}

# Annotate every hit with its enclosing declaration. Two-file awk: hit lines
# first, then the source. `case` counts as a declaration on purpose — in
# reducer.ts and ws.go the nearest case label is the useful context, not the
# 500-line function wrapping it.
annotate_file() {
	local file="$1" lines="$2"
	awk -v OFS='\t' '
	function trim(s) {
		sub(/^[ \t]+/, "", s); sub(/[ \t]*\{[ \t]*$/, "", s); sub(/[ \t]+$/, "", s)
		return length(s) > 64 ? substr(s, 1, 61) "..." : s
	}
	FNR == NR { want[$1] = 1; next }
	{
		if ($0 ~ /^(func |(export )?(default )?(async )?function |(export )?(async )?const [A-Za-z_$]+ *[:=]|(export )?(class|interface|type) |[A-Z]+ (TABLE|INDEX|TYPE|FUNCTION))/ ||
		    $0 ~ /^[ \t]*case [^ ]/ ||
		    $0 ~ /^[ \t]{1,4}(async )?[A-Za-z_$]+\(.*\)[ ]*\{/) {
			sym = trim($0)
			symline = FNR
		}
		# A backscan is a locator, not a parser: past a few hundred lines the
		# nearest declaration is as likely to be a closed scope as an enclosing
		# one (App.tsx is one 5000-line function). Files with no declarations at
		# all — SQL, markdown — never had a symbol to give. Both fall back to the
		# matched line itself, which beats a bare line number either way.
		if (FNR in want) {
			if (symline == FNR)              print FNR, sym
			else if (symline && FNR - symline <= 250) print FNR, sym " :" symline
			else                             print FNR, trim($0)
		}
	}' "$lines" "$file" 2>/dev/null
}

layered=$(mktemp) || exit 1
trap 'rm -f "$hits" "$annot" "$annot".* "$layered"' EXIT
layer_of >"$layered"

if [ ! -s "$layered" ]; then
	printf 'no hits for %s%s%s outside tests (%d in tests — rerun with -t)\n' \
		"$bold" "$pattern" "$off" "$(wc -l <"$hits")" >&2
	exit 1
fi

if [ "$counts_only" -eq 1 ]; then
	printf '%s%s%s\n\n' "$bold" "layer map for: $pattern" "$off"
	awk -F'\t' '{ n[$1]++; files[$1 FS $2] = 1 }
		END {
			for (k in files) { split(k, a, FS); f[a[1]]++ }
			for (l in n) printf "%s\t%d\t%d\n", l, n[l], f[l]
		}' "$layered" | sort | awk -F'\t' -v b="$bold" -v o="$off" -v d="$dim" \
		'{ sub(/^[0-9]z? /, "", $1); printf "  %s%-14s%s %3d hits  %s%d files%s\n", b, $1, o, $2, d, $3, o }'
	exit 0
fi

printf '%s%s%s\n' "$bold" "where: $pattern" "$off"

sort -t$'\t' -k1,1 -k2,2 -k3,3n "$layered" |
	awk -F'\t' '{ print > ("'"$annot"'." $1) }'

for lf in "$annot".*; do
	[ -e "$lf" ] || continue
	layer=${lf##*.}
	total=$(wc -l <"$lf")
	printf '\n%s%s%s %s(%d)%s\n' "$bold" "${layer#* }" "$off" "$dim" "$total" "$off"

	shown=0
	flines=$(mktemp)
	while read -r file; do
		if [ "$per_layer" -ne 0 ] && [ "$shown" -ge "$per_layer" ]; then
			printf '    %s… %d more hits in this layer (-n 0 for all)%s\n' \
				"$dim" "$((total - shown))" "$off"
			break
		fi
		awk -F'\t' -v f="$file" '$2 == f { print $3 }' "$lf" >"$flines"
		n=$(wc -l <"$flines")
		room=$((per_layer == 0 ? n : per_layer - shown))
		printf '  %s%s%s\n' "$cyan" "$file" "$off"
		annotate_file "$file" "$flines" | head -n "$room" |
			while IFS=$'\t' read -r ln sym; do
				printf '    %s:%-5s %s%s%s\n' "$file" "$ln" "$dim" "$sym" "$off"
			done
		shown=$((shown + (n < room ? n : room)))
	done < <(cut -f2 "$lf" | uniq)
	rm -f "$flines"
done
