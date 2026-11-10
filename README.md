# Pawl

On-demand AI completion for VS Code with a 0–5 help dial. Pawl writes only when you press the go key (`Alt+Enter`). Models come from OpenRouter, with your own key.

| Level | Name | What it writes |
| --- | --- | --- |
| 0 | Off | Nothing |
| 1 | Syntax | Finishes the line |
| 2 | Sentence | Finishes the statement |
| 3 | Block | Writes the block you're in |
| 4 | Skeleton | Fills the empty function or `TODO:` you're in |
| 5 | Plan step | Writes the next unchecked step of a plan comment |

## Development

```sh
npm ci
npm run typecheck
npm test              # the session core, with a fake model and clock
npm run test:smoke    # the VS Code adapter, in the extension test host
```

## Real-model eval

`npm run eval` runs v1's model-quality check against real OpenRouter models. It isn't part of CI, and each run costs a little OpenRouter credit.

The script presses each level 20 times through the real session core and OpenRouter client, with that level's model. The presses at each level alternate between a Python and a Go fixture in [`eval/fixtures`](eval/fixtures). The `<|>` in each fixture marks the cursor. The script reads the key from `OPENROUTER_API_KEY` and never prints or writes it.

```sh
export OPENROUTER_API_KEY=sk-or-...
npm run eval                                        # levels 1–5, Pawl's default models
npm run eval -- --levels 5 --model 5=z-ai/glm-5.3   # level 5 on GLM 5.3
npm run eval -- --presses 4 --out results.json      # a quick run; every press saved as JSON
```

| Option | Default | |
| --- | --- | --- |
| `--presses N` | `20` | Presses per level, shared between its fixtures |
| `--levels 1,2,…` | `1,2,3,4,5` | Levels to run |
| `--model L=ID` | Pawl's defaults | The OpenRouter model for level `L`. You can give this option more than once. |
| `--timeout 4s\|8s` | `8s` | The deadline for each press, as the `pawl.timeout` setting |
| `--out FILE` | | Writes every press as JSON, with each suggestion and the model's raw reply |

For each level, the report gives:

- **Overruns past the stop point.** A suggestion overruns if, inserted at the cursor, it goes past the level's stop point (at level 5: more than 40 lines, or a file that parses worse). Expected: zero. If there is an overrun, the script exits with code 1.
- **Latency.** The p50 and p90 time from go-press to suggestion, `Q:` or `nothing to add`. Failed requests are left out.
- **Providers.** The serving provider of each press, as reported by OpenRouter.
- **Outcomes.** How many presses showed a suggestion, ended `empty` (nothing to add) or `question` (`Q:`), failed with `step_too_big`, or failed with another error.
- **Cut and fallback counts.** How often the model wrote past the stop point and Pawl cut it there, and how often a press fell back to a lower level.

### Models

The defaults are DeepSeek V4.1 Flash for levels 1–2, GLM 5.3 for levels 3–4 and Kimi K3.1 Pro for level 5.

GLM 5.3 (`z-ai/glm-5.3`) is a cheaper alternative for level 5. To compare it with Kimi on plan steps, run `npm run eval -- --levels 5 --model 5=z-ai/glm-5.3`. To use it in the editor, set `pawl.models.level5` to `z-ai/glm-5.3`.
