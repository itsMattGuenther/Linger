// The fresh review before a pull request opens or merges (#917): the hook
// stops a command whose commit a review found something in, hands the
// findings over, lets the same commit through the next time, and stops
// rather than guesses at a command it can't read. Claude and gh are stood in
// for; real git repositories are made in a temporary folder.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS, NETWORK_MS, REVIEW_MS, WORKTREE_PREFIX, folderOf, parseWords, readCommand, recordName, repoOf, reviewerArgs, reviewerCommand, unquote, verdict } from "./review-gate.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GATE = fileURLToPath(new URL("./review-gate.mjs", import.meta.url));
const URL_OF = "https://github.com/test/linger.git";

test("reads which pull request, folder and branch a command is about", () => {
  const table = [
    ["create", 'gh pr create --title "a b" --body-file x', { dirs: [], base: null }],
    ["create", "cd /x/y && gh pr create --title t", { dirs: ["/x/y"] }],
    ["create", 'cd "/x/a b" && cd sub && gh pr create', { dirs: ["/x/a b", "sub"] }],
    // A line ended by && carries on to the next.
    ["create", "cd x &&\ngh pr create", { dirs: ["x"] }],
    ["create", "cd ~/p && git push -u origin HEAD && gh pr create -t x", { dirs: ["~/p"] }],
    ["create", "git push && gh pr create", { dirs: [] }],
    ["create", "gh pr create -B release -t x", { base: "release" }],
    ["create", "gh pr create --base=release", { base: "release" }],
    // The body a heredoc writes, brackets and all, needn't be read.
    ["create", "gh pr create --title t --body \"$(cat <<'EOF'\nFixes #1 (one)\n1) two\nEOF\n)\"", { dirs: [] }],
    ["create", "\ngh pr create --title t\n", { dirs: [] }],
    ["create", "GH_REPO=o/r gh pr create", { repo: "o/r" }],
    ["create", "gh pr create -R o/r --title t", { repo: "o/r" }],
    // A flag's name in the body, or in the next command, isn't this command's.
    ["create", 'gh pr create --title t --body "run grep -R foo -B 3 ."', { repo: null, base: null }],
    ["create", "gh pr create -t t && gh issue comment 5 -R o/site --body x", { repo: null }],
    ["create", "gh pr create -B main --title t --body \"$(cat <<'EOF'\nwords\nEOF\n)\"", { base: "main" }],
    ["merge", "gh pr merge 912 --squash --admin", { selector: "912" }],
    ["merge", "gh pr merge 912 --squash --admin # after", { selector: "912" }],
    ["merge", 'gh pr merge 912 --squash --body "$(cat x)"', { selector: "912" }],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 --admin", { selector: "https://github.com/o/r/pull/9" }],
    ["merge", "gh pr merge 912 -R o/r --body-file m.txt", { selector: "912", repo: "o/r" }],
    // A value is read with its flag, so a body or title that looks like a flag is text.
    ["create", "gh pr create --title test --body '--repo=other/project'", { repo: null }],
    ["create", "gh pr create -t '-H x' -b '--base=release'", { base: null }],
    ["create", "gh pr create -Bmain -tTitle", { base: "main" }],
    ["merge", "gh pr merge 5 --subject '--auto' --squash", { selector: "5" }],
    ["merge", "gh pr merge 912 --squash && gh issue comment 5 -R o/site --body x", { selector: "912", repo: null }],
    ["merge", "gh pr merge https://github.com/o/site/pull/5 --squash", { repo: "o/site" }],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 -R O/R", { repo: "o/r" }],
    ["merge", "gh pr merge 5 --repo=o/r", { selector: "5", repo: "o/r" }],
    ["merge", "cd /w && gh pr merge 5 --squash && git pull", { selector: "5", dirs: ["/w"] }],
    // A redirection is the shell's, not one of gh's words (#924).
    ["merge", "gh pr merge 5 --squash --admin 2>&1 | tail -3", { selector: "5" }],
    ["merge", "gh pr merge 5 2>/dev/null", { selector: "5" }],
    ["merge", "gh pr merge 5 >&2 --admin", { selector: "5" }],
    ["merge", "gh pr merge 5 &>log.txt", { selector: "5" }],
    ["merge", "gh pr merge 5 --squash>out.txt 2>&-", { selector: "5" }],
    ["merge", "gh pr merge 5 2>&1>out.txt", { selector: "5" }],
    ["merge", "gh pr merge 5 >>log.txt <in.txt 0<&-", { selector: "5" }],
    ["merge", "gh pr merge>log.txt 5", { selector: "5" }],
    ["create", "gh pr create -t x -B release 2>>log.txt", { base: "release" }],
    ["create", "git push -u origin HEAD 2>&1 && gh pr create -t x", { dirs: [] }],
    ["merge", "cd /w 2>/dev/null && gh pr merge 5", { selector: "5", dirs: ["/w"] }],
    ["merge", "cd 2>/dev/null /w && gh pr merge 5", { selector: "5", dirs: ["/w"] }],
    // Before gh and between its words, as the shell allows them.
    ["merge", "gh 2>&1 pr merge 5", { selector: "5" }],
    ["merge", "gh pr 2>/dev/null merge 5", { selector: "5" }],
    ["merge", "2>/dev/null gh pr merge 5", { selector: "5" }],
    ["create", "GH_REPO=o/r >log.txt gh pr create -t x", { repo: "o/r" }],
    // A redirection's target that looks like a setting is a file's name.
    ["create", ">GH_REPO=o/r gh pr create -t x", { repo: null }],
    ["merge", "gh pr merge 5 >| out.txt <> rw.txt <<< x", { selector: "5" }],
    // Glued together, before gh or between its words.
    ["merge", "2>/dev/null>log.txt gh pr merge 5", { selector: "5" }],
    ["merge", "gh 2>a.txt>b.txt pr merge 5", { selector: "5" }],
    ["merge", "gh>log.txt pr>log.txt merge 5", { selector: "5" }],
    // A group of short flags, as gh reads it: each a flag until one takes a value.
    ["merge", "gh pr merge 5 -sR o/r", { selector: "5", repo: "o/r" }],
    ["create", "gh pr create -t x -dB release", { base: "release" }],
    ["create", "gh pr create -t x -dBrelease", { base: "release" }],
    // A body it can't read, or a comment, that mentions the command is text.
    ["create", "gh pr create -t x --body \"$(cat <<'EOF'\nThe gate reads gh pr create now.\nEOF\n)\"", { base: null }],
    ["merge", "gh pr merge 5 # then gh pr merge 6 later", { selector: "5" }],
    // Commands after it that name the action are theirs (#925 reads a second copy by words).
    ["merge", "gh pr merge 920 --admin && gh pr comment 921 --body 'ready to merge'", { selector: "920" }],
    ["merge", "gh pr merge 5 && gh pr checkout 6 && git merge main", { selector: "5" }],
    ["create", "gh pr create -t x > out.txt", { base: null }],
    ["create", "gh pr create -t x -B release 2>&1", { base: "release" }],
    // Read as bash reads them (#925): each was stopped while the gate read text.
    ["create", "X=$(pwd) gh pr create", { base: null }],
    ["merge", "\"gh\" pr merge 5", { selector: "5" }],
    ["merge", "g''h pr merge 5", { selector: "5" }],
    ["merge", "gh pr merge 5 > $(mktemp)", { selector: "5" }],
    ["merge", 'gh pr merge 5 2>"$LOG"', { selector: "5" }],
    ["create", 'gh pr create -t x --repo 2>"$LOG" o/r', { repo: "o/r" }],
    ["create", 'gh pr create -t x -B 2>"$LOG" release', { base: "release" }],
    ["merge", 'gh pr 2>"$X y" merge 5', { selector: "5" }],
    ["merge", "gh pr \\\n        merge 5", { selector: "5" }],
    ["merge", "gh pr merge 5 --body-file - <<'EOF'\nwords\nEOF", { selector: "5" }],
    ["merge", 'gh 2> "$L" pr merge 5', { selector: "5" }],
    ["merge", "gh pr 2>a\\ b merge 5", { selector: "5" }],
    // After a body it can't read, its flags are still its own words.
    ["create", 'gh pr create -b "$(cat x)" \\\n-B release', { base: "release" }],
    ["create", 'gh pr create -b "$(cat x)" "-R" o/r', { repo: "o/r" }],
    ["create", "gh pr create -b \"$(cat x)\" --ba''se release", { base: "release" }],
    ["create", 'gh pr create -b "$(cat x)" -""B release', { base: "release" }],
    ["create", 'gh pr create -b "$(cat x)" -dB release', { base: "release" }],
    ["merge", 'gh pr merge 912 --body "$(cat x)" -R o/r', { selector: "912", repo: "o/r" }],
    ["merge", 'gh pr merge 912 -R o/r --body "$(cat x)"', { selector: "912", repo: "o/r" }],
    ["create", "gh pr create --title t --body \"$(cat <<'EOF'\nwords\nEOF\n)\" --base release", { base: "release" }],
    // A flag's name inside a body is the body's.
    ["create", "gh pr create -B main --title t --body \"$(cat <<'EOF'\nuse grep -R here\nEOF\n)\"", { base: "main", repo: null }],
    // A flag that takes no value, given one, as pflag reads it.
    ["merge", "gh pr merge 5 --help=false --admin", { selector: "5" }],
    ["merge", "gh pr merge 5 -h=false", { selector: "5" }],
    ["ready", "gh pr ready 7 --undo=false", { selector: "7" }],
    ["merge", "gh pr merge 5 --auto=false", { selector: "5" }],
    // A short flag's value after =, as pflag reads it.
    ["create", "gh pr create -B=release", { base: "release" }],
    ["merge", "gh pr merge 5 -R=o/r", { selector: "5", repo: "o/r" }],
    // An assignment of any kind in front, and gh by its Windows name.
    ["merge", "X+=1 gh pr merge 5", { selector: "5" }],
    ["merge", "a[0]=1 gh pr merge 5", { selector: "5" }],
    ["merge", "gh.exe pr merge 5", { selector: "5" }],
    // ANSI-C escapes decoded as bash does.
    ["merge", "gh pr $'\\u006derge' 5", { selector: "5" }],
    // ANSI-C quoting is quoting.
    ["create", "gh pr create --$'base' release", { base: "release" }],
    // A pipeline ends before what follows it: a pull after it runs after the merge.
    ["merge", "gh pr merge 5 | tail -3; git pull", { selector: "5" }],
    // Piped into a loop or group that only reads.
    ["merge", "gh pr merge 5 2>&1 | { cat; }", { selector: "5" }],
    ["merge", 'gh pr merge 5 | while read l; do echo "$l"; done', { selector: "5" }],
    // A later background job after the merge has finished, and a command named by a variable.
    ["merge", "gh pr merge 5 --squash\ngit fetch origin & wait", { selector: "5" }],
    ["merge", "gh pr merge 5 --squash && $EDITOR notes.txt", { selector: "5" }],
    // A branch or folder whose name holds the words isn't the command.
    ["create", "git push -u origin fix/gh-pr-create-flags && gh pr create -t x", { dirs: [] }],
    ["merge", "cd ~/src/gh-pr-merge-bot && gh pr merge 5", { selector: "5", dirs: ["~/src/gh-pr-merge-bot"] }],
    // The word case as an argument inside a substitution is a word.
    ["create", 'gh pr create -t x --body "$(echo fixes the empty case)"', { base: null }],
    ["merge", 'gh pr merge 5 --subject "$(echo covers the empty case)"', { selector: "5" }],
    // pflag keeps the last value; git log reads only, without --output.
    ["ready", "gh pr ready 5 --undo --undo=false", { selector: "5" }],
    ["merge", 'gh pr merge 925 --squash --admin --body "$(git log -1 --format=%B)"', { selector: "925" }],
    // Arithmetic inside double quotes is read.
    ["create", 'gh pr create -t x --body "Count: $((1+1))"', { base: null }],
    // The reviewed command's own body names the command, and its output goes to tee.
    ["create", "cd wt && gh pr create -t x --body \"$(cat <<'EOF'\nThe gate now reads gh pr create.\nEOF\n)\" 2>&1 | tee /tmp/pr.txt", { dirs: ["wt"] }],
    // The reviewed command's own here-document names the command, in exotic syntax.
    ["create", "gh pr create --title t --body-file - <<'EOF'\nThe gate now runs before `gh pr create`.\nEOF", { base: null }],
    // A branch named for the command, in a command with exotic syntax.
    ["create", "git push -u origin fix/gh-pr-create-flags && gh pr create -t x --body \"$(cat <<'EOF'\nUses `x`\nEOF\n)\"", { dirs: [] }],
    ["merge", "cd ~/src/gh-pr-merge-bot && gh pr merge 5 --subject 'the empty case'", { selector: "5" }],
    // English words that are also keywords, in quoted text, aren't exotic syntax.
    ["merge", 'gh pr merge 931 --squash --subject "Fix case handling" && echo "next: gh pr merge 932"', { selector: "931" }],
    // printf and echo change nothing, inside a merge's body.
    ["merge", 'gh pr merge 931 --squash --body "$(printf \'%s\\n\' "$NOTES")"', { selector: "931" }],
    // A body read from a file, and the merge's output logged with tee.
    ["merge", 'gh pr merge 925 --squash --body "$(<msg.md)"', { selector: "925" }],
    ["merge", "gh pr merge 925 --squash --admin 2>&1 | tee /tmp/merge.log", { selector: "925" }],
    // An email address in a default is one word; a loop that only reads after a pipe.
    ["merge", 'gh pr merge 5 --author-email "${EMAIL:-me@example.com}"', { selector: "5" }],
    ["merge", "gh pr merge 5 | for l in x; do :; done", { selector: "5" }],
    // The reviewed command's own body, built with printf, names the command.
    ["create", "gh pr create -t x --body \"$(printf 'Fixes the gh pr create gate\\n\\nMore')\"", { base: null }],
    // A comment after it in exotic syntax: bash never runs a comment.
    ["merge", 'gh pr merge 5 --subject "${T}" # then gh pr merge 6', { selector: "5" }],
    ["ready", "gh pr ready", { selector: null }],
    ["ready", "gh pr ready 12", { selector: "12" }],
  ];
  for (const [action, command, want] of table) {
    const read = readCommand(command, action);
    assert.ok(read && !read.fail, `${command} → ${JSON.stringify(read)}`);
    for (const [key, value] of Object.entries(want)) assert.deepEqual(read[key], value, `${command}: ${key}`);
  }
});

test("a command it might be and can't read exactly is stopped, never guessed", () => {
  const table = [
    ["create", "gh pr create --head other"],
    ["create", "gh pr create -H other"],
    ["create", "gh pr create --base a --base b"],
    ["create", "gh pr create --base"],
    ["create", "ls && gh pr create"],
    ["create", "git checkout other && gh pr create"],
    ["create", "cd - && gh pr create"],
    ["create", "cd $HOME/x && gh pr create"],
    ["create", "cd x | gh pr create"],
    ["create", "cd x || gh pr create"],
    ["create", "(cd x && gh pr create)"],
    ["create", "$(echo) gh pr create"],
    ["create", "command gh pr create"],
    ["merge", "gh pr merge --squash 912"],
    ["merge", "cd 2>/dev/null && gh pr merge 5"],
    // &> is a redirection, not the command's end, so what follows is read.
    ["merge", 'gh pr merge 5 &>"$LOG" --auto'],
    ["merge", "gh pr merge 5 &>log.txt --auto"],
    // Between gh's words: read, so --auto is seen; or not read, and stopped.
    ["merge", "gh pr 2>/dev/null merge 5 --auto"],
    // A target it can't read after a blank, or with a blank escaped in it.
    ["merge", "gh pr 2> $LOG merge 5 --auto"],
    ["create", "gh pr create -t x -dH other"],
    ["merge", 'gh pr merge 5 --body "$(cat message.txt)" --auto --squash'],
    ["create", "gh pr create -Hother"],
    ["create", "gh pr create -t x -Hother"],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 -R a/b"],
    ["create", 'gh pr create --body "$(cat x)" -H other'],
    ["merge", 'gh pr merge --subject "a b" 912'],
    ["merge", "gh pr merge $N"],
    ["merge", "gh pr merge 1 && gh pr merge 2"],
    ["merge", "gh pr merge 5 -R a/b --repo c/d"],
    ["merge", "GH_REPO=a/b gh pr merge 5 -R c/d"],
    ["merge", "gh pr merge 5 -R"],
    ["ready", "git status && gh pr ready 3"],
    // A push first would change the pull request after the review.
    ["merge", "git push && gh pr merge 5 --squash"],
    ["ready", "git push origin feat/x && gh pr ready 5"],
    ["merge", "gh pr merge 5 --auto --squash"],
    ["merge", "gh pr merge 5 --auto=true"],
    // After a step, only &&: a failed cd with ; leaves gh in the first folder.
    ["create", "cd x; gh pr create"],
    ["create", "cd x\ngh pr create"],
    // A word it can't follow where gh, pr or the action stands (#925).
    ["merge", "$G pr merge 5"],
    ["merge", "gh $P merge 5"],
    ["merge", "gh pr $X 5"],
    // Inside a program that runs other commands.
    ["merge", "xargs gh pr merge"],
    ["merge", "bash -c 'gh pr merge 5'"],
    ["create", "env GH_REPO=x gh pr create"],
    ["merge", "timeout 60 gh pr merge 5"],
    // Inside a substitution, or an unquoted here-document's.
    ["merge", "echo $(gh pr merge 5)"],
    ["merge", 'gh pr view "$(gh pr merge 5)"'],
    ["merge", "cat <<EOF\n$(gh pr merge 5)\nEOF"],
    ["merge", "echo `gh pr merge 5`"],
    // A second copy, however it's spelled.
    ["merge", "gh pr merge 5; gh pr merge 6"],
    ["merge", 'gh pr merge 5 && "gh" pr merge 6'],
    ["merge", "gh pr merge 5; g''h pr merge 6"],
    ["merge", 'gh pr merge 5 >/dev/null; gh 2>"$L" pr merge 6 --auto'],
    // Inside a compound command.
    ["merge", "if gh pr merge 5; then echo ok; fi"],
    // A value it can't read, or a word that may be several.
    ["merge", 'gh pr merge "$N"'],
    ["merge", "gh pr merge 5 $FLAGS"],
    ["create", 'gh pr create --base "$B"'],
    ["create", "GH_REPO=$R gh pr create"],
    // The three words in order, as words of one command, whatever runs them:
    // stopped rather than guessed (#925).
    ["create", "echo gh pr create"],
    ["merge", "true &>/dev/null gh pr merge 5"],
    ["merge", "gh pr create --title merge"],
    ["merge", "gh pr -R o/r merge 5"],
    ["merge", "/usr/bin/env gh pr merge 5"],
    ["merge", 'W=env; "$W" gh pr merge 5'],
    ["merge", '"$(echo sudo)" gh pr merge 5'],
    ["merge", "function f { gh pr merge 5; }; f"],
    ["merge", "coproc X { gh pr merge 5; }"],
    ["merge", "time -p gh pr merge 5"],
    ["merge", "CMD='gh pr merge 5'; $CMD"],
    // A program that runs text, given the command as text.
    ["merge", "bash -c 'gh pr \"merge\" 5'"],
    ["merge", "bash <<<'gh pr merge 5'"],
    ["merge", "bash <<EOF\ngh pr merge 5\nEOF"],
    ["merge", "echo gh pr merge 5 | sh"],
    // Substitutions bash runs, however they're wrapped.
    ["merge", 'cat <<EOF\na\\" $(gh pr merge 5)\nEOF'],
    ["merge", 'echo "${x:-$(echo }; gh pr merge 5)}"'],
    ["merge", "echo $((gh pr merge 5) )"],
    // A program that runs text behind a wrapper, or given text the gate can't read.
    ["merge", "env bash -c 'gh pr merge 5'"],
    ["merge", "timeout 60 sh -c 'gh pr merge 5'"],
    ["merge", "CMD='gh pr merge 5'; eval \"$CMD\""],
    ["merge", "CMD='gh pr merge 5'; bash -c \"$CMD\""],
    ["merge", "bash -c 'g\"\"h pr merge 5'"],
    // Piped into a shell from a here-document.
    ["merge", "cat <<'EOF' | bash\ngh pr merge 5\nEOF"],
    // Arithmetic's << is a shift, so the next line is still read.
    ["merge", "(( x <<2 ))\ngh pr merge 5"],
    // A compound command's word on a line of its own.
    ["merge", "until\ngh pr merge 5\ndo sleep 60\ndone"],
    // A process substitution as a redirection's target.
    ["merge", "echo hi > >(g''h pr merge 5)"],
    // A variable that may be gh, behind a wrapper.
    ["merge", 'G=gh; env "$G" pr merge 5'],
    ["merge", "sudo $G pr merge 5"],
    // Added to, the repository is whatever it was too.
    ["merge", "GH_REPO+=o/r gh pr merge 5"],
    // A push running alongside the merge.
    ["merge", "gh pr merge 5 & git push origin HEAD:feat/x"],
    ["merge", "gh pr merge 5 | git push"],
    // Text a program the gate doesn't know may run is code: node runs this.
    ["create", "node - <<'JS'\n['create', 'gh pr create -t x']\nJS"],
    ["merge", "node -e \"require('child_process').execSync('gh pr merge 5 --auto')\""],
    ["merge", "env -S 'gh pr merge 5'"],
    // Data written to a file may be run next.
    ["merge", "echo 'gh pr merge 5' > x.sh && bash x.sh"],
    ["merge", "cat > x.sh <<'EOF'\ngh pr merge 5\nEOF"],
    // Piped from an inert program into one that runs text.
    ["merge", "echo gh | xargs -I% % pr merge 5"],
    // Arithmetic after a compound command's word, and a subshell that only looks like it.
    ["merge", "if (( x <<EOF )); then :; fi\ngh pr merge 5 --auto\nEOF"],
    ["merge", "((true); gh pr merge 5 --auto; (true))"],
    // A here-document's end as bash decodes it.
    ["merge", "cat <<$'EOF'\nx\nEOF\ngh pr merge 5 --auto"],
    // A word that may be a whole flag, after create.
    ["create", 'gh pr create -t x "$(printf -- --head=other)"'],
    // A push that may run while the merge does, however it's written.
    ["merge", "gh pr merge 5 & (git push)"],
    ["merge", "gh pr merge 5 & { git push; }"],
    ["merge", "gh pr merge 5 & sleep 1; git push"],
    ["merge", "gh pr merge 5 & git -C . push origin HEAD:feat/x"],
    // What runs inside the merge's own substitutions, or alongside it, must only read.
    ["merge", 'gh pr merge 5 --squash --body "$(git push -f origin HEAD:feat; echo)"'],
    ["merge", 'gh pr merge 5 > "$(git push origin HEAD:feat)"'],
    ["merge", 'X="$(git push origin HEAD:feat)" gh pr merge 5'],
    ["merge", "gh pr merge 5 & bash -c 'git push -f origin HEAD:feat'"],
    ["merge", "gh pr merge 5 & $G push"],
    ["merge", "gh pr merge 5 & gh api -X PATCH repos/o/r/git/refs/heads/feat"],
    // Programs that take a program to run, or a file to write, from their flags.
    ["merge", "git ls-remote --upload-pack='gh pr merge 5;:' ."],
    ["merge", "rg --pre=bash x <(echo 'gh pr merge 5')"],
    ["merge", "echo 'gh pr merge 5' >& m.sh && bash m.sh"],
    ["merge", "echo 'gh pr merge 5' | sort -o m.sh && bash m.sh"],
    // A gh alias or extension may be anything.
    ["merge", "gh x 'gh pr merge 5'"],
    // Several words even in double quotes.
    ["merge", 'gh pr merge 5 --body "${a[@]}"'],
    ["merge", 'gh pr merge 5 --body "$@"'],
    // A ~ bash wouldn't expand as the gate would.
    ["create", 'cd "~/p" && gh pr create'],
    ["create", "cd ~other/p && gh pr create"],
    // A merge names its pull request (AGENTS.md), so nothing can change which one gh picks.
    ["merge", "gh pr merge --squash --admin"],
    // As the shell reads it: digits glued to > name what's redirected, so no pull request is named.
    ["merge", "gh pr merge 5>out.txt"],
    ["merge", 'gh pr merge --squash --body "$(git switch -q feat/other)"'],
    // What runs inside or beside a merge must change nothing: a branch, a pull request, a file.
    ["merge", 'gh pr merge 5 --squash --body "$(git switch -q feat/other)"'],
    ["merge", 'gh pr merge 5 --body "$(gh pr update-branch 5 >/dev/null; echo ok)"'],
    ["merge", "gh pr merge 5 & gh pr edit 5 --base release"],
    ["merge", "gh pr merge 5 | (git push -f origin HEAD:feat)"],
    ["merge", "gh pr merge 5 | while sleep 1; do git push -f origin HEAD:feat; done"],
    // A file written however the stream is named, and a setting's substitution.
    ["merge", "printf 'gh pr merge 5' 2>x.sh 1>&2; bash x.sh"],
    ["merge", "exec 3>x.sh; echo 'gh pr merge 5' >&3; bash x.sh"],
    ["merge", "X=$(printf 'gh pr merge 5'); eval \"$X\""],
    // A case pattern's ) doesn't end the substitution it's in.
    ["merge", 'gh pr merge 5 --squash; echo "$(case x in x) gh pr merge 6 --admin;; esac)"'],
    // A step's redirection can't run anything either.
    ["merge", 'cd . >"$(git push -f origin HEAD:feat/x)" && gh pr merge 5 --squash'],
    // A later & puts the merge in the background with what follows.
    ["merge", "gh pr merge 5 && true & git push -f origin HEAD:feat"],
    ["merge", "gh pr merge 5 | cat & git push -f origin HEAD:feat"],
    // printf -v keeps its words to run later; a program by its path may be anything.
    ["merge", "gh pr merge 5; printf -v x 'gh pr merge 6 --admin'; eval \"$x\""],
    ["merge", "gh pr merge 5 & ./tools/git status"],
    ["merge", "./bin/echo gh pr merge 6"],
    // After --, a word is gh's, not a flag the gate would act on.
    ["merge", "gh pr merge --squash -- --help"],
    ["ready", "gh pr ready -- --undo"],
    // A case inside a substitution: the gate doesn't read its patterns, and stops.
    ["merge", 'echo "$(if true; then case a in a) gh pr merge 5;; esac; fi)"'],
    ["merge", 'echo "$( (case x in a) true;; esac); gh pr merge 5 )"'],
    ["merge", 'echo "$(case x in y) echo esac;; x) gh pr merge 5;; esac)"'],
    // A cd in another form.
    ["merge", "cd -- /w && gh pr merge 5"],
    // The three words beside brackets, commas or backticks, in text a program runs.
    ["merge", "python3 -c 'import subprocess; subprocess.run([\"gh\",\"pr\",\"merge\",\"5\"])'"],
    ["merge", "node -e 'execSync(`gh pr merge 5`)'"],
    ["merge", "bash -c 'x=`gh pr merge 5`'"],
    // A word the gate can't read standing for gh, in text a program runs.
    ["merge", 'sh -c "$(command -v gh) pr merge 5"'],
    // After exec points a stream at a file, printed text may be a script.
    ["merge", "exec >m.sh; echo 'gh pr merge 5'; exec >/dev/tty; bash m.sh"],
    ["merge", "exec 2>m.sh; echo 'gh pr merge 5' >&2; bash m.sh"],
    // A line continued inside text a program runs.
    ["merge", "bash -c 'gh pr mer\\\nge 5'"],
    // pflag keeps the last value: help off, so --auto is read.
    ["merge", "gh pr merge 5 --help --help=false --auto"],
    // Bash reads it; the gate doesn't read case in a substitution, and its text stops it.
    ["merge", "x=$(case a in a) :;; esac); `gh pr merge 5`"],
    // Parentheses paired as bash pairs them: a quoted )) doesn't make a subshell arithmetic.
    ["merge", '((gh pr merge 5; echo "))" ) ) # "'],
    ["merge", 'echo $((gh pr merge 5; echo "))" ) ) # "'],
    // A here-document left open in a substitution is empty: the next line is a command.
    ["merge", "echo $(cat <<EOF)\ngh pr merge 5 --auto\nEOF"],
    // A setting can make a read-only program run something.
    ["merge", "gh pr merge 5 | GIT_EXTERNAL_DIFF=./push.sh git diff HEAD~1"],
    // coproc doesn't hide a later & that backgrounds the merge.
    ["merge", "gh pr merge 5 && coproc true & git push -f"],
    // A write on a group, subshell or loop: what's printed inside may be a script.
    ["merge", "{ echo 'gh pr merge 5 --admin'; } > m.sh && bash m.sh"],
    ["merge", "( echo 'gh pr merge 5 --admin' ) > m.sh && bash m.sh"],
    ["merge", "for x in 1; do echo 'gh pr merge 5'; done > m.sh && bash m.sh"],
    // $'…' escapes known when pairing parentheses.
    ["merge", "echo $((gh pr merge 5; echo $'\\'' ) ) ; echo \"'))\" # \""],
    // Text stored and read back into a program that runs text.
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && git log -1 --format=%B | bash"],
    ["merge", "gh pr comment 9 --body 'gh pr merge 5' && gh pr view 9 --comments | bash"],
    // Piped into a loop that runs what it reads.
    ["merge", "git commit --allow-empty -qm 'gh pr merge 6 --admin' && git log -1 --format=%B | while read -r a b c d e; do $a $b $c $d $e; done"],
    // GH in another case, in text a shell runs.
    ["merge", "gh pr merge 5 --squash; echo 'GH pr merge 6 --admin' | bash"],
    // gh by a path may be any program: a maybe, as on main.
    ["create", "/usr/bin/gh pr create"],
    ["merge", "./gh pr merge 5"],
    ["merge", "gh pr merge 5 & ./scripts/gh pr view 5"],
    // -h and --help are one flag: the last of either wins.
    ["merge", "gh pr merge 5 --squash -h --help=false --auto"],
    // Exotic syntax keeps main's rule too, outside the reviewed command (#925).
    ["merge", "echo ${x:-$'\\''} ; gh pr merge 5 --auto ; echo \"'\" \"}\" #\""],
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && eval \"$(git log -1 --format=%B)\""],
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && bash <(git log -1 --format=%B)"],
    ["merge", 'eval "${u:-gh pr merge 5}"'],
    ["merge", "x=${u:-gh pr merge 5 --auto}; $x"],
    ["merge", "x=$(case a in a) :;; esac); ${u:-gh} pr merge 5"],
    ["merge", "echo \"`echo \\\"'\\\" ; gh pr merge 5 --auto ; echo \\\"'\\\"`\""],
    ["merge", "command exec >m.sh; echo 'gh pr merge 5'; command exec >/dev/tty; bash m.sh"],
    // A wait that doesn't wait for the merge.
    ["merge", "gh pr merge 5 & (wait); git push -f origin HEAD:feat"],
    ["merge", "gh pr merge 5 & sleep 0 & wait -n; git push -f origin HEAD:feat"],
    // A wait that doesn't run in the main shell doesn't end what runs beside the merge.
    ["merge", "gh pr merge 5 & false && wait; git push origin x"],
    ["merge", "gh pr merge 5 & wait & git push origin x"],
    ["merge", "gh pr merge 5 & wait | cat; git push origin x"],
    // Stored text read back through a substitution or a file, not a pipe.
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && bash -c \"$(git log -1 --format=%B)\""],
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && $(git log -1 --format=%B)"],
    ["merge", "git commit --allow-empty -qm 'gh pr merge 5 --admin' && git log -1 --format=%B > m.sh && bash m.sh"],
    // gh repo clone hands its words to git clone.
    ["merge", "gh repo clone o/r /tmp/x -- -c core.sshCommand='gh pr merge 5 --admin #'"],
    // Escapes spell the command where the words don't.
    ["merge", "printf 'g\\x68 pr merge 5 --admin' | bash"],
    // A wait inside an if that may not run.
    ["merge", "gh pr merge 5 &\nif false; then\nwait\nfi\ngit push -f origin HEAD:feat"],
    // $'\c' ends at its quote, so the push beside the merge is seen.
    ["merge", "gh pr merge 5 --subject $'\\c' & git push -f origin HEAD:feat ; echo 'a\\'"],
    // A gh subcommand named like an object's own property.
    ["merge", 'gh pr merge 5 --body "$(gh constructor)"'],
    // A merge or ready in the background: nothing an agent needs, so it stops.
    ["merge", "gh pr merge 5 --squash &\nwait\ngit pull --ff-only"],
    ["merge", "gh pr merge 5 & sleep 0 & wait $!; git push -f origin HEAD:feat"],
    ["ready", "gh pr ready 5 &"],
    // Exotic syntax noted where the reader reads it, apostrophes in double quotes or not.
    ["merge", "echo \"it's\"; x=${u:-gh pr merge 5}; $x; echo \"it's\""],
    // A variable that may be several words stands for more than one of the three.
    ["merge", 'X="gh pr"; $X merge 5'],
    // An array element isn't passed to gh, so its repository can't be read.
    ["merge", "GH_REPO[0]=someone/else gh pr merge 5"],
    // tee into .git writes a ref.
    ["merge", 'gh pr merge 5 --body "$(echo x | tee .git/refs/heads/feat)"'],
    // gh commands that can start a run hand it text that may be run.
    ["merge", "gh workflow run deploy.yml -f script='gh pr merge 5 --admin'"],
    ["merge", "gh api repos/o/r/actions/workflows/d.yml/dispatches -f 'inputs[script]=gh pr merge 5'"],
    // ${ closes at the first }: the second merge isn't inside the first's word.
    ["merge", 'gh pr merge 5 --squash --subject "${x:-{}" ; gh pr merge 6 --squash --subject "}"'],
    // The reviewed command's own body piping text into a shell.
    ["create", 'gh pr create --title t --body "$(echo \'gh pr create -H other -B main\' | sh)"'],
    // Stored and run back inside the reviewed command's own body.
    ["create", 'gh pr create -t x --body "$(git commit --allow-empty -qm \'gh pr create -H other\'; git log -1 --format=%B | sh)"'],
    // for ((…)): a shift, not a here-document, so the next line is read.
    ["merge", "for ((;;true<<1)); do :; done\ngh pr merge 5 --auto"],
    // Unquoted, a here-document's end word is joined across a backslash and a
    // line break, so the merge after it runs (Greptile, #935).
    ["merge", "cat <<EOF\nEO\\\nF\ngh pr merge 5\nEOF"],
    ["merge", "cat <<-EOF\n\tEO\\\nF\ngh pr merge 5\nEOF"],
    // Text bash would refuse, that might be the command.
    ["merge", 'gh pr merge 5 "oops'],
  ];
  for (const [action, command] of table) {
    const read = readCommand(command, action);
    assert.ok(read?.fail, `${command} should be stopped, got ${JSON.stringify(read)}`);
  }
});

test("a long command it can't place comes back, rather than running on", () => {
  // In a process of its own, so a pattern that backtracks without end is
  // stopped and fails here rather than holding up every test after it. The
  // limit is far past the milliseconds it takes, so a busy machine can't fail it.
  const script = `import { readCommand } from ${JSON.stringify(new URL("./review-gate.mjs", import.meta.url).href)};
const longs = ["gh " + "=>".repeat(20_000) + " x", "gh pr " + "2>".repeat(20_000) + " x", ">|A= ".repeat(20_000) + "x", ">&A= ".repeat(20_000) + "x", "$((".repeat(20_000), "$(".repeat(20_000), "((".repeat(20_000) + " x", "(".repeat(50_000) + "x" + " )".repeat(50_000), ("$((1))" + String.fromCharCode(96) + "$((1))" + String.fromCharCode(96) + " ").repeat(20_000), ("g" + "h pr ").repeat(20_000) + String.fromCharCode(39), "echo " + "$(x ".repeat(3_000) + ")".repeat(3_000), "cat <<EOF" + String.fromCharCode(10) + ("x".repeat(79) + String.fromCharCode(92, 10)).repeat(50_000) + "EOF"];
for (const long of longs) if (readCommand(long, "merge") !== null) process.exit(2);`;
  const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, timeout: 60_000 });
  assert.equal(run.status, 0, run.signal ? `still running after a minute (${run.signal})` : String(run.error ?? run.stderr));
});

test("a command that isn't one leaves the gate out", () => {
  for (const [action, command] of [
    ["create", "gh pr view 1"],
    ["create", "gh pr list"],
    ["create", "git status"],
    ["create", "gh pr create --help"],
    ["merge", "gh pr merge -h"],
    ["ready", "gh pr view --json isDraft"],
    // Words, not text (#925): the words of a program that runs nothing it's
    // given (echo, jq, git commit, gh itself) are data, when nothing in its
    // pipeline runs text and it writes no file.
    ["merge", "gh pr view 5 --jq '.merge' | head -1"],
    ["merge", "gh api repos/o/r/pulls/5 --jq '\"merge=\\(.merged)\"' 2>/dev/null"],
    // Quoted, its end word isn't joined across lines, so the merge is in the body.
    ["merge", "cat <<'EOF'\nEO\\\nF\ngh pr merge 5\nEOF"],
    ["merge", "echo 'gh pr merge 5' >&2"],
    ["merge", "for pr in 919 921; do gh pr view $pr --json state --jq '\"merged\"'; done"],
    ["merge", 'git commit -m "fix: gh pr merge 5 later"'],
    ["merge", "cat <<'EOF'\n$(gh pr merge 5)\nEOF"],
    // A here-document body is data, a line in it that reads like the command included.
    ["merge", "cat <<'EOF'\ngh pr merge 5\nEOF"],
    ["merge", "cat <<EOF\ngh pr merge 5\nEOF"],
    ["merge", "cat <<-EOF\n\tgh pr merge 5\n\tEOF"],
    ["merge", "gh pr view 5 --json title,mergedAt && echo merge"],
    // Variables alone, three in a row, aren't the command.
    ["merge", 'for f in *.txt; do cp "$f" "$DEST/$f" "$X"; done'],
    // gh2 isn't gh: digits glued to > belong to the word before.
    ["merge", "gh2>a pr merge 5"],
    ["ready", "gh pr ready 12 --undo"],
  ]) assert.equal(readCommand(command, action), null, command);
});

test("each flag is read with its value", () => {
  const { flags, positional } = parseWords(["5", "--subject", "--auto", "-b--repo=x", "--squash", "-A", "me@x"], "merge");
  assert.deepEqual(flags.get("--subject"), ["--auto"]);
  assert.deepEqual(flags.get("--body"), ["--repo=x"]);
  assert.deepEqual(flags.get("--author-email"), ["me@x"]);
  assert.equal(flags.has("--auto"), false);
  assert.equal(flags.has("--repo"), false);
  assert.deepEqual(positional, [{ word: "5", at: 0 }]);
});

test("two base branches never share a record", () => {
  const head = "a".repeat(40);
  const names = ["release/foo", "release_foo", "release%2ffoo", "release%2f;foo", "main"].map((base) => recordName(head, base));
  assert.equal(new Set(names).size, names.length, names.join(" "));
  for (const name of names) assert.match(name, /^[\w.%;-]+$/);
});

test("words come out as the shell hands them over", () => {
  assert.equal(unquote(`"a b"`), "a b");
  assert.equal(unquote(`'a "b"'`), 'a "b"');
  assert.equal(unquote(`a"b c"'d'`), "ab cd");
  assert.equal(unquote(`"a\\"b"`), 'a"b');
  assert.equal(unquote("$'a\\tb'"), "a\tb");
  assert.equal(unquote("a\\ b"), "a b");
  assert.equal(unquote("a\\\nb"), "ab");
});

test("the reviewer's verdict is its last line, and no verdict is findings", () => {
  assert.equal(verdict("(none)\nREVIEW: clean"), "clean");
  assert.equal(verdict("(none)\n\n`REVIEW: clean`\n"), "clean");
  assert.equal(verdict("**REVIEW: Clean**"), "clean");
  assert.equal(verdict("1. x\nREVIEW: findings"), "findings");
  assert.equal(verdict("REVIEW: clean\n1. one more thing"), "findings");
  assert.equal(verdict("nothing said"), "findings");
  assert.equal(verdict(""), "findings");
  // Without the line, only an answer that is nothing at all.
  assert.equal(verdict("```json\n[]\n```"), "clean");
  assert.equal(verdict("(none)"), "clean");
  assert.equal(verdict("[]"), "clean");
  assert.equal(verdict('```json\n[{"file": "a"}]\n```'), "findings");
});

test("a GitHub address names its repository; anything else names none", () => {
  assert.equal(repoOf("https://github.com/itsMattGuenther/Linger.git"), "itsmattguenther/linger");
  assert.equal(repoOf("git@github.com:itsMattGuenther/Linger.git"), "itsmattguenther/linger");
  assert.equal(repoOf("https://github.com/o/r"), "o/r");
  assert.equal(repoOf("git@github-work:o/r.git"), "o/r", "an SSH host alias");
  assert.equal(repoOf("ssh://git@github.com/o/r.git"), "o/r");
  assert.equal(repoOf("ssh://git@github.com:22/o/r"), "o/r");
  assert.equal(repoOf("/tmp/origin.git"), null);
  assert.equal(repoOf("/tmp/a/origin.git"), null);
  assert.equal(repoOf("file:///tmp/a/b.git"), null);
  assert.equal(repoOf(null), null);
});

test("folders follow each cd from where the command starts", () => {
  assert.equal(folderOf("/a", []), "/a");
  assert.equal(folderOf("/a", ["b", "../c"]), "/a/c");
  assert.equal(folderOf("/a", ["/x", "y"]), "/x/y");
  assert.equal(folderOf("/a", ["~/p"], "/home/me"), "/home/me/p");
  assert.equal(folderOf("/a", ["~"], "/home/me"), "/home/me");
});

test("the reviewer only reads, reviews just the commits, and is told the questions", () => {
  const args = reviewerArgs({ level: "high", base: "b".repeat(40), head: "h".repeat(40), questions: "QUESTIONS HERE" });
  assert.equal(args[0], "-p");
  assert.equal(args[1], `/code-review high ${"b".repeat(40)}...${"h".repeat(40)}`);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--append-system-prompt"));
  for (const tool of tools) assert.doesNotMatch(tool, /^(?:Edit|Write|NotebookEdit)$|^Bash\((?!git (?:diff|log|show|blame|merge-base|rev-parse|status):)/, tool);
  assert.ok(!tools.includes("Skill"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user", "a pull request's .claude/ settings don't load");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.match(args.at(-1), /QUESTIONS HERE/);
  assert.match(args.at(-1), /REVIEW: clean/);
});

test("the reviewer is the Claude that's running only when that is Claude's own program", () => {
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "/opt/claude/2.1/claude" }), "/opt/claude/2.1/claude");
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "C:\\Claude\\claude.exe" }), "C:\\Claude\\claude.exe");
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "/usr/bin/node" }), "claude");
  assert.equal(reviewerCommand({}), "claude");
  assert.equal(reviewerCommand({ LINGER_REVIEWER: "/x/stub", CLAUDE_CODE_EXECPATH: "/opt/claude" }), "/x/stub");
});

test("Claude Code runs the gate before each command it guards, and a gate that fails stops the command", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const hooks = settings.hooks.PreToolUse.filter((group) => group.matcher === "Bash").flatMap((group) => group.hooks);
  for (const action of ACTIONS) {
    const mine = hooks.filter((hook) => hook.if === `Bash(gh pr ${action}:*)`);
    assert.equal(mine.length, 1, `one hook for gh pr ${action}`);
    assert.match(mine[0].command, new RegExp(`scripts/review-gate\\.mjs" --hook ${action}$`));
    assert.equal(mine[0].onFailure, "block", `a gate that crashes or runs out of time stops gh pr ${action}`);
    // gh, the pull request's fetch, the base's fetch and the questions each
    // have NETWORK_MS, then the review its own limit; the hook outlasts all.
    assert.ok(mine[0].timeout * 1000 > REVIEW_MS + 4 * NETWORK_MS + 60 * 1000, "the hook outlasts the review and every wait before it");
  }
});

// A repository with its origin on "GitHub" (a bare repository standing in
// through git's insteadOf), a branch with a change, and stand-ins for the
// reviewer and gh that log what they were asked.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "review-gate-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    TMPDIR: join(root, "tmp"),
    LINGER_REVIEWER: join(root, "reviewer.mjs"),
    LINGER_REVIEW_GH: join(root, "gh.mjs"),
    STUB_LOG: join(root, "calls.log"),
  };
  delete env.LINGER_COLD_REVIEW;
  delete env.LINGER_REVIEW_LEVEL;
  delete env.GH_REPO;
  mkdirSync(env.TMPDIR);
  const bare = join(root, "origin.git");
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "${bare}"]\n\tinsteadOf = ${URL_OF}\n[commit]\n\tgpgsign = false\n`);
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const repo = join(root, "repo");
  run(root, "init", "--quiet", "-b", "main", repo);
  run(repo, "remote", "add", "origin", URL_OF);
  const put = (dir, path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (dir, path, text) => {
    put(dir, path, text);
    run(dir, "add", "-A");
    run(dir, "commit", "--quiet", "-m", `change ${path}`);
    return run(dir, "rev-parse", "HEAD");
  };
  put(repo, "scripts/review-gate.mjs", "// the gate, so this repository is gated\n");
  put(repo, "docs/pr-questions.md", readFileSync(join(ROOT, "docs/pr-questions.md"), "utf8"));
  const main = commit(repo, "README.md", "readme\n");
  run(repo, "push", "--quiet", "origin", "main");
  run(repo, "checkout", "--quiet", "-b", "feat/x");
  const head = commit(repo, "client/src/thing.ts", "export const one = 1;\n");

  writeFileSync(env.LINGER_REVIEWER, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify({ who: "reviewer", cwd: process.cwd(), args: process.argv.slice(2), cold: process.env.LINGER_COLD_REVIEW, sawUncommitted: existsSync("client/src/scratch.ts") }) + "\\n");
const how = process.env.STUB_VERDICT || "findings";
if (how === "fail") { console.error("no luck"); process.exit(1); }
if (how === "garbage") { console.log("not json"); process.exit(0); }
if (how === "error") { console.log(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" })); process.exit(0); }
console.log(JSON.stringify({ type: "result", is_error: false, result: how === "clean" ? "(none)\\nREVIEW: clean" : "1. client/src/thing.ts:1: a stand-in finding.\\nREVIEW: findings" }));
`);
  writeFileSync(env.LINGER_REVIEW_GH, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify({ who: "gh", args: process.argv.slice(2) }) + "\\n");
if (!process.env.STUB_PR) { console.error("HTTP 401: Bad credentials"); process.exit(1); }
const asked = readFileSync(process.env.STUB_LOG, "utf8").split("\\n").filter((line) => line.includes('"who":"gh"')).length;
console.log(asked > 1 && process.env.STUB_PR_LATER ? process.env.STUB_PR_LATER : process.env.STUB_PR);
`);
  chmodSync(env.LINGER_REVIEWER, 0o755);
  chmodSync(env.LINGER_REVIEW_GH, 0o755);

  const calls = () => (existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const gate = (action, command, { cwd = repo, extra = {}, input } = {}) => {
    const result = spawnSync(process.execPath, [GATE, "--hook", action], {
      input: input ?? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return { code: result.status, stderr: result.stderr, stdout: result.stdout };
  };
  const markers = (dir = repo) => {
    const folder = join(dir, ".git", "linger-review");
    return existsSync(folder) ? execFileSync("ls", [folder], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
  };
  return { root, repo, env, run, put, commit, main, head, calls, gate, markers, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("findings stop the pull request once and are handed over; the same commit then passes", () => {
  const box = sandbox();
  try {
    const first = box.gate("create", "gh pr create --title t --body b");
    assert.equal(first.code, 2, first.stderr);
    assert.match(first.stderr, /a stand-in finding/);
    assert.match(first.stderr, new RegExp(box.head.slice(0, 10)));
    const [call] = box.calls();
    assert.equal(call.who, "reviewer");
    assert.equal(call.args[1], `/code-review high ${box.main}...${box.head}`);
    assert.equal(call.cold, "1", "the reviewer's own commands don't start another review");
    assert.ok(call.cwd.startsWith(join(box.env.TMPDIR, WORKTREE_PREFIX)), `a clean copy of the commit, not the folder: ${call.cwd}`);
    assert.equal(existsSync(call.cwd), false, "the copy is removed");
    assert.deepEqual(box.markers(), [recordName(box.head, "main")]);

    const again = box.gate("create", "gh pr create --title t --body b");
    assert.equal(again.code, 0, again.stderr);
    assert.equal(box.calls().length, 1, "the same commit isn't reviewed twice");

    const next = box.commit(box.repo, "client/src/thing.ts", "export const one = 2;\n");
    const fixed = box.gate("create", "gh pr create --title t --body b", { extra: { STUB_VERDICT: "clean" } });
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(JSON.parse(fixed.stdout).systemMessage, /found nothing/);
    assert.equal(box.calls().length, 2, "a new commit gets a new review");
    assert.equal(box.calls()[1].args[1], `/code-review high ${box.main}...${next}`);
    assert.equal(JSON.parse(readFileSync(join(box.repo, ".git/linger-review", recordName(next, "main")), "utf8")).verdict, "clean");
  } finally {
    box.done();
  }
});

test("a reviewer that fails stops the command and records nothing, so the next try reviews", () => {
  const box = sandbox();
  try {
    for (const how of ["fail", "garbage", "error"]) {
      const result = box.gate("create", "gh pr create -t t", { extra: { STUB_VERDICT: how } });
      assert.equal(result.code, 2, how);
      assert.match(result.stderr, /couldn't run/, how);
      assert.deepEqual(box.markers(), [], how);
    }
    const missing = box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEWER: join(box.root, "nowhere") } });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /couldn't start/);
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { STUB_VERDICT: "clean" } }).code, 0);
  } finally {
    box.done();
  }
});

test("the folder a cd moves to is the one reviewed", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "cd repo && gh pr create -t t", { cwd: box.root });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(box.calls()[0].args[1], `/code-review high ${box.main}...${box.head}`);
    const gone = box.gate("create", "cd nowhere && gh pr create -t t", { cwd: box.root });
    assert.equal(gone.code, 2);
    assert.match(gone.stderr, /isn't there/);
  } finally {
    box.done();
  }
});

test("nothing is reviewed for docs only, nothing to review, inside a review, or another repository", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "checkout", "--quiet", "-b", "docs/y", "main");
    box.commit(box.repo, "docs/guide.md", "words\n");
    box.commit(box.repo, "assets/logo.png", "png\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 0, "docs only");
    box.run(box.repo, "checkout", "--quiet", "main");
    assert.equal(box.gate("create", "gh pr create -t t").code, 0, "nothing on main to review");
    box.run(box.repo, "checkout", "--quiet", "feat/x");
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { LINGER_COLD_REVIEW: "1" } }).code, 0, "inside a review");
    assert.equal(box.gate("merge", "gh pr merge 5 -R someone/else").code, 0, "another repository");
    assert.equal(box.gate("create", "GH_REPO=someone/else gh pr create").code, 0, "another repository by setting");
    const other = join(box.root, "other");
    box.run(box.root, "init", "--quiet", "-b", "main", other);
    box.commit(other, "a.ts", "x\n");
    assert.equal(box.gate("create", "gh pr create", { cwd: other }).code, 0, "a repository without the gate");
    assert.deepEqual(box.calls(), []);
    // The same repository named in full is still gated.
    assert.equal(box.gate("create", "gh pr create -R test/Linger").code, 2);
  } finally {
    box.done();
  }
});

test("a command it can't read, or input that isn't the hook's, is stopped before any review", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "ls && gh pr create");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Stopped before review/);
    assert.equal(box.gate("create", "", { input: "not json" }).code, 2);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.done();
  }
});

test("a merge reviews the pull request's own commit in a copy, fetching it if need be, and removes the copy", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", `${box.head}:refs/pull/7/head`);
    // A clone that has never seen the pull request's commit.
    const clone = join(box.root, "clone");
    box.run(box.root, "clone", "--quiet", "--no-local", URL_OF, clone);
    assert.throws(() => box.run(clone, "cat-file", "-e", `${box.head}^{commit}`));
    // A copy a killed run left behind, two and a half hours ago.
    const stale = mkdtempSync(join(box.env.TMPDIR, WORKTREE_PREFIX));
    box.run(clone, "worktree", "add", "--quiet", "--detach", stale, "HEAD");
    const old = (Date.now() - 2.5 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);

    const pr = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger/pull/7" });
    const result = box.gate("merge", "gh pr merge 7 --squash --admin", { cwd: clone, extra: { STUB_PR: pr } });
    assert.equal(result.code, 2, result.stderr);
    const [gh, reviewer] = box.calls();
    assert.ok(reviewer, `the reviewer ran: ${result.stderr}`);
    assert.deepEqual(gh.args.slice(0, 3), ["pr", "view", "7"]);
    assert.equal(reviewer.args[1], `/code-review high ${box.main}...${box.head}`);
    assert.ok(reviewer.cwd.startsWith(join(box.env.TMPDIR, WORKTREE_PREFIX)), reviewer.cwd);
    assert.notEqual(reviewer.cwd, stale);
    assert.equal(existsSync(reviewer.cwd), false, "the copy is removed");
    assert.equal(existsSync(stale), false, "the copy a killed run left is cleared");
    assert.equal(box.run(clone, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    assert.deepEqual(box.markers(clone), [recordName(box.head, "main")]);

    assert.equal(box.gate("merge", "gh pr merge 7 --squash --admin", { cwd: clone, extra: { STUB_PR: pr } }).code, 0, "the same commit passes");
  } finally {
    box.done();
  }
});

test("a merge of a pull request that isn't open passes, and gh failing stops it", () => {
  const box = sandbox();
  try {
    const merged = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "MERGED", url: "https://github.com/test/linger/pull/7" });
    assert.equal(box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: merged } }).code, 0);
    const failed = box.gate("merge", "gh pr merge 7");
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /gh couldn't say which pull request/);
    const odd = box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: JSON.stringify({ number: 7, headRefOid: "nope", state: "OPEN" }) } });
    assert.equal(odd.code, 2);
    // gh's answer names the repository, so another project's pull request passes.
    const site = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger-site/pull/7" });
    assert.equal(box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: site } }).code, 0);
    assert.ok(!box.calls().some((call) => call.who === "reviewer"));
  } finally {
    box.done();
  }
});

test("the reviewer is given the questions for the change, and the pull request's own scripts never run", () => {
  const box = sandbox();
  try {
    const ran = join(box.root, "ran");
    box.commit(box.repo, "scripts/pr-questions.mjs", `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "x");\n`);
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    const prompt = box.calls()[0].args.at(-1);
    // client/src is the page, so the page's questions, and not the server's alone.
    assert.match(prompt, /Is anything worked out from a room's history/);
    assert.equal(existsSync(ran), false, "the pull request's own script didn't run");
  } finally {
    box.done();
  }
});

test("a review is per base branch, and records past keeping are deleted", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", "main:release");
    const records = join(box.repo, ".git", "linger-review");
    mkdirSync(records, { recursive: true });
    const old = join(records, recordName("0".repeat(40), "main"));
    writeFileSync(old, "{}");
    const then = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, then, then);
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.gate("create", "gh pr create -B release -t t").code, 2, "another base is another review");
    assert.equal(box.calls().length, 2);
    assert.equal(existsSync(old), false, "a record forty days old is gone");
  } finally {
    box.done();
  }
});

test("a review level that isn't one stops the command", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEW_LEVEL: "ultra" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /LINGER_REVIEW_LEVEL/);
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEW_LEVEL: "low" } }).code, 2);
    assert.match(box.calls()[0].args[1], /^\/code-review low /);
  } finally {
    box.done();
  }
});

test("what's uncommitted in the folder isn't reviewed as the commit", () => {
  const box = sandbox();
  try {
    box.put(box.repo, "client/src/scratch.ts", "not committed\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.calls()[0].sawUncommitted, false);
  } finally {
    box.done();
  }
});

test("code moved into docs is still reviewed", () => {
  const box = sandbox();
  try {
    // Code that's on main, moved into docs/ on a branch of its own.
    box.run(box.repo, "checkout", "--quiet", "main");
    box.commit(box.repo, "client/src/old.ts", "export const old = 1;\n");
    box.run(box.repo, "push", "--quiet", "origin", "main");
    box.run(box.repo, "checkout", "--quiet", "-b", "feat/move");
    mkdirSync(join(box.repo, "docs"), { recursive: true });
    box.run(box.repo, "mv", "client/src/old.ts", "docs/old.md");
    box.run(box.repo, "commit", "--quiet", "-m", "move");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.calls().length, 1);
  } finally {
    box.done();
  }
});

test("from a fork, the pull request's base is upstream's, and naming upstream is still gated", () => {
  const box = sandbox();
  try {
    // The fork's main is a commit behind upstream's; the branch starts from upstream's.
    const fork = join(box.root, "fork.git");
    box.run(box.root, "clone", "--quiet", "--bare", "--no-local", URL_OF, fork);
    const forkUrl = "https://github.com/me/linger.git";
    writeFileSync(box.env.GIT_CONFIG_GLOBAL, readFileSync(box.env.GIT_CONFIG_GLOBAL, "utf8") + `[url "${fork}"]\n\tinsteadOf = ${forkUrl}\n`);
    box.run(box.repo, "checkout", "--quiet", "main");
    const newer = box.commit(box.repo, "client/src/later.ts", "later\n");
    box.run(box.repo, "push", "--quiet", "origin", "main");
    box.run(box.repo, "remote", "rename", "origin", "upstream");
    box.run(box.repo, "remote", "add", "origin", forkUrl);
    box.run(box.repo, "fetch", "--quiet", "origin");
    box.run(box.repo, "checkout", "--quiet", "-b", "feat/fork", newer);
    const head = box.commit(box.repo, "client/src/mine.ts", "mine\n");

    assert.equal(box.gate("create", "gh pr create -R test/linger -t t").code, 2, "naming upstream is this repository");
    assert.equal(box.calls()[0].args[1], `/code-review high ${newer}...${head}`, "only the branch's own commit");
    box.commit(box.repo, "client/src/mine.ts", "mine again\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2, "with none named, upstream");
    assert.match(box.calls()[1].args[1], new RegExp(`^/code-review high ${newer}\\.\\.\\.`));
  } finally {
    box.done();
  }
});

test("the questions not read stops the review, rather than reviewing without them", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "rm", "--quiet", "docs/pr-questions.md");
    box.commit(box.repo, "client/src/thing.ts", "export const one = 3;\n");
    const result = box.gate("create", "gh pr create -t t");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /questions couldn't be read/);
    assert.equal(box.calls().length, 0);
    assert.deepEqual(box.markers(), []);
  } finally {
    box.done();
  }
});

test("a pull request pushed to during its review isn't merged", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", `${box.head}:refs/pull/7/head`);
    const pr = (head) => JSON.stringify({ number: 7, headRefOid: head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger/pull/7" });
    const moved = box.gate("merge", "gh pr merge 7 --squash", { extra: { STUB_VERDICT: "clean", STUB_PR: pr(box.head), STUB_PR_LATER: pr("b".repeat(40)) } });
    assert.equal(moved.code, 2, moved.stderr);
    assert.match(moved.stderr, /changed during the review/);
    // Reviewed and unchanged, it goes through.
    const same = box.gate("merge", "gh pr merge 7 --squash", { extra: { STUB_PR: pr(box.head) } });
    assert.equal(same.code, 0, same.stderr);
  } finally {
    box.done();
  }
});
