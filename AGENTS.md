# Agent instructions

## Releasing a new version

Installed copies of the plugin update only when the `version` in `.claude-plugin/plugin.json` goes up. To release:

1. On an up-to-date `master`, bump `version` in `.claude-plugin/plugin.json`. Use a minor bump for a new feature and a patch bump for a fix.
2. Commit only that change as `Release X.Y.Z` and push `master`.
3. Create the GitHub release, tagged `vX.Y.Z` and titled `X.Y.Z`:

   ```sh
   gh release create vX.Y.Z --target master --title X.Y.Z --notes-file <notes file>
   ```

   The workflow in `.github/workflows/release.yml` creates a release with generated notes when a bump reaches `master` without one. If it got there first, `gh release create` fails because the release exists. Replace its notes with `gh release edit vX.Y.Z --notes-file <notes file>`.

Release notes are one short bullet per change since the previous tag, written for people who use the plugin. Start each bullet with a verb, such as Add, Let or Fix, and say what changes for the reader. Leave out tests and internal refactors. List the changes with `git log --oneline v<previous>..master`.
