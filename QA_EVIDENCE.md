# QA_EVIDENCE — webui-ci-drop-npm-cache-zip (manifest half, 2026-09-23)

| # | action | expected | actual |
|---|---|---|---|
| 1 | `ftask ci sync --dry-run \| diff -q - ~/code/hermes-ci-gates.tasks/webui-ci-drop-npm-cache-zip/gates/web-ui.yml` | empty | `WEBUI_DRYRUN_MATCHES` |
| 2 | `git diff --numstat` | only `.ftask/ci.yml` (+ lock rewrite by sync) | `6 4 .ftask/ci.yml` (cache block → comment) |
| 3 | rendered gate diff vs gates main | only the 7-line global `cache:` block removed | `0 7 gates/web-ui.yml`, `grep -c '^cache:'` = 0 |
| 4 | evidence the zip/unzip is pure overhead | .npm already survives on the slot | GIT_CLEAN_FLAGS `-e .npm` (landed in !94) + NPM_CONFIG_CACHE=$CI_PROJECT_DIR/.npm unchanged; first new-gate pipeline 552058: test-client restore_cache 110s + archive_cache 225s, test-quick 70s + 146s |

Post-ship: any web-ui MR test-* trace → no restore_cache/archive_cache sections; cold slot shows `npm ci (...)` then `Test Files N passed`.
