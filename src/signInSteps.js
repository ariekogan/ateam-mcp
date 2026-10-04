/**
 * SIGNING IN, AND SWITCHING WORKSPACE — ONE statement of the steps, rendered
 * word for word wherever a session is told how to sign in or move: the opening
 * of ateam_bootstrap and of the MCP server instructions, the auth gate's
 * refusal, every refusal for a solution or skill this workspace does not have,
 * the 401/403 hints, and the sign-in page's key hint.
 * test/sign-in-and-switch.test.mjs fails if another src/ file restates them.
 *
 * ONE TEXT PER WAY OF BEING CONNECTED, because the steps differ and a step for
 * the wrong one does not work (api.js signInContext decides which applies):
 *   - hosted:   the hosted connector, signed in by the key typed on the A-Team
 *               sign-in page (OAuth) or sent as a bearer by the client config;
 *   - stdio:    a local ateam-mcp process. No browser sign-in reaches it, and
 *               an ADAS_API_KEY in its environment does not sign it in; only
 *               ateam_auth does;
 *   - platform: the A-Team app's own builder (ateam-proxy-mcp). The platform
 *               signs each workspace in itself; its sessions get no steps.
 *
 * A leaf module apart from publicTools.js and testRunsAs.js: api.js renders these in formatError,
 * and tools.js and oauth.js render them too.
 *
 * WHAT EACH STEP RESTS ON (checked 2026-10-01; the PR body quotes the sources):
 *   - The A-Team sign-in page (oauth.js generateAuthPage, served by /authorize)
 *     asks for an API key and nothing else: no account, no workspace picker.
 *     The key decides the workspace and the API it reaches (http.js
 *     seedCredentials). A new /authorize clears an ateam_auth override kept for
 *     that key (oauth.js exchangeAuthorizationCode).
 *   - claude.ai: Customize > Connectors at https://claude.ai/customize/connectors;
 *     "Add custom connector"; on a Team or Enterprise plan an Owner adds it in
 *     Organization settings > Connectors. Claude Desktop: "select Customize in
 *     the sidebar, then Connectors". Disconnect signs Claude out and leaves the
 *     connector listed with Connect. Anthropic's docs:
 *     claude.com/docs/connectors/getting-started, .../custom/remote-mcp.
 *   - Claude Code: `claude mcp add --transport http <name> <url>`, then `/mcp`
 *     and the browser; "Clear authentication" in the /mcp menu revokes it
 *     (code.claude.com/docs/en/mcp).
 *   - The key: Core's /connect page (ai-dev-assistant fce6bbfa6, 46d01b1a1),
 *     behind the app's sign-in, one action (Copy key, owner or admin only),
 *     showing the workspace, solution and environment.
 *   - Other MCP clients were not checked one by one; the text says so.
 *
 * PUBLIC TEXT LINKS PRODUCTION ONLY (Arie, 2026-10-01). No text here holds
 * another environment's host or link; a session on another environment is
 * pointed at "your environment's own A-Team app", with no URL.
 */
import { NO_SIGN_IN_NEEDED } from "./publicTools.js";
import { TEST_RUNS_AS_AT } from "./testRunsAs.js";

const HOSTED_CONNECTOR_URL = "https://mcp.ateam-ai.com";
const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
const CLAUDE_ORG_CONNECTORS_URL = "https://claude.ai/admin-settings/connectors";

/** Core's page that copies a workspace's key: its path on any A-Team app, and on the production app. */
export const KEY_PAGE_PATH = "/connect";
export const KEY_PAGE_URL = `https://app.ateam-ai.com${KEY_PAGE_PATH}`;

/**
 * Where the key is, given the key page this text may link: that page, or —
 * when none may be named (null) — the environment's own app, with no URL.
 * The HTTP transport passes the page of the host a request addressed
 * (api.js keyPageForEnv); a session's texts go through whereTheKeyIs.
 */
export function whereTheKeyIsAt(keyPage) {
  const page = keyPage || `the ${KEY_PAGE_PATH} page of your environment's own A-Team app`;
  return `The key: ${page}. It asks you to sign in to the A-Team app, shows the workspace, solution and environment the ` +
    "key belongs to, and has one action, Copy key — for a workspace owner or admin only; anyone else asks one of them.";
}

/**
 * Where the key is, for a session on `environment`: the production page, or —
 * for any other environment — that environment's own app, with no URL.
 * Unknown (not signed in) and "unstated" (a key that names none, which lands
 * on production) get the production page.
 */
export function whereTheKeyIs(environment = null) {
  return whereTheKeyIsAt(!environment || environment === "prod" || environment === "unstated" ? KEY_PAGE_URL : null);
}

/** Step 2, and the sign-in page itself (oauth.js). */
export const KEY_IS_THE_WORKSPACE = "The key decides the workspace; there is no workspace picker.";

export const NO_KEY_IN_CHAT =
  "NO KEY IN THE CHAT: the agent never asks for an A-Team key and never accepts one in the chat. " +
  "If the user pastes a key anyway, do not use it (not in ateam_auth, not anywhere): tell them it is now exposed, " +
  "and that a workspace owner or admin should rotate it (Tokens & Keys, in the A-Team app) before it is used again.";

const PLATFORM_CHOOSES =
  "This session belongs to the A-Team app's own builder: the platform signs a workspace in before that workspace's " +
  "calls, and the workspace is the one the user has open in the app. There are no sign-in steps to give here.";

/** How to sign in, for this way of being connected. */
export function connectSteps({ audience = "hosted", environment = null } = {}) {
  if (audience === "platform") return PLATFORM_CHOOSES;
  if (audience === "stdio") {
    return [
      "HOW TO SIGN IN — this session is a local ateam-mcp process (stdio):",
      "1. Only ateam_auth signs it in. The browser sign-in of the hosted connector signs in that connector's own " +
        "sessions, never this process, and an ADAS_API_KEY in its environment does not sign it in either.",
      "2. The user saves the workspace's key in a local file outside the chat (for example a git-ignored .env) and " +
        "tells you the file's path. Read the key from that file and call ateam_auth(api_key) with it; the key itself " +
        "never appears in the chat.",
      `3. ${whereTheKeyIs(environment)}`,
    ].join("\n");
  }
  return [
    "HOW TO SIGN IN — the user does this, and no key passes through the chat:",
    `1. Add ${HOSTED_CONNECTOR_URL} as a custom connector. claude.ai: open ${CLAUDE_CONNECTORS_URL} (Customize > Connectors) ` +
      `and click Add custom connector (on a Team or Enterprise plan an Owner adds it at ${CLAUDE_ORG_CONNECTORS_URL}, ` +
      "and each member then clicks Connect). Claude Desktop: Customize in the sidebar, then Connectors. " +
      `Claude Code: claude mcp add --transport http ateam ${HOSTED_CONNECTOR_URL}, then /mcp. ` +
      "Another client: its own remote MCP server settings (not checked client by client).",
    "2. Click Connect (Claude Code: /mcp, then authenticate). The A-Team sign-in page opens in the browser and asks " +
      `for an API key: the user pastes it on THAT page. ${KEY_IS_THE_WORKSPACE}`,
    `3. ${whereTheKeyIs(environment)}`,
    "A client that cannot open the sign-in page takes the key in its own MCP server config instead, as the header " +
      `"Authorization: Bearer <key>" for ${HOSTED_CONNECTOR_URL}/mcp — in the config file, never in the chat.`,
  ].join("\n");
}

/** How to move this session to another workspace (or sign in again after a key is rotated). */
export function switchSteps({ audience = "hosted", environment = null, masterMode = false } = {}) {
  if (audience === "platform") return PLATFORM_CHOOSES;
  if (masterMode) {
    return "HOW TO SWITCH WORKSPACE — this session holds a master key: pass `tenant: \"<workspace>\"` on a workspace " +
      "tool, and the session acts on that workspace from then on.";
  }
  if (audience === "stdio") {
    return [
      "HOW TO SWITCH WORKSPACE — this local process (stdio) is on the workspace of the key ateam_auth was given:",
      "1. Call ateam_auth(api_key) with the other workspace's key, read from a local file outside the chat as when " +
        `signing in. ${whereTheKeyIs(environment)}`,
      "2. Call ateam_bootstrap: its `session` field names the workspace this session is on now.",
    ].join("\n");
  }
  return [
    "HOW TO SWITCH WORKSPACE — the key given on the A-Team sign-in page IS the workspace, so switching means signing in " +
      "again with the other workspace's key (the same steps sign in again after a key is rotated):",
    `1. Open ${CLAUDE_CONNECTORS_URL} (Claude Desktop: Customize in the sidebar, then Connectors), select the A-Team ` +
      "connector and click Disconnect. Claude Code: /mcp, select the server, Clear authentication.",
    "2. Click Connect on it (Claude Code: authenticate). The A-Team sign-in page opens in the browser: paste the key of " +
      `the workspace you want on THAT page. ${whereTheKeyIs(environment)}`,
    "3. Call ateam_bootstrap: its `session` field names the workspace this session is on now. If it still names the " +
      "old one, start a new chat.",
    "Another client: sign the connector out and connect it again (not checked client by client).",
  ].join("\n");
}

/** A solution or skill this workspace does not have: the cause no 404 can see, then how to move. */
export function notInThisWorkspace(ctx = {}) {
  return "IT MAY BE IN ANOTHER WORKSPACE: a session sees only the workspace it is signed in to, and ateam_bootstrap's " +
    "`session` field names it. If ateam_list_solutions does not show what the user means, do not create it again or " +
    `pick a look-alike: ask the user whether it lives in another workspace. If it does:\n${switchSteps(ctx)}`;
}

/**
 * What a session is told first: where it is, and how to move — or, signed
 * out, how to sign in. Facts only (api.js signInContext): the workspace, the
 * environment of the sign-in, master mode, and how the session is connected.
 * No person: ateam-mcp is not told whose key it is (whoami answers tenant and
 * env).
 *
 * @param {{ audience?: string, signedIn: boolean, tenant?: string|null, environment?: string|null, masterMode?: boolean }} ctx
 */
export function sessionOpening(ctx) {
  const { signedIn, tenant = null, environment = null, masterMode = false } = ctx;
  if (!signedIn) {
    return [
      `You are NOT signed in to any A-Team workspace. ${NO_SIGN_IN_NEEDED} Every other tool is refused until this ` +
        "session signs in.",
      connectSteps(ctx),
      NO_KEY_IN_CHAT,
    ].join("\n\n");
  }
  const where = tenant ? `workspace "${tenant}"` : "a workspace whose name could not be read yet";
  const env = environment === "unstated"
    ? "environment unstated: the key names none, so its calls go to this server's default API"
    : environment || "environment unstated";
  const scope = masterMode
    ? "This session holds a MASTER key: a workspace tool's `tenant` argument moves it to that workspace, and it " +
      "stays there; without one, tools act on this workspace."
    : "Every tool that reads, changes or deploys acts on this workspace (the API calls a workspace a tenant).";
  return [
    `You are signed in to ${where} (${env}). ${scope} ateam-mcp is not told which person the key belongs to, so no ` +
      "person is named here. " + TEST_RUNS_AS_AT,
    `Tell the user which workspace this is before changing anything. If they mean another one:\n${switchSteps(ctx)}`,
    NO_KEY_IN_CHAT,
  ].join("\n\n");
}
