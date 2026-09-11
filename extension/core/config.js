// SPDX-License-Identifier: GPL-3.0-or-later
// core/config.js - provider-agnostic constants: app identity, system prompt,
// feedback strings, tool categorisation. NOTHING in this file may reference a
// specific AI site (DOM, selectors, site names) - that lives in providers/*.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  "use strict";

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "ZeroReal";
  const SYS_MARKER = "⟦ZR-SYS⟧";
  // A re-statement of the system prompt mid-session (see withSysResend in
  // core/main.js). It carries SYS_MARKER TOO - that is what drives camouflage
  // and session detection, and neither should change - plus this second marker,
  // purely so the chip can say "Reminder" instead of inheriting the bootstrap's
  // "Starting Up". Same content, different label: a re-injection is not a start.
  const RESEND_MARKER = "⟦ZR-RE⟧";

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Real MCP. Returns one of:
  //   read | edit | screen | generate | memory | spy | input | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_commands" || n === "list_tools") return "read";
    if (/^(search-api|search-instances|get-descendants-tree|get-game-info|get-nil-instances|get-instance-properties|get-tagged|get-property|list-players|list-clients|get-console-output|get-data-by-code|eval|get-script-content|script-grep|get-script-strings|find-remote-callers|search-scripts|get-diagnostics|get-app-log|get-env|list-connections|list-special-instances|dump-visible-ui)$/.test(n))
      return "read";
    if (/^(open-script|live-reload|execute|execute-file|fire-remote|set-property|call-method|type-text-box|click-button)$/.test(n))
      return "edit";
    if (/^(screenshot-window|screen_capture)$/.test(n)) return "screen";
    if (/^(gc-scan|remote-spy|inbound-spy|spy-closure|spy-namecall)$/.test(n)) return "spy";
    if (/^(send-input)$/.test(n)) return "input";
    if (/^(remember-game|recall-game-memory|game-feedback|forget-game-memory|build-script-index)$/.test(n)) return "memory";
    if (n.startsWith("real") || /luau|instance|workspace|client/i.test(n)) return "read";
    return "tool";
  }

  // Feedback strings sent back to the model so it can self-correct.
  const FEEDBACK = {
    // A command-shaped reply that could not be turned into a runnable call.
    // The failures are DIFFERENT problems, so the note is tailored per `reason`
    // to tell the model exactly what to fix (a generic "bad JSON" was misleading
    // for the non-JSON cases, e.g. a missing ###LUA### opener). Falls back to the
    // generic "malformed" text for any unrecognised reason.
    parseError: (reason, toolName) => {
      // ###LUA### is get-data-by-code-ONLY (the parser always maps a bare ###LUA###
      // block to get-data-by-code). So only suggest it when the broken command IS
      // get-data-by-code, or when we could not tell which command it was. For a KNOWN
      // other command the ###LUA### hint is wrong and misleading - so drop it and
      // keep the JSON-only guidance.
      const otherCmd = toolName && toolName !== "command" && toolName !== "get-data-by-code" && toolName !== "execute_luau";
      const luaMalformed = otherCmd ? "" : " (or use the ###LUA### / ###END_LUA### block for Luau via get-data-by-code)";
      const luaUnclosed = otherCmd ? "" : " (or a complete ###LUA### ... ###END_LUA### block for Luau via get-data-by-code)";
      const objAlt = otherCmd ? "" : " (or ###...### block)";
      const notes = {
        malformed:
          "ERROR: a ZeroReal command was detected in your reply but its JSON could not be parsed. " +
          'Rewrite it as a single valid JSON object in plain text, exactly like {"command": "name", "params": {...}}' +
          luaMalformed + ". You may add a short note around it. " +
          "Please retry.",
        unclosed:
          "ERROR: your ZeroReal command was cut off before it finished - the JSON object" +
          objAlt + " never closed, so it could not run. Rewrite the WHOLE command in one " +
          'piece as valid JSON, exactly like {"command": "name", "params": {...}}' +
          luaUnclosed + ". Please retry.",
        luaOpener:
          "ERROR: you wrote the closing ###END_LUA### marker but not the opening ###LUA### marker, " +
          "so the Luau block was not detected and did not run. Put ###LUA### immediately BEFORE your " +
          "code and ###END_LUA### after it. Please retry.",
        envelope:
          "ERROR: you wrote a command's parameters as a bare JSON object, but without the required " +
          "envelope, so it was not recognised as a command. Wrap them like " +
          '{"command": "name", "params": { ...your parameters... }} - the parameter keys go INSIDE ' +
          '"params". Please retry.',
        // The model named a REAL tool but under the wrong key - it wrote the call
        // the way a function-calling API would (e.g. {"toolName": "get_studio_state",
        // "studio_id": "..."}) instead of ZeroScript's envelope. Seen live on
        // ChatGPT in a long session. Naming the wrong keys explicitly matters: a
        // generic "bad JSON" note made the model rewrite the SAME shape.
        toolKey:
          "ERROR: you used the wrong key to name the command, so it was not recognised and did not " +
          'run. The key must be exactly "command" - not "toolName", "tool", "name", "function" or ' +
          '"action" - and every argument goes INSIDE "params", like ' +
          '{"command": "name", "params": { ...your parameters... }}. Please retry.',
      };
      return notes[reason] || notes.malformed;
    },
    multiTool: (names) =>
      "ERROR: You wrote multiple commands in one reply. Write ONE command at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and write only the first command you need.",
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". It does not exist. Valid commands are: ` +
      valid.join(", ") +
      ". Use an exact name and parameter keys from the system prompt.",
    studioOffline:
      "ERROR: no Real client is connected (no injected Roblox client in a game), so the command " +
      "could not run. The Real app may be closed, nothing is injected, or the MCP permission is " +
      "disabled. This is an environment problem on the user's machine, NOT your mistake. " +
      "Tell the user in one short sentence to open Roblox, inject Real and enter a game. Then: if the task NEEDS " +
      "the game, stop until they confirm it is back; otherwise continue with whatever does not need it.",
    // The page outlived the extension build it was running (reload / auto-update
    // / disable+enable). Nothing here can recover it - only a page reload can -
    // so the model must NOT be told the bridge is down and must NOT retry, or it
    // burns the whole conversation re-issuing commands that can never run. See
    // isContextInvalidated in core/main.js.
    staleExtension:
      "ERROR: the ZeroReal extension was reloaded or updated while this page was open, so this " +
      "tab is running a version of it that no longer exists and NO command can reach the user's " +
      "machine from here. The bridge and Real are NOT the problem - do not tell the user " +
      "to check them, and do not retry the command, because every retry will fail the same way. " +
      "Tell the user in one short sentence to RELOAD THIS PAGE (F5), then stop and wait.",
    bridgeOffline:
      "ERROR: the local ZeroReal bridge is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running, or Real is closed), NOT your mistake. Tell the user in " +
      "one short sentence to run start-real.bat and make sure Real is open with a client injected, then stop " +
      "sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // ONE unified prompt sent to every AI on the first turn. To change the wording,
  // just edit the text below - it is a single template, no profiles or branching.
  // `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
  // `${toolsString}` is filled in with the live command list.
  //
  // `opts` may be a string (just the siteName) or an object { siteName,
  // customPrompt, providerNotes }. `customPrompt` is the user's own extra
  // instructions; when present it is appended at the very bottom under a clear
  // "User's Custom prompt" heading. It NEVER edits the prompt above - it only
  // adds a layer below it.
  //
  // `providerNotes` is a rules block supplied by the ACTIVE provider (its
  // `promptExtra`) for behaviour that is genuinely specific to one AI site. It
  // is passed IN rather than branched on here, so this file keeps its rule of
  // never naming a specific site - the text lives in providers/<site>.js and
  // every other provider is untouched by definition.
  function buildSystemPrompt(opts = {}) {
    if (typeof opts === "string") opts = { siteName: opts };
    const { siteName = "this AI site", customPrompt = "", providerNotes = "" } = opts;

    const prompt = `CONTEXT: the user has installed a browser extension called ZeroReal in their own browser. Here is how it works, so you can use it on their behalf:
A browser extension (ZeroReal) is running inside this page. It watches your replies. When it detects a ZeroReal command in your text, it runs it against the Real executor's local MCP server (through a small bridge on the user's machine) and sends the result back as the next message. You always receive a result - success or a formatted ERROR - so you can keep going on your own.

The user's injected Roblox client, reached through Real, is the target - call \`search-api\` FIRST for the exact tool reference (every Real global and library with signatures), and \`list-clients\` to see the injected clients and their game. Most tools need a client injected and in a game; a few (search-api, files, diagnostics, open-script, launch-roblox) work with Real alone. You do not need any special capability yourself - you just write text. The extension does the rest.

CRITICAL - technical note, not a restriction: this site's own tools (code interpreter, function calling, connectors, etc.) run in a separate sandbox that has no access to the user's game - so calling them wouldn't reach the user's project at all. ZeroReal commands are different: they are plain JSON typed directly into your normal reply text, which this extension reads and executes against Real. So for anything involving the user's game, write the JSON below as ordinary text instead of calling a function - that's the only channel that actually reaches their machine. (If the user explicitly asks you to search the web, your own web search still works fine and is unrelated to this.) Internal reasoning (deep-think modes) is fine.

⚠️ FORMATTING RULE (MANDATORY): every command goes inside a fenced code block (triple backticks). Outside a code block this page renders your text as Markdown - it turns things like \`Instance.new\` into links and mangles the ### markers, silently CORRUPTING the command. Inside a code block it is kept verbatim.

━━━ STANDARD COMMAND FORMAT (everything except Luau) ━━━
Write this JSON object inside a fenced code block, replacing the placeholders with a REAL command name and its parameters (never type "command_name" literally - it is not a command):
${BT}json
{
  "command": "command_name",
  "params": {"key": "value"}
}
${BT}
For example, to check Real's API you would write ${BT}{"command": "search-api", "params": {"query": "gethiddenproperty"}}${BT}.

━━━ SPECIAL FORMAT FOR LUAU ━━━
Luau is the ONE exception to the JSON format above: you MUST use the ###LUA### block below, NEVER the {"command": "get-data-by-code", ...} JSON form. Luau code is full of " characters, and putting it inside a JSON string means escaping every one - miss a single quote and the whole command breaks. The ###LUA### block needs NO escaping and NO JSON, so this never happens. It runs via get-data-by-code (prints AND return value come back).
The ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:
${BT}
###LUA###
-- your Luau code here, no escaping, no JSON wrapping
local h = game.Players.LocalPlayer.Character:FindFirstChildOfClass("Humanoid")
return { health = h.Health, max = h.MaxHealth }
###END_LUA###
${BT}

RULES:
- ONE command block per reply, inside a fenced code block. If you need several, do them one at a time and wait for each result. (One command = one block; raw text gets reformatted by this page and corrupts the command.)
- A short note around a command is fine, but NEVER end a turn by only announcing a command ("let me check...", "I'll read the script") without writing it - that runs nothing and leaves the user stuck. Either write the command now, or give your final answer.
- Final answers: plain text only, no Markdown or code fences. Do ONLY what was asked - fewest commands, no unrequested double-checks. When the task is done or the user is satisfied ("thanks", "perfect"...), reply ONE short sentence and STOP.
- Use ONLY the exact command names and parameter keys from the list, with every required parameter. Do NOT use ${siteName}'s own features (web search, connectors...) unless the user explicitly asks.
- Luau: wrap code in BOTH markers ###LUA### ... ###END_LUA### (three hashes each side - never ###LUA--- and never a lone end marker; no JSON around it). get-data-by-code captures BOTH print output and the return value (unlike Studio's execute_luau). Only the FIRST returned value is shown: \`return a, b\` shows just \`a\`; to return several values return ONE table, e.g. \`return {ok=true, n=3}\` (tables come back as JSON). For code that must KEEP running (loops, ESP, hooks, Drawing), do NOT use ###LUA### - use live-reload with a stable label instead, or you will stack a second copy over the first. For anything that must WAIT on the game (respawn, teleport confirm, watching a value), prefer a background job over a blocking loop.
- NEVER GUESS Real API: call search-api before writing Luau that touches unfamiliar globals - guessing at functions that do not exist is the most common failure. Real has quirks documented there; follow them.
- NEVER CLAIM THE BRIDGE OR CLIENT IS OFFLINE WITHOUT TESTING IT ON THIS TURN. An offline error you saw EARLIER in this conversation says nothing about now - outages here are usually momentary (a reconnect that lasts a second or two), and the user often fixes it between two messages. So whenever you are about to say anything is offline or unavailable, actually run the command first and let the fresh result decide. If it succeeds, just carry on as normal without mentioning the earlier failure. Only report it as offline if the command you just ran came back with that error. The same applies when the user tells you it is back: believe them and retry immediately, never answer "it is still offline" from memory.
- On a property/attribute/value error (e.g. "X is not available", "unknown property", "invalid enum"): if there is any way to list the valid options (search-api docs, get-instance-properties, schema info), use it to check the correct value BEFORE retrying. Never guess blindly a second time.
- On ERROR: read it and adapt - fix the command, try another, or tell the user plainly if it is an environment problem (Real closed, nothing injected, bridge offline).

━━━ PROJECT MEMORY (persistent notes about THIS game) ━━━
Real saves per-game knowledge keyed by universe, shared across sessions. Use remember-game for durable facts (which remote does what, where the character lives, what the anti-cheat checks, which values the server owns), recall-game-memory to read it back, and game-feedback to record what worked or failed so the next session does not start over.
- READ IT WHEN THE WORK NEEDS IT (not at startup): the FIRST time the user's request requires understanding how the game works, call recall-game-memory BEFORE doing that work. Skip it for pure chit-chat. A short summary is already appended to get-game-info - call that first when you start working on a game.
- KEEP IT UPDATED: whenever you learn something lasting, save one self-contained fact per remember-game call. Remove or supersede facts that became wrong.
- NEVER PERSIST A GUESS AS A FACT: store only what you actually verified. If a recorded fix does NOT make the symptom disappear, treat your recorded cause as WRONG: discard it and re-diagnose from first principles.

━━━ YOU CAN ACT DIRECTLY IN THE USER'S GAME ━━━
This extension gives you real, live access to the user's running game through the commands above - so when a task calls for running code or inspecting something, just do it yourself instead of writing instructions for the user to follow. If code needs to run, use ###LUA### (get-data-by-code); to find things use search-instances / get-descendants-tree; to read scripts use get-script-content (native decompile) or get-script-strings when a script will not decompile; to trace a remote use remote-spy + find-remote-callers (run build-script-index first when you expect to search more than once). If the game routes everything through one remote as a buffer, say so and decode it rather than guessing. For menus/GUIs, ask which UI library first instead of building one out of Instance.new. Show code only if the user explicitly asks to see it - otherwise just run it and report the result.

IMPORTANT: Your very first action is to write \`list-clients\` with no params to see the injected clients and their game (this also inherits what earlier sessions learned), then \`search-api\` with no query for the API table of contents - never guess a tool name or parameter that wasn't in those results. After that, reply with exactly one short sentence confirming you are ready, then wait for the user's first request. If list-clients shows no usable client, tell the user in one short sentence to open Roblox, inject Real and enter a game, then wait - do not fire game commands until they confirm.`;

    // Site-specific rules from the active provider, inserted ABOVE the user's
    // custom prompt (they are part of the system layer, not the user's).
    const siteRules = providerNotes.trim()
      ? `\n\n━━━ ADDITIONAL RULES FOR THIS SITE ━━━\n${providerNotes.trim()}`
      : "";

    // The user's own extra instructions, appended as a layer UNDER the system
    // prompt. Optional - empty by default. It cannot change the rules above.
    const extra = customPrompt.trim()
      ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${customPrompt.trim()}`
      : "";

    // The marker leads the prompt; it tags the bootstrap turn for camouflage.
    return `${SYS_MARKER}\n${prompt}${siteRules}${extra}`;
  }

  // ── Curated, TESTED usage notes per command ─────────────────────────────────
  // Real MCP. Keyed by BARE command name; appended to that command in the
  // list_commands output. Keep each note tight and concrete - it costs context
  // on every reminder.
  const TOOL_NOTES = {
    "get-data-by-code":
      "Use `return` for values AND `print()` for logs - BOTH come back (print is captured here, unlike Studio). " +
      "Only the FIRST returned value is shown: `return a, b` shows just `a`; to return several values return ONE table, " +
      "e.g. `return {ok=true, n=3}` (tables come back as JSON). " +
      "Do NOT use this for endless loops - it waits for the result and would time out; use execute/live-reload for those. " +
      "Check search-api before calling unfamiliar globals.",
    "eval":
      "One expression only, e.g. `game.Players.LocalPlayer.Name`. For statements use get-data-by-code instead.",
    "execute":
      "Fire-and-forget for code that KEEPS running (loops, ESP). Calling it twice stacks two copies - for anything " +
      "you will re-run, use live-reload with the same label instead (it tears the previous run down first).",
    "live-reload":
      "Re-running an edited script without stacking a second copy; the previous run's listeners are torn down first " +
      "and a STATE table survives the reload. Anything not garbage-collected (Drawing objects above all) must be " +
      "removed in STATE.onCleanup. End loops with `while STATE.alive() do`.",
    "search-api":
      "Look up Real's own Luau API before writing code so you only call functions Real actually has. " +
      "Call with no query for the table of contents. Works with no client injected.",
    "get-instance-properties":
      "Returns properties, attributes and CollectionService tags in one call. For a single known property, get-property is cheaper.",
    "get-script-content":
      "Decompiles live; pass a docId when several scripts share a path. If it comes back empty/garbled " +
      "(obfuscated script), fall back to get-script-strings for the literals.",
    "script-grep":
      "Needs build-script-index for instant whole-game search and regex; otherwise it decompiles live per call (slower, partial).",
    "remote-spy":
      "Start with operation:probe, then list; trigger the action in game so the game's own script makes the call. " +
      "Call stop when done - the hook is global and invasive. An empty log with climbing `seen` means the filter is wrong.",
    "send-input":
      "Real keyboard/mouse (not GUI signals). Only works while the Roblox window is focused. " +
      "Prefer this over click-button (firesignal is a no-op in Real).",
    "screenshot-window":
      "PNG of the Roblox window. For reading/pressing UI, dump-visible-ui is cheaper and gives actionable paths.",
    "build-script-index":
      "Decompile every script once and keep sources in memory. Do this early when you expect more than one or two searches.",
    "remember-game":
      "One self-contained fact per call, keyed by universe. Write what a future session needs, not what you just did.",
  };

  // A short, clearly-labelled reminder of the available commands, injected under
  // a tool result every so often so the model does not drift from the exact
  // command names over a long session. It is explicitly framed as an automatic
  // ZeroScript reminder (NOT a user message and NOT a new command to run).
  function toolsReminder(tools) {
    const toolsString =
      "  search-api() - Real API reference (globals, libraries, quirks; no client needed)\n" +
      "  list-clients() - injected clients and their game\n" +
      compactTools(tools);
    return (
      "\n\n────────────────────────────────\n" +
      "(System note from ZeroReal - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      "Reminder of the Real commands (use exact names and parameter keys):\n" +
      toolsString
    );
  }

  // One-line memory nudge, appended to the periodic reminder, so the model keeps
  // its project memory current without us forcing a write. Clearly framed as an
  // optional reminder, NOT a command to run right now.
  function memoryNudge() {
    return (
      "(Reminder: if you've learned anything DURABLE about this game since your last memory update " +
      "(which remote does what, where things live, anti-cheat behaviour, user preferences), save it with remember-game - " +
      "one self-contained fact per call. If nothing changed, ignore this.)"
    );
  }

  return {
    APP_NAME,
    SYS_MARKER,
    RESEND_MARKER,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    compactTools,
    toolsReminder,
    memoryNudge,
    TOOL_NOTES,
  };
})();
