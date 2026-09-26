# Five-stall harbor verification

Latest results, changed files, limitations and demonstration steps: [Final frontend polish](FINAL-POLISH.md). All four scenarios passed at both desktop sizes, with 53 frontend and 204 backend tests passing. The notes below describe the earlier artwork verification.

Verified in headless Microsoft Edge at 1440x900 and 1920x1080 using the existing Payments recording, without synthesizing incident events.

At each size: standby, active remediation, first sandbox rejection, successful retry, awaiting approval, restored; Inbox, Crew, Evidence and Ledger; all five specialty dialogs; no horizontal page overflow, overlapping harbor label bounds or runtime exceptions. Screenshots were inspected for physical buildings, sign placement, the worker, Captain and route.

The full gated replay also passed at both sizes: Trigger -> Approve repair -> automatic Evidence focus -> View details -> retained incident history. Restored Crew contains the completed approval receipt and final crew states, without approval buttons.

Frontend: 37 tests passed. TypeScript and production build passed (existing bundle-size advisory). Protected backend Python files, reducer and contract hashes match the baseline taken before this visual work. A pre-existing backend copy edit was left outside this frontend commit.

Screenshots: [Approval at 1440x900](approval-1440.png), [Outcome at 1920x1080](outcome-1920.png).

## Artwork provenance

Generated with the built-in image generation tool, editing `web/public/art/seaside-market.jpg`. Saved asset: `web/public/art/seaside-five-stalls.png` (1672x941). The scene contains the entire asset at its native aspect ratio.

Exact prompt:

> Use case: precise-object-edit. Edit target: provided pixel-art harbor background for an interactive game UI. Preserve the 16:9 composition, pixel-art painting style, turquoise water, tropical shore, wooden horizontal promenade, lower-left sailboat and pier. Replace ONLY the row of three stalls with a row of EXACTLY FIVE evenly spaced real wooden market stall structures, each with its own wooden floor/platform, posts, counter, striped awning and SMALL BLANK wooden sign. Awning colors left to right blue, amber, red, teal, purple. All five stalls same scale, no overlap, centers at approximately 14%, 32%, 50%, 68%, 86% of image width. Each occupies about 14% image width. Awning tops at 28% of image height; feet at 46% of image height. Keep central dock walkway below stalls clear. Each stall interior empty for a separately rendered worker. Keep original boat in lower left around 36% width 76% height. No characters, no text, no UI, no labels, no black bars. Match original rich pixel shading and warm wood. Do not stretch or distort the original landscape. Output a 16:9 landscape image.
