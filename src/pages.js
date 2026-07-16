/**
 * Static help pages served by the ateam-mcp HTTP server.
 *
 * These are user-facing landing pages an agent can link to from a tool result
 * (e.g. the github_not_connected guide). Self-contained HTML, no external
 * assets — matches the dark card style of the OAuth authorize page.
 */

const APP_URL = process.env.ATEAM_APP_URL || "https://app.ateam-ai.com";

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — A-Team</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px; line-height: 1.55;
    }
    .card {
      background: #171717; border: 1px solid #262626;
      border-radius: 14px; padding: 34px; max-width: 560px; width: 100%;
    }
    .logo { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    h1 { font-size: 21px; font-weight: 650; margin: 14px 0 6px; }
    .lead { color: #a3a3a3; font-size: 15px; margin-bottom: 22px; }
    ol { margin: 0 0 22px; padding-left: 0; list-style: none; counter-reset: step; }
    li { position: relative; padding: 12px 0 12px 44px; border-top: 1px solid #222; counter-increment: step; }
    li:first-child { border-top: none; }
    li::before {
      content: counter(step); position: absolute; left: 0; top: 12px;
      width: 28px; height: 28px; border-radius: 50%;
      background: #1e3a5f; color: #93c5fd; font-weight: 700; font-size: 14px;
      display: flex; align-items: center; justify-content: center;
    }
    li b { color: #fff; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #0a0a0a; border: 1px solid #333; border-radius: 5px;
      padding: 1px 6px; font-size: 13px; color: #c4b5fd; }
    .btn {
      display: inline-block; background: #2563eb; color: #fff;
      padding: 11px 20px; border-radius: 9px; font-size: 15px; font-weight: 600;
      text-decoration: none;
    }
    .btn:hover { background: #1d4ed8; }
    .note { margin-top: 20px; font-size: 13px; color: #737373; }
    .note code { color: #9ca3af; }
    a { color: #60a5fa; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

export function connectGithubPage() {
  return shell("Connect GitHub", `
    <div class="logo">A-Team</div>
    <h1>Connect GitHub to keep iterating</h1>
    <div class="lead">
      Editing, versioning, or promoting <b>connector code</b> needs a Git repo.
      Connect your GitHub once — A-Team creates and manages the repo for you, and
      every deploy is versioned from then on.
    </div>
    <ol>
      <li>Open <b>Tenant Admin → GitHub</b> in the A-Team app (pick your tenant, then the GitHub tab).</li>
      <li>Click <b>Connect GitHub</b> and approve the A-Team GitHub App for your account.</li>
      <li>Go back to your agent and <b>retry</b> — the repo is auto-created on the next deploy.</li>
    </ol>
    <a class="btn" href="${APP_URL}" target="_blank" rel="noopener">Open the A-Team app →</a>
    <div class="note">
      Not ready for GitHub? Skill and solution <b>definition</b> edits still work
      without a repo via <code>ateam_patch(..., source:"local")</code>. Only
      connector <b>code</b> iteration needs GitHub.
    </div>
  `);
}
