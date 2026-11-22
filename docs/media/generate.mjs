// Generates the README diagram (light and dark) and the animated terminal demo.
// No dependencies: node docs/media/generate.mjs
// session.gif is separate: a real Claude Code session recorded with asciinema
// (session.cast) and rendered with agg 1.9.0 at --speed 3.
// Demo text is adapted from earlier setup and policy hook output. The hook
// scenes show the decision the hook returns.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- diagram ----------
const THEMES = {
  light: { bg: "#FFFFFF", ink: "#111111", muted: "#5B6270", line: "#C9CED6", accent: "#1E3A5F", tint: "#EEF2F7", warn: "#9A3412", warnTint: "#FFF4EC" },
  dark: { bg: "#0D1117", ink: "#F0F3F6", muted: "#9AA4B2", line: "#3A4250", accent: "#8FB3E0", tint: "#16202D", warn: "#F4A26B", warnTint: "#2A1D14" },
};

function diagram(t) {
  const W = 880, H = 520;
  const box = (x, y, w, h, fill, stroke, r = 10) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  const txt = (x, y, s, { size = 15, weight = 400, fill = t.ink, anchor = "middle", font = SANS } = {}) =>
    `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
  const arrow = (x1, y1, x2, y2, color = t.muted, both = false) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" marker-end="url(#a)"${both ? ' marker-start="url(#a)"' : ""}/>`;

  const workers = [
    { x: 40, label: "L1 · Haiku", sub: "starts here" },
    { x: 250, label: "L2 · Sonnet", sub: "if the task needs it" },
    { x: 460, label: "L3 · Opus", sub: "after you approve", warn: true },
  ];
  const wy = 300, ww = 190, wh = 70;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How Agent Workbench works: you talk to a Manager session, which sends work to Haiku, Sonnet or Opus Workers and verifies the results, while a policy hook checks every step.">
<title>How Agent Workbench works</title>
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${t.muted}"/></marker></defs>
<rect width="${W}" height="${H}" fill="${t.bg}"/>
${box(215, 24, 180, 48, t.bg, t.line, 24)}
${txt(305, 54, "You", { size: 17, weight: 600 })}
${arrow(305, 74, 305, 126)}
${txt(318, 104, "ask · approve · answer", { size: 13, fill: t.muted, anchor: "start" })}
${box(155, 130, 300, 92, t.tint, t.accent)}
<rect x="173" y="148" width="22" height="22" fill="${t.accent}"/>
${txt(208, 165, "Manager session", { size: 17, weight: 600, anchor: "start" })}
${txt(173, 193, "your model · plans · writes briefs", { size: 13, fill: t.muted, anchor: "start" })}
${txt(173, 211, "checks branch, commit and CI", { size: 13, fill: t.muted, anchor: "start" })}
${workers.map((w) => `${arrow(305, 224, w.x + ww / 2, wy - 4)}`).join("\n")}
${txt(470, 262, "brief ↓  report + evidence ↑", { size: 13, fill: t.muted, anchor: "start" })}
${workers.map((w) => `${box(w.x, wy, ww, wh, w.warn ? t.warnTint : t.bg, w.warn ? t.warn : t.line)}
<rect x="${w.x + 16}" y="${wy + 18}" width="10" height="10" fill="${w.warn ? t.warn : t.ink}"/>
${txt(w.x + 34, wy + 28, w.label, { size: 15, weight: 600, anchor: "start" })}
${txt(w.x + 16, wy + 52, w.sub, { size: 13, fill: w.warn ? t.warn : t.muted, anchor: "start" })}`).join("\n")}
${txt(305, wy + wh + 26, "Workers are your harness's own subagents", { size: 13, fill: t.muted })}
${box(640, 130, 210, 92, t.bg, t.line)}
${txt(745, 162, "Other Managers", { size: 15, weight: 600 })}
${txt(745, 186, "later session, other", { size: 13, fill: t.muted })}
${txt(745, 204, "harness or machine", { size: 13, fill: t.muted })}
${arrow(460, 176, 634, 176, t.muted, true)}
${txt(547, 166, "handover", { size: 13, fill: t.muted })}
${box(40, 420, 810, 84, t.bg, t.accent, 8)}
${txt(60, 448, "Policy hook checks every dispatch, shell command and turn end", { size: 15, weight: 600, anchor: "start" })}
${txt(60, 472, "protects main · blocks CI polling · asks before Opus", { size: 13, fill: t.muted, anchor: "start" })}
${txt(60, 492, "sends questions written as prose back to the question tool", { size: 13, fill: t.muted, anchor: "start" })}
</svg>
`;
}

// ---------- animated terminal ----------
// Each scene: lines appear one by one; cmd lines are typed.
const SCENES = [
  {
    title: "Install",
    lines: [
      { cmd: "npx @onsager/awb setup" },
      { out: "◇  Installed 5 skills", dim: false },
      { out: "   host-ops · orchestrate-harnesses · prompt-for-decisions …", dim: true },
      { out: "claude agents: haiku, opus, sonnet" },
      { out: "ok  Claude hook Agent|Task: applied", ok: true },
      { out: "ok  Claude hook Bash: applied", ok: true },
      { out: "ok  Claude hook Stop: applied", ok: true },
      { out: "ok  instruction template: applied", ok: true },
      { out: "ok  Claude agent haiku: applied", ok: true },
      { out: "ok  Claude agent sonnet: applied", ok: true },
      { out: "ok  Claude agent opus: applied", ok: true },
    ],
  },
  {
    title: "Inside an agent session, the policy hook steps in",
    lines: [
      { note: "# agent runs a command on local main" },
      { cmd: 'git commit -am "fix typo"' },
      { out: "✗ denied  The local main branch is protected. Use a task branch,", bad: true },
      { out: "          origin/main, or git switch -c <task> origin/main.", bad: true },
      { note: "# agent waits on CI by polling" },
      { cmd: "gh pr checks 12 --watch" },
      { out: "✗ denied  GitHub polling is disabled. Use watch_pull_request …", bad: true },
      { note: "# agent tries to start an Opus Worker" },
      { cmd: "Agent(subagent_type: opus)", tool: true },
      { out: "? asks you  Worker opus at level L3 needs the user's approval for this task.", ask: true },
      { note: '# agent ends its turn with "Should I also update the docs?"' },
      { out: "↩ sent back  Re-ask it with AskUserQuestion, recommended option first.", ask: true },
    ],
  },
];

function demo() {
  const W = 880, LH = 22, PAD = 22, TOP = 72, CW = 8.4;
  const rows = Math.max(...SCENES.map((s) => s.lines.length));
  const H = TOP + rows * LH + PAD + 8;
  const C = { bg: "#0D1117", bar: "#161B22", ink: "#E6EDF3", dim: "#7D8590", ok: "#56D364", bad: "#FF7B72", ask: "#E3B341", prompt: "#79C0FF", note: "#7D8590" };
  // timeline in seconds
  const TYPE = 0.045, LINE = 0.28, AFTER_CMD = 0.5, HOLD = 3.2, GAP = 0.4;
  let t = 0.6;
  const items = [];
  const sceneSpans = [];
  for (const scene of SCENES) {
    const start = t;
    scene.lines.forEach((l, i) => {
      const y = TOP + (i + 1) * LH;
      if (l.cmd) {
        const text = l.cmd;
        const dur = text.length * TYPE;
        items.push({ kind: "cmd", y, text, tool: l.tool, at: t, dur });
        t += dur + AFTER_CMD;
      } else {
        items.push({ kind: "out", y, l, at: t });
        t += l.note ? LINE + 0.25 : LINE;
      }
    });
    t += HOLD;
    sceneSpans.push({ start, end: t, title: scene.title });
    t += GAP;
  }
  const TOTAL = t;
  const pct = (s) => ((s / TOTAL) * 100).toFixed(3);
  let css = "";
  let body = "";
  let k = 0;
  const show = (from, to) => {
    const name = `k${k++}`;
    const a = Math.max(0, pct(from) - 0.01).toFixed(3), b = Math.min(100, +pct(to) + 0.01).toFixed(3);
    css += `@keyframes ${name}{0%,${a}%{opacity:0}${pct(from)}%,${pct(to)}%{opacity:1}${b}%,100%{opacity:0}}\n`;
    return `style="animation:${name} ${TOTAL.toFixed(2)}s linear infinite;opacity:0"`;
  };
  sceneSpans.forEach((s, si) => {
    const sceneItems = items.filter((it) => it.at >= s.start && it.at < s.end);
    let g = `<text x="${PAD}" y="${TOP - 8}" font-family="${SANS}" font-size="13" fill="${C.dim}">${esc(`${si + 1}/${SCENES.length}  ${s.title}`)}</text>`;
    for (const it of sceneItems) {
      if (it.kind === "cmd") {
        const prompt = it.tool ? "⏺" : "$";
        const w = it.text.length * CW + 4;
        const x0 = PAD + 2 * CW;
        const name = `k${k++}`;
        // A background-coloured cover slides right one character per step to "type" the command.
        let kf = `@keyframes ${name}{0%{transform:translateX(0)}`;
        for (let c = 0; c <= it.text.length; c++) kf += `${pct(it.at + c * TYPE)}%{transform:translateX(${(c * CW).toFixed(1)}px)${c === it.text.length ? ";opacity:0" : ""}}`;
        css += kf + `100%{transform:translateX(${w.toFixed(1)}px);opacity:0}}\n`;
        g += `<text x="${PAD}" y="${it.y}" fill="${it.tool ? C.ask : C.prompt}">${prompt}</text>`;
        g += `<text x="${x0}" y="${it.y}" fill="${C.ink}">${esc(it.text)}</text>`;
        g += `<rect x="${x0 - 1}" y="${it.y - 16}" width="${w + 2}" height="${LH}" fill="${C.bg}" style="animation:${name} ${TOTAL.toFixed(2)}s steps(1,end) infinite"/>`;
      } else {
        const l = it.l;
        const fill = l.note ? C.note : l.ok ? C.ok : l.bad ? C.bad : l.ask ? C.ask : l.dim ? C.dim : C.ink;
        const text = l.note ?? l.out;
        const lead = l.ok ? `<tspan fill="${C.ok}">ok</tspan><tspan fill="${C.ink}">${esc(text.slice(2))}</tspan>` : esc(text);
        g += `<text x="${PAD}" y="${it.y}" fill="${fill}"${l.note ? ' font-style="italic"' : ""} ${show(it.at, s.end)}>${lead}</text>`;
      }
    }
    body += `<g ${show(Math.max(0, s.start - 0.3), s.end)}>${g}</g>\n`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Terminal demo: npx @onsager/awb setup installs five skills, three Worker subagents and the policy hook. Then the hook denies a commit on main and CI polling, asks before an Opus Worker, and sends a prose question back.">
<title>Agent Workbench setup and policy hook demo</title>
<style>
text{font-family:${MONO};font-size:14px;white-space:pre}
${css}</style>
<rect width="${W}" height="${H}" rx="10" fill="${C.bg}"/>
<path d="M0 10a10 10 0 0 1 10-10h${W - 20}a10 10 0 0 1 10 10v26H0z" fill="${C.bar}"/>
<circle cx="20" cy="18" r="6" fill="#FF5F57"/><circle cx="40" cy="18" r="6" fill="#FEBC2E"/><circle cx="60" cy="18" r="6" fill="#28C840"/>
<text x="${W / 2}" y="23" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${C.dim}">awb</text>
${body}</svg>
`;
}

writeFileSync(join(OUT, "how-it-works-light.svg"), diagram(THEMES.light));
writeFileSync(join(OUT, "how-it-works-dark.svg"), diagram(THEMES.dark));
writeFileSync(join(OUT, "demo.svg"), demo());
console.log("wrote how-it-works-{light,dark}.svg and demo.svg");
