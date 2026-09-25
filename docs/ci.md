# Using ratchet in CI

## GitHub Actions

```yaml
name: ratchet
on:
  pull_request:
    paths: ["package.json", "package-lock.json"]   # only when dependencies change

permissions:
  contents: read
  pull-requests: write      # the verdict comment
  security-events: write    # only if sarif: "true"

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # the base commit's lockfile must be readable
      - uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
        with:
          fail-on: broken
```

The action compares the pull request's lockfile with its base commit, runs
your `scripts.test` in a sandbox, posts **one** comment and updates it on every
push, and fails the check according to `fail-on`.

| Input | Default | Meaning |
|---|---|---|
| `base` | the pull request's base commit | Git ref whose `package-lock.json` is the "before" state |
| `project-dir` | `.` | Directory with `package.json` and `package-lock.json` |
| `fail-on` | `broken` | `broken` or `risky` |
| `comment` | `true` | Post and update the verdict comment |
| `registry-auth` | `false` | Private registries through the credential-holding proxy (needs `isolation: container`, ratchet-verify 0.6.0+). Token via the step's `env`; registry settings come from the base branch. See [private-registries.md](private-registries.md). |
| `sarif` | `false` | Upload results to code scanning (needs `security-events: write`) |
| `isolation` | `temp-dir` | `temp-dir`, `container` or `auto`. GitHub-hosted Ubuntu runners have docker, so `container` works out of the box (the image is pulled on the first run) |
| `ratchet-version` | `latest` | Version or tag of `ratchet-verify` to run |
| `node-version` | `24` | Node.js used to run ratchet and your tests |

Outputs: `verdict` (`safe`, `risky` or `broken`) and `report-dir` (holding
`report.json`, `report.md`, `report.sarif`).

Notes:
- The comment is only posted on `pull_request` events. On pull requests from
  forks the token is read-only, so the comment step can't post; the check
  result still works.
- `GITHUB_TOKEN` reaches ratchet only for changelog lookups. It is never
  passed to the sandbox that installs and tests the candidate versions.
- Pin `ratchet-version` to an exact version (for example `0.1.1`) if you want
  reproducible checks.

### Dependabot and Renovate

Both open ordinary pull requests that change `package.json` and
`package-lock.json`, so the workflow above runs on them unchanged. To make a
red verdict block merging, mark the `ratchet` check as required in the
repository's branch protection rules.

Dependabot pull requests are treated like pull requests from forks for secrets,
and their `GITHUB_TOKEN` is read-only by default. With the `permissions:` block
shown above (`pull-requests: write`), the workflow in this repository posted its
verdict comment on a real Dependabot pull request (a `@types/node` 24 → 26 bump)
and passed. If your organisation restricts the token further and the comment
step cannot post, the check result and the `report-dir` output (or `--sarif`
with code scanning) still carry the details.

## Any other CI system

The CLI is self-contained, so anything that can run Node 24 works:

```
git fetch origin main
npx ratchet-verify . --base origin/main --markdown --report-dir ratchet-report
```

- The exit code is the gate: `0` ok, `1` at or above `--fail-on`, `2` could not
  run.
- `ratchet-report/report.md` is ready to paste into a comment; `report.json`
  and `report.sarif` are for tooling. See [report-format.md](report-format.md).
- Make the base ref available (`git fetch`, or a full clone) and run on the
  *branch with the bump*, so the working tree's lockfile is the "after" state.

### GitLab CI

> **Untested on GitLab CI.** This recipe is adapted from the GitHub Action behaviour. Corrections welcome.

```yaml
ratchet:
  image: node:24
  only:
    - merge_requests
    changes:
      - package.json
      - package-lock.json
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - npx ratchet-verify . --base origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME --fail-on broken --markdown --report-dir ratchet-report
  artifacts:
    paths:
      - ratchet-report/
    reports:
      sast: ratchet-report/report.sarif
    when: always
  after_script:
    - |
      EXIT_CODE=$?
      if [ $EXIT_CODE -ne 0 ]; then
        echo "ratchet check failed with exit code $EXIT_CODE"
        exit $EXIT_CODE
      fi
```

For merge requests from forks, you may need to set `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`
explicitly. Adjust `fail-on` to `risky` if needed. The SARIF report is optional
and requires SAST feature to be enabled in your project. The `ratchet-report/report.md`
can be posted as a comment via the GitLab API if your CI has the appropriate token.

For `isolation: container` (recommended), the runner must have docker or podman available.

### Azure DevOps

> **Untested on Azure DevOps.** This recipe is adapted from the GitHub Action behaviour. Corrections welcome.

```yaml
trigger:
  branches:
    include: [main]
    exclude: [refs/tags/*]
  paths:
    include:
      - package.json
      - package-lock.json

pr:
  branches:
    include: [main]
  paths:
    include:
      - package.json
      - package-lock.json

jobs:
  - job: Ratchet
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: 24
      - script: |
          git fetch origin $(System.PullRequest.TargetBranch)
          npx ratchet-verify . --base origin/$(System.PullRequest.TargetBranch) --fail-on broken --markdown --report-dir ratchet-report
        displayName: Run ratchet
        continueOnError: true
      - task: PublishBuildArtifacts@1
        condition: always()
        inputs:
          pathToPublish: ratchet-report
          artifactName: ratchet-report
      - task: PublishSecurityAnalysisLogs@1
        condition: always()
        inputs:
          ArtifactName: CodeAnalysisLogs
          ArtifactType: Container
          AllTools: false
          SarifToolFilter: sarif
```

The `continueOnError: true` allows the job to complete even if ratchet exits with code 1
(verdict failure), but the `ratchet-report` artifact is still published. Adjust the `vmImage`
if your organization prefers a different base image. For `isolation: container`, ensure
docker is available on the image. The SARIF report can be published via `PublishSecurityAnalysisLogs`
if configured in your Azure DevOps instance.

### CircleCI

> **Untested on CircleCI.** This recipe is adapted from the GitHub Action behaviour. Corrections welcome.

```yaml
version: 2.1

workflows:
  test:
    jobs:
      - ratchet:
          filters:
            branches:
              ignore: main

jobs:
  ratchet:
    docker:
      - image: node:24
    steps:
      - checkout
      - run:
          name: Fetch base ref
          command: |
            git fetch origin main
      - run:
          name: Run ratchet
          command: |
            npx ratchet-verify . --base origin/main --fail-on broken --markdown --report-dir ratchet-report
          no_output_timeout: 20m
      - store_artifacts:
          path: ratchet-report
          destination: ratchet-report
      - run:
          name: Check ratchet exit code
          command: |
            if [ $? -ne 0 ]; then
              exit 1
            fi
          when: always
```

The `no_output_timeout` prevents CircleCI from killing long test runs. The `store_artifacts`
step uploads the entire report directory (including JSON, Markdown, and SARIF) for download
and inspection. Adjust the `image` if your project requires a different Node version or base
image. The exit code from ratchet is checked to fail the job appropriately.

### Jenkins

> **Untested on Jenkins.** This recipe is adapted from the GitHub Action behaviour. Corrections welcome.

```groovy
pipeline {
    agent {
        docker {
            image 'node:24'
            args '-v /var/run/docker.sock:/var/run/docker.sock'
        }
    }
    triggers {
        githubPullRequest(
            branches: [[compareBranch: 'main']],
            filesToCheck: 'package.json,package-lock.json'
        )
    }
    stages {
        stage('Fetch base') {
            steps {
                sh 'git fetch origin main'
            }
        }
        stage('Run ratchet') {
            steps {
                sh '''
                    npx ratchet-verify . --base origin/main --fail-on broken --markdown --report-dir ratchet-report
                    RATCHET_EXIT=$?
                    echo "Ratchet exit code: $RATCHET_EXIT"
                    if [ $RATCHET_EXIT -eq 1 ]; then
                        echo "Ratchet verdict is at or above fail-on level"
                    fi
                    exit $RATCHET_EXIT
                '''
            }
        }
    }
    post {
        always {
            archiveArtifacts artifacts: 'ratchet-report/**', allowEmptyArchive: true
            publishHTML([
                reportDir: 'ratchet-report',
                reportFiles: 'report.md',
                reportName: 'Ratchet Report'
            ])
        }
        unstable {
            step([$class: 'GitHubCommitStatusSetter', contextSource: [$class: 'ManuallyEnteredCommitContextSource', context: 'ratchet/report']])
        }
    }
}
```

The Jenkins pipeline uses a Docker agent with Node 24. The `githubPullRequest` trigger only runs
on pull requests that modify `package.json` or `package-lock.json`. The exit code from ratchet
is captured and used to fail or mark the stage unstable. Artifacts are archived and a report
can be published as HTML if desired. For `isolation: container`, the `/var/run/docker.sock`
mount allows docker-in-docker if needed. Adjust the base branch name (currently `main`) to
match your repository's default branch.

## Choosing `fail-on`

| Setting | Effect | Good for |
|---|---|---|
| `broken` (default) | Only failing tests / installs fail the check | Getting started; noisy codebases |
| `risky` | Also fails on breaking changes that hit your code, and on bumps nothing could verify (no test script, a suite that was already red) | Projects with a solid test suite and a habit of reading the excerpt |

A `safe (partial)` verdict never fails the check: read its caveats.

## Running it on a schedule

Dependencies also drift without a pull request. To check a lockfile that
changed on `main`, run the same command with `--base` pointing at the previous
commit (`--base HEAD~1`).

## Security notes for CI

Installing a candidate version executes its install scripts. By default ratchet
strips credentials from that environment and redirects the home directory
(`temp-dir` isolation), which does not stop a script from reading host files.
In CI, prefer `isolation: container` (docker or podman, present on GitHub-hosted
Ubuntu runners): the install and the tests then see only the sandbox directory.
Either way, run on ephemeral runners rather than machines holding long-lived
secrets. For private registries use the opt-in registry proxy
(`registryAuth`, see [private-registries.md](private-registries.md)) and keep
`--base`: with it the registry settings come from the base branch, so a pull
request cannot redirect your registry token. Details in the [README](../README.md#safety-of-the-install-step) and
[configuration.md](configuration.md#isolation).
