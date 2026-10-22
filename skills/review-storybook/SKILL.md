---
name: review-storybook
description: Review interactive Storybook previews from product repositories on mobile.
---

# Review a Storybook preview

Use this skill to inspect a product repository's own interactive Storybook preview on a phone and report findings tied to the reviewed revision.

## Find and identify the preview

In the owning product repository, inspect the Storybook configuration, package scripts, existing CI and preview deployment workflow, and any published URL. Reuse an existing preview or CI artifact before building one. Follow the repository's actual build steps and applicable repository and host instructions for verification, using CI where they require it. Choose a publishing destination below only when publication is part of the authorized task.

Record the repository and exact commit SHA used to build the preview, plus its CI run or deployment ID when available. A pull request merge ref may differ from the pull request head: verify the relationship or state that the preview revision is unverified.

## Choose the publishing destination

For an authorized publication without an explicit destination, choose by the user-facing harness, not a delegated implementer's or reviewer's model. Reuse a suitable existing preview rather than migrating it just to apply a default.

- **Codex:** default to Sites for the complete static Storybook build. Use the available Sites skill and native tools, retain the build's entry points and assets, reuse the selected Site's identity for updates, and start new Sites private. Preserve an existing audience.
- **Claude:** default to the session's native Artifact tool for a concise review summary with revision provenance and links to the real Storybook manager and relevant story canvases. Keep the artifact private or preserve its existing audience. An Artifact is one self-contained page; relative files are not deployed alongside it, so it cannot directly host an ordinary multi-file Storybook build. Keep that build on existing authorized hosting. If a complete preview is missing, report the hosting gap rather than replacing Storybook with a recreated UI or screenshot gallery.

Preserve explicit user choices and applicable repository instructions. These defaults choose a destination; they do not grant additional publication, public sharing, account, spending, authentication, permission or baseline-promotion authority. Use supported tools and return their actual published URLs. If a provider is unavailable in the current session, use an existing verified preview when possible and state the limitation; do not launch another harness merely to publish or present a local file as a published preview.

## Review on mobile

Use the full Storybook manager when you need its sidebar, Controls panel, or addons. For one interactive story on a phone, use the published UI's **Open canvas in new tab** action. The canvas remains interactive but does not include the Controls panel. Do not guess story IDs or hand-build iframe URLs with encoded args or globals; those details vary between Storybook versions.

Keep the preview's deployment subpath, configured state, and private access intact. Exercise relevant story interactions and the args, controls, themes, globals, and viewports that the repository actually configures. State whether you used a simulated viewport or a physical phone; a simulated viewport does not qualify physical-phone behavior.

Tie each feedback item to the story link or ID and exact revision. Include the args, globals, and viewport tested, what you observed versus what you expected, and any untested scope. Report only the stories actually reviewed; do not imply blanket approval.

## Build, publish, and approval boundaries

Build with the owning repository's scripts and CI, and publish through the selected provider's supported workflow within existing authorization. A static Storybook build can retain live components and interaction. Publishing a preview does not activate visual baselines.

Storybook core does not provide bespoke approval records or local review persistence. Services such as Chromatic can add visual comparison and approval workflows, but they are optional and separate; do not enable or sign up for them without authorization.

References: [Publish Storybook](https://storybook.js.org/docs/sharing/publish-storybook), [Controls](https://storybook.js.org/docs/essentials/controls), [Embed Storybook](https://storybook.js.org/docs/sharing/embed), [Claude Code Artifacts and page constraints](https://code.claude.com/docs/en/artifacts#page-constraints).
