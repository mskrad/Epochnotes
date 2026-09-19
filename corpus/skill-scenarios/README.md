# Skill scenarios

Questions used to evaluate `skills/epochnotes`. They live outside the skill directory on purpose: a scenario
names changes, error codes and versions, and the skill must carry none of those.

## How to run one

1. Publish the registry entries to a scratch log and write a publishers file naming the scratch key:

   ```bash
   epochnotes registry publish --key <scratch-key.json> --entries registry/entries \
     --versions <scratch>/versions --uri '<scratch>/versions/{root}.jsonl' --json
   ```

2. Give an assistant with a clean context only: the path to `skills/epochnotes/SKILL.md`, the question from
   the scenario file verbatim, and `EPOCHNOTES_VERSIONS` / `EPOCHNOTES_PUBLISHERS` pointing at the scratch log.
   It must not read `registry/`, the sources or any other file of this repository.
3. Compare the answer with the "The answer must" list of the scenario.

For the negative scenario, change any byte of the `.jsonl` content file after publishing.
