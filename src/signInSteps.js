/**
 * SIGNING IN, AND SWITCHING WORKSPACE — ONE statement of the steps, rendered
 * word for word wherever a session is told how to sign in or move: the opening
 * of ateam_bootstrap and of the MCP server instructions, ateam_auth's
 * description, the auth gate's refusal, every refusal for a solution or skill
 * this workspace does not have, the 401/403 hints, and the consent page's key
 * hint. test/sign-in-and-switch.test.mjs fails if another src/ file restates
 * them.
 *
 * A leaf module (no imports): api.js renders these in formatError, and
 * tools.js and oauth.js render them too.
 *
 * WHY. A session on the hosted connector was signed in to one workspace while
 * the user needed another; the user pasted a key into the chat, and neither the
 * agent nor the user knew which workspace the session was on or how to change
 * it. 0f5f4d3 (MGAP-A1) had already said "an agent does not ask for a key";
 * nothing said where the session was or how to move.
 *
 * WHAT EACH STEP RESTS ON (checked 2026-10-01; the PR body quotes the sources):
 *   - The A-Team sign-in page (oauth.js generateAuthPage, served by /authorize)
 *     asks for an API key and nothing else: no account, no workspace picker.
 *     The key decides the workspace and the API it reaches (http.js
 *     seedCredentials). The OAuth access token IS that key, and the refresh
 *     token hands the same key back, so only a NEW /authorize changes the
 *     workspace.
 *   - claude.ai: Customize > Connectors at https://claude.ai/customize/connectors;
 *     "Add custom connector"; on a Team or Enterprise plan an Owner adds it in
 *     Organization settings > Connectors. Claude Desktop: "select Customize in
 *     the sidebar, then Connectors". Disconnect signs Claude out and leaves the
 *     connector listed with Connect; Connect opens the service's sign-in page
 *     (in the browser, from the desktop app). Anthropic's docs:
 *     claude.com/docs/connectors/getting-started and
 *     claude.com/docs/connectors/custom/remote-mcp.
 *   - Tokens & Keys: the Core app's Tenant administration drawer, opened by the
 *     "A-Team" logo at the top left (Core apps/frontend TopBar.jsx), panel
 *     "Tokens & Keys" > "Agent API Key" with Copy and Rotate
 *     (TenantAdminDrawer.jsx). The app reads no URL that opens that panel, so
 *     the steps give the app and the clicks, not a deep link.
 *   - Other MCP clients were not checked one by one; the text says so.
 *
 * PUBLIC TEXT NAMES PRODUCTION ONLY (Arie, 2026-10-01). ateam-mcp is a public
 * package: no text here names another environment's host, link or key prefix.
 * A session on another environment is told "that workspace's own A-Team app".
 */

/** The hosted connector: the one URL a user adds to their client. */
export const HOSTED_CONNECTOR_URL = "https://mcp.ateam-ai.com";

/** claude.ai's connector settings (Anthropic's docs, "Customize > Connectors"). */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

/** Where a Team or Enterprise Owner adds a custom connector (same docs). */
export const CLAUDE_ORG_CONNECTORS_URL = "https://claude.ai/admin-settings/connectors";

/**
 * The production A-Team app, where Tokens & Keys lives. Equal to
 * apiToAppUrl(KEY_ENVIRONMENTS.prod) in api.js — the test pins it, since a leaf
 * module cannot import that map.
 */
export const PROD_APP_URL = "https://app.ateam-ai.com";

export const WHERE_A_KEY_IS =
  `A workspace's key is in that workspace's own A-Team app, under Tokens & Keys: at ${PROD_APP_URL}, ` +
  "click the A-Team logo at the top left (Tenant administration), then Tokens & Keys > Agent API Key (Copy). " +
  "That panel has no direct link of its own.";

/** Said in step 2, and on the sign-in page itself (oauth.js). */
export const KEY_IS_THE_WORKSPACE = "The key decides the workspace; there is no workspace picker.";

export const NO_KEY_IN_CHAT =
  "NO KEY IN THE CHAT: the agent never asks for an A-Team key and never accepts one in the chat. " +
  "If the user pastes a key anyway, do not use it (not in ateam_auth, not anywhere): tell them it is now exposed, " +
  "to Rotate it under Tokens & Keys, and to sign in on the A-Team sign-in page with the new key.";

export const CONNECT_STEPS = [
  "HOW TO SIGN IN — the user does this, and no key passes through the chat:",
  `1. Add ${HOSTED_CONNECTOR_URL} as a custom connector. claude.ai: open ${CLAUDE_CONNECTORS_URL} (Customize > Connectors) ` +
    `and click Add custom connector (on a Team or Enterprise plan an Owner adds it at ${CLAUDE_ORG_CONNECTORS_URL}, ` +
    "and each member then clicks Connect). Claude Desktop: Customize in the sidebar, then Connectors. " +
    "Another client: its own remote MCP server settings (not checked client by client).",
  "2. Click Connect. The A-Team sign-in page opens in the browser and asks for an API key: the user pastes it on THAT page. " +
    KEY_IS_THE_WORKSPACE,
  `3. ${WHERE_A_KEY_IS}`,
  "A client that cannot open the sign-in page takes the key in its own MCP server config instead, as the header " +
    `"Authorization: Bearer <key>" for ${HOSTED_CONNECTOR_URL}/mcp — in the config file, never in the chat.`,
].join("\n");

export const SWITCH_STEPS = [
  "HOW TO SWITCH WORKSPACE — the key given on the A-Team sign-in page IS the workspace, so switching means signing in " +
    "again with the other workspace's key (the same steps sign in again after a key is rotated):",
  `1. Open ${CLAUDE_CONNECTORS_URL} (Claude Desktop: Customize in the sidebar, then Connectors), select the A-Team ` +
    "connector and click Disconnect.",
  "2. Click Connect on it. The A-Team sign-in page opens in the browser: paste the key of the workspace you want on THAT page. " +
    WHERE_A_KEY_IS,
  "3. Call ateam_bootstrap: its first line names the workspace this session is on now. If it still names the old one, start a new chat.",
  "Another client: sign the connector out and connect it again (not checked client by client).",
].join("\n");

export const NOT_IN_THIS_WORKSPACE =
  "IT MAY BE IN ANOTHER WORKSPACE: a session sees only the workspace it is signed in to, and ateam_bootstrap's first " +
  "line names it. If ateam_list_solutions does not show what the user means, do not create it again or pick a " +
  "look-alike: ask the user whether it lives in another workspace. If it does:\n" + SWITCH_STEPS;

/**
 * What a session is told first: where it is, and how to move — or, signed
 * out, how to sign in. Facts only: the workspace (tenant) and the environment
 * the session's sign-in resolved. No person: ateam-mcp is not told whose key it
 * is (whoami answers tenant and env; the Builder learns the person from Core
 * and reports it per test as ran_as).
 *
 * @param {{ signedIn: boolean, tenant?: string|null, environment?: string|null }} facts
 */
export function sessionOpening({ signedIn, tenant = null, environment = null }) {
  if (!signedIn) {
    return [
      "You are NOT signed in to any A-Team workspace. The docs work without it (ateam_get_spec, ateam_get_examples, " +
        "ateam_get_workflows, ateam_spec_search); every tool that reads or changes a workspace is refused until the user signs in.",
      CONNECT_STEPS,
      NO_KEY_IN_CHAT,
    ].join("\n\n");
  }
  const where = tenant ? `workspace "${tenant}"` : "a workspace whose name could not be read yet";
  return [
    `You are signed in to ${where} (${environment || "environment unstated"}). Every tool that reads, changes or ` +
      "deploys acts on this workspace only (the API calls a workspace a tenant). ateam-mcp is not told which person " +
      "the key belongs to, so no person is named here; a test's ran_as names who it ran as.",
    `Tell the user which workspace this is before changing anything. If they mean another one:\n${SWITCH_STEPS}`,
    NO_KEY_IN_CHAT,
  ].join("\n\n");
}
