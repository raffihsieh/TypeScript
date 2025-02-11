// @ts-check
/// <reference lib="esnext.asynciterable" />
const Octokit = require("@octokit/rest");
const { runSequence } = require("./run-sequence");

// The first is used by bot-based kickoffs, the second by automatic triggers
const triggeredPR = process.env.SOURCE_ISSUE || process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER;

/**
 * This program should be invoked as `node ./scripts/update-experimental-branches <GithubAccessToken> <PR1> [PR2] [...]`
 * The order PR numbers are passed controls the order in which they are merged together.
 * TODO: the following is racey - if two experiment-enlisted PRs trigger simultaneously and witness one another in an unupdated state, they'll both produce
 * a new experimental branch, but each will be missing a change from the other. There's no _great_ way to fix this beyond setting the maximum concurrency
 * of this task to 1 (so only one job is allowed to update experiments at a time). 
 */
async function main() {
    const prnums = process.argv.slice(3);
    if (!prnums.length) {
        return; // No enlisted PRs, nothing to update
    }
    if (!prnums.some(n => n === triggeredPR)) {
        return; // Only have work to do for enlisted PRs
    }
    console.log(`Performing experimental branch updating and merging for pull requests ${prnums.join(", ")}`);

    const userName = process.env.GH_USERNAME;
    const remoteUrl = `https://${process.argv[2]}@github.com/${userName}/TypeScript.git`;

    // Forcibly cleanup workspace
    runSequence([
        ["git", ["clean", "-fdx"]],
        ["git", ["checkout", "."]],
        ["git", ["checkout", "master"]],
        ["git", ["remote", "add", "fork", remoteUrl]], // Add the remote fork
        ["git", ["fetch", "origin", "master:master"]],
    ]);

    const gh = new Octokit();
    gh.authenticate({
        type: "token",
        token: process.argv[2]
    });
    for (const numRaw of prnums) {
        const num = +numRaw;
        if (num) {
            // PR number rather than branch name - lookup info
            const inputPR = await gh.pulls.get({ owner: "Microsoft", repo: "TypeScript", number: num });
            // GH calculates the rebaseable-ness of a PR into its target, so we can just use that here
            if (!inputPR.data.rebaseable) {
                if (+triggeredPR === num) {
                    await gh.issues.createComment({
                        owner: "Microsoft",
                        repo: "TypeScript",
                        number: num,
                        body: `This PR is configured as an experiment, and currently has merge conflicts with master - please rebase onto master and fix the conflicts.`
                    });
                    throw new Error(`Merge conflict detected in PR ${num} with master`);
                }
                return; // A PR is currently in conflict, give up
            }
            runSequence([
                ["git", ["fetch", "origin", `pull/${num}/head:${num}`]],
                ["git", ["checkout", `${num}`]],
                ["git", ["rebase", "master"]],
                ["git", ["push", "-f", "-u", "fork", `${num}`]], // Keep a rebased copy of this branch in our fork
            ]);

        }
        else {
            throw new Error(`Invalid PR number: ${numRaw}`);
        }
    }

    // Return to `master` and make a new `experimental` branch
    runSequence([
        ["git", ["checkout", "master"]],
        ["git", ["branch", "-D", "experimental"]],
        ["git", ["checkout", "-b", "experimental"]],
    ]);

    // Merge each branch into `experimental` (which, if there is a conflict, we now know is from inter-experiment conflict)
    for (const branch of prnums) {
        // Find the merge base
        const mergeBase = runSequence([
            ["git", ["merge-base", branch, "experimental"]],
        ]);
        // Simulate the merge and abort if there are conflicts
        const mergeTree = runSequence([
            ["git", ["merge-tree", mergeBase.trim(), branch, "experimental"]]
        ]);
        if (mergeTree.indexOf(`===${"="}===`)) { // 7 equals is the center of the merge conflict marker
            throw new Error(`Merge conflict detected involving PR ${branch} with other experiment`);
        }
        // Merge (always producing a merge commit)
        runSequence([
            ["git", ["merge", branch, "--no-ff"]],
        ]);
    }
    // Every branch merged OK, force push the replacement `experimental` branch
    runSequence([
        ["git", ["push", "-f", "-u", "fork", "experimental"]],
    ]);
}

main().catch(e => (console.error(e), process.exitCode = 2));
