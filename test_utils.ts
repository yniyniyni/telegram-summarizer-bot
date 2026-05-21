import assert from 'assert';
import { escapeHTML, sanitizeHTML, convertMarkdownToHTML, isChatAuthorized, isRateLimited, resetRateLimits, splitHTMLText, log, safeErrorForLog } from './utils.js';

function validateChunks(chunks: string[], maxLength: number): void {
  const allowedTags = new Set(['b', 'i', 'code', 'pre']);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= maxLength, `Chunk length ${chunk.length} exceeds max length ${maxLength}`);
    const tags = chunk.match(/<\/?[a-zA-Z0-9]+>/g) || [];
    const stack: string[] = [];
    for (const tag of tags) {
      const match = tag.match(/^<\/?([a-zA-Z0-9]+)>/);
      if (!match) continue;
      const tagName = match[1].toLowerCase();
      if (!allowedTags.has(tagName)) {
        throw new Error(`Unexpected tag found: ${tag}`);
      }
      const isClose = tag.startsWith('</');
      if (isClose) {
        const last = stack.pop();
        assert.strictEqual(last, tagName, `Mismatched closing tag in chunk "${chunk}": expected </${last}> but got ${tag}`);
      } else {
        stack.push(tagName);
      }
    }
    assert.strictEqual(stack.length, 0, `Unclosed tags at the end of chunk "${chunk}": ${stack.join(', ')}`);
  }
}

function runTests(): void {
  console.log("Starting utility tests...");

  // 1. Test escapeHTML
  console.log("Testing escapeHTML...");
  assert.strictEqual(escapeHTML("hello & world"), "hello &amp; world");
  assert.strictEqual(escapeHTML("3 < 5"), "3 &lt; 5");
  assert.strictEqual(escapeHTML("5 > 3"), "5 &gt; 3");
  assert.strictEqual(escapeHTML("<html>"), "&lt;html&gt;");
  assert.strictEqual(escapeHTML(""), "");
  assert.strictEqual(escapeHTML("plain text"), "plain text");
  console.log("  Passed escapeHTML tests.");

  // 2. Test sanitizeHTML
  console.log("Testing sanitizeHTML...");
  assert.strictEqual(sanitizeHTML("<b>bold</b>"), "<b>bold</b>");
  assert.strictEqual(sanitizeHTML("<i>italic</i>"), "<i>italic</i>");
  assert.strictEqual(sanitizeHTML("<code>code</code>"), "<code>code</code>");
  assert.strictEqual(sanitizeHTML("<pre>pre</pre>"), "<pre>pre</pre>");

  assert.strictEqual(sanitizeHTML("<B>bold</B>"), "<b>bold</b>");
  assert.strictEqual(sanitizeHTML("<i class='test'>italic</i>"), "<i>italic</i>");
  assert.strictEqual(sanitizeHTML("<CODE id=\"mycode\">code</CODE>"), "<code>code</code>");

  assert.strictEqual(
    sanitizeHTML("<script>alert(1)</script>"), 
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );
  assert.strictEqual(
    sanitizeHTML("<div>test</div>"), 
    "&lt;div&gt;test&lt;/div&gt;"
  );

  assert.strictEqual(
    sanitizeHTML("me & you <b>us</b>"), 
    "me &amp; you <b>us</b>"
  );
  assert.strictEqual(
    sanitizeHTML("x < y and y > z <i>comparison</i>"), 
    "x &lt; y and y &gt; z <i>comparison</i>"
  );

  assert.strictEqual(sanitizeHTML("hello <b tag"), "hello &lt;b tag");
  assert.strictEqual(sanitizeHTML("<>"), "&lt;&gt;");
  assert.strictEqual(sanitizeHTML("</>"), "&lt;/&gt;");
  assert.strictEqual(sanitizeHTML("<123>"), "&lt;123&gt;");

  // Test unclosed tags are closed
  assert.strictEqual(sanitizeHTML("<b>x"), "<b>x</b>");
  assert.strictEqual(sanitizeHTML("<b><i>x"), "<b><i>x</i></b>");

  console.log("  Passed sanitizeHTML tests.");

  // 3. Test isChatAuthorized
  console.log("Testing isChatAuthorized...");
  const origAllowedChats = process.env.ALLOWED_CHATS;
  const origAllowAllChats = process.env.ALLOW_ALL_CHATS;

  try {
    // Unset ALLOWED_CHATS, no ALLOW_ALL_CHATS (should be false)
    delete process.env.ALLOWED_CHATS;
    delete process.env.ALLOW_ALL_CHATS;
    assert.strictEqual(isChatAuthorized(123), false);
    assert.strictEqual(isChatAuthorized(-100123), false);

    // Empty ALLOWED_CHATS (should be false)
    process.env.ALLOWED_CHATS = "";
    assert.strictEqual(isChatAuthorized(123), false);

    // ALLOW_ALL_CHATS=true (should be true)
    process.env.ALLOW_ALL_CHATS = "true";
    assert.strictEqual(isChatAuthorized(123), true);
    assert.strictEqual(isChatAuthorized(999), true);

    // ALLOW_ALL_CHATS=true even if ALLOWED_CHATS is set (should be true)
    process.env.ALLOWED_CHATS = "123";
    assert.strictEqual(isChatAuthorized(999), true);

    // Valid ALLOWED_CHATS (should match whitelist) when ALLOW_ALL_CHATS !== 'true'
    delete process.env.ALLOW_ALL_CHATS;
    process.env.ALLOWED_CHATS = "123, -100456, 789";
    assert.strictEqual(isChatAuthorized(123), true);
    assert.strictEqual(isChatAuthorized(-100456), true);
    assert.strictEqual(isChatAuthorized(789), true);
    assert.strictEqual(isChatAuthorized(999), false);
    assert.strictEqual(isChatAuthorized(-100123), false);

    // Invalid elements in ALLOWED_CHATS list (like non-numeric strings)
    process.env.ALLOWED_CHATS = "123, abc, 789, def";
    assert.strictEqual(isChatAuthorized(123), true);
    assert.strictEqual(isChatAuthorized(789), true);
    assert.strictEqual(isChatAuthorized(999), false);
  } finally {
    if (origAllowedChats === undefined) {
      delete process.env.ALLOWED_CHATS;
    } else {
      process.env.ALLOWED_CHATS = origAllowedChats;
    }
    if (origAllowAllChats === undefined) {
      delete process.env.ALLOW_ALL_CHATS;
    } else {
      process.env.ALLOW_ALL_CHATS = origAllowAllChats;
    }
  }
  console.log("  Passed isChatAuthorized tests.");

  // 4. Test isRateLimited
  console.log("Testing isRateLimited...");
  // Default disabled
  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  resetRateLimits();
  assert.strictEqual(isRateLimited(111).limited, false);
  assert.strictEqual(isRateLimited(111).limited, false);

  // Enforced limits
  process.env.RATE_LIMIT_MAX_REQUESTS = "2";
  process.env.RATE_LIMIT_WINDOW_SEC = "10";
  resetRateLimits();

  // First 2 requests succeed
  assert.strictEqual(isRateLimited(111).limited, false);
  assert.strictEqual(isRateLimited(111).limited, false);
  // Third request is rate-limited
  const result = isRateLimited(111);
  assert.strictEqual(result.limited, true);
  assert.ok((result.retryAfter || 0) > 0 && (result.retryAfter || 0) <= 10);

  // Other chats are not affected
  assert.strictEqual(isRateLimited(222).limited, false);

  // Reset clears limits
  resetRateLimits();
  assert.strictEqual(isRateLimited(111).limited, false);

  // Invalid configs for isRateLimited
  const origWindow = process.env.RATE_LIMIT_WINDOW_SEC;
  const origMax = process.env.RATE_LIMIT_MAX_REQUESTS;
  try {
    // 1. RATE_LIMIT_MAX_REQUESTS is invalid/NaN (fail-closed)
    process.env.RATE_LIMIT_MAX_REQUESTS = "abc";
    process.env.RATE_LIMIT_WINDOW_SEC = "10";
    resetRateLimits();
    const invalidMaxRes = isRateLimited(111);
    assert.strictEqual(invalidMaxRes.limited, true);
    assert.strictEqual(invalidMaxRes.retryAfter, 3600);

    // 2. RATE_LIMIT_MAX_REQUESTS is negative (fail-closed)
    process.env.RATE_LIMIT_MAX_REQUESTS = "-5";
    resetRateLimits();
    const negativeMaxRes = isRateLimited(111);
    assert.strictEqual(negativeMaxRes.limited, true);
    assert.strictEqual(negativeMaxRes.retryAfter, 3600);

    // 3. RATE_LIMIT_MAX_REQUESTS is "0" (disabled)
    process.env.RATE_LIMIT_MAX_REQUESTS = "0";
    resetRateLimits();
    const zeroMaxRes = isRateLimited(111);
    assert.strictEqual(zeroMaxRes.limited, false);
    assert.strictEqual(isRateLimited(111).limited, false);

    // 4. RATE_LIMIT_WINDOW_SEC is invalid/NaN (fallback to 3600)
    process.env.RATE_LIMIT_MAX_REQUESTS = "1";
    process.env.RATE_LIMIT_WINDOW_SEC = "invalid_window";
    resetRateLimits();
    assert.strictEqual(isRateLimited(111).limited, false);
    const invalidWindowRes = isRateLimited(111);
    assert.strictEqual(invalidWindowRes.limited, true);
    assert.ok(invalidWindowRes.retryAfter && invalidWindowRes.retryAfter > 3500 && invalidWindowRes.retryAfter <= 3600);

    // 5. RATE_LIMIT_WINDOW_SEC is <= 0 (fallback to 3600)
    process.env.RATE_LIMIT_MAX_REQUESTS = "1";
    process.env.RATE_LIMIT_WINDOW_SEC = "-10";
    resetRateLimits();
    assert.strictEqual(isRateLimited(111).limited, false);
    const negativeWindowRes = isRateLimited(111);
    assert.strictEqual(negativeWindowRes.limited, true);
    assert.ok(negativeWindowRes.retryAfter && negativeWindowRes.retryAfter > 3500 && negativeWindowRes.retryAfter <= 3600);

  } finally {
    if (origWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_SEC;
    else process.env.RATE_LIMIT_WINDOW_SEC = origWindow;

    if (origMax === undefined) delete process.env.RATE_LIMIT_MAX_REQUESTS;
    else process.env.RATE_LIMIT_MAX_REQUESTS = origMax;
  }
  console.log("  Passed isRateLimited tests.");

  // Test safeErrorForLog
  console.log("Testing safeErrorForLog...");
  const mockErr = {
    code: 400,
    description: "Bad Request: can't parse entities",
    on: {
      method: "sendMessage",
      payload: {
        chat_id: 123,
        text: "highly sensitive prompt/transcript data that must not leak"
      }
    }
  };
  const loggedErr = safeErrorForLog(mockErr);
  assert.ok(!loggedErr.includes("highly sensitive"));
  assert.ok(!loggedErr.includes("must not leak"));
  assert.ok(loggedErr.includes("400"));
  assert.ok(loggedErr.includes("Bad Request: can't parse entities"));
  assert.ok(loggedErr.includes("sendMessage"));

  // Explicit test for response.parameters (must print parameters but not leak private data)
  const errWithParams = {
    response: {
      error_code: 400,
      description: "Bad Request",
      parameters: { retry_after: 5 }
    }
  };
  const loggedWithParams = safeErrorForLog(errWithParams);
  assert.ok(loggedWithParams.includes("retry_after"));
  assert.ok(loggedWithParams.includes("5"));
  assert.ok(loggedWithParams.includes("Bad Request"));
  assert.ok(!loggedWithParams.includes("private"));

  // Explicit test for on.payload (must NOT leak/print private payload text)
  const errWithPayload = {
    on: {
      method: "sendMessage",
      payload: { text: "private text" }
    }
  };
  const loggedWithPayload = safeErrorForLog(errWithPayload);
  assert.ok(!loggedWithPayload.includes("private text"));
  assert.ok(!loggedWithPayload.includes("payload"));
  assert.ok(loggedWithPayload.includes("sendMessage"));

  // Explicit test for normal Error
  const normalErr = new Error("Something went wrong");
  assert.strictEqual(safeErrorForLog(normalErr), "Something went wrong");

  assert.strictEqual(safeErrorForLog("Simple string error"), "Simple string error");
  console.log("  Passed safeErrorForLog tests.");

  // 5. Test splitHTMLText
  console.log("Testing splitHTMLText...");
  // Plain text splitting
  const plain1 = splitHTMLText("abcdef", 3);
  assert.deepStrictEqual(plain1, ["abc", "def"]);
  validateChunks(plain1, 3);

  const plain2 = splitHTMLText("abcdef", 4);
  assert.deepStrictEqual(plain2, ["abcd", "ef"]);
  validateChunks(plain2, 4);

  // Tag preservation - fits in length
  const tagFit = splitHTMLText("<b>hello</b>", 12);
  assert.deepStrictEqual(tagFit, ["<b>hello</b>"]);
  validateChunks(tagFit, 12);

  // Tag preservation - needs split
  // For '<b>hello world</b>', if maxLength = 15:
  // First chunk: '<b>hello </b>' (14 chars)
  // Second chunk: '<b>world</b>' (12 chars)
  const textToSplit = "<b>hello world</b>";
  const splitChunks = splitHTMLText(textToSplit, 15);
  assert.deepStrictEqual(splitChunks, ["<b>hello </b>", "<b>world</b>"]);
  validateChunks(splitChunks, 15);

  // Test nesting tags preservation
  // '<b><i>nested</i></b>' split at small length
  const nestedText = "<b><i>hello</i> <i>world</i></b>";
  const nestedChunks = splitHTMLText(nestedText, 25);
  // '<b><i>hello</i> </b>' is 19 chars
  // '<b><i>world</i></b>' is 18 chars
  assert.deepStrictEqual(nestedChunks, ["<b><i>hello</i> </b>", "<b><i>world</i></b>"]);
  validateChunks(nestedChunks, 25);

  // Test long text split with tags
  const longTextWithTags = "<code>" + "a".repeat(10) + " " + "b".repeat(10) + "</code>";
  // '<code>aaaaaaaaaa bbbbbbbbbb</code>'
  // Let's split it at maxLength = 22
  // '<code>aaaaaaaaaa </code>' (23 chars) -> wait, 6 (<code>) + 11 (aaaaaaaaaa ) + 7 (</code>) = 24 chars > 22.
  // Let's check with maxLength = 25
  const longSplit = splitHTMLText(longTextWithTags, 25);
  assert.deepStrictEqual(longSplit, [
    "<code>aaaaaaaaaa </code>",
    "<code>bbbbbbbbbb</code>"
  ]);
  validateChunks(longSplit, 25);

  // Regression test: splitHTMLText('<b>'.repeat(1500) + 'x', 4000) must return chunks of length <= 4000
  const deepNestingText = '<b>'.repeat(1500) + 'x';
  const deepNestingChunks = splitHTMLText(deepNestingText, 4000);
  assert.ok(deepNestingChunks.length > 0);
  for (const chunk of deepNestingChunks) {
    assert.ok(chunk.length <= 4000, `Chunk length ${chunk.length} should be <= 4000`);
  }
  assert.deepStrictEqual(deepNestingChunks, ["<b>x</b>"]);
  validateChunks(deepNestingChunks, 4000);

  // Standard nested formatting cases: verifying <b><i>text</i></b> are parsed and split correctly
  const standardNested = "<b><i>hello</i> world</b>";
  const stdNested1 = splitHTMLText(standardNested, 30);
  assert.deepStrictEqual(stdNested1, ["<b><i>hello</i> world</b>"]);
  validateChunks(stdNested1, 30);

  const stdNested2 = splitHTMLText(standardNested, 20);
  assert.deepStrictEqual(stdNested2, ["<b><i>hello</i> </b>", "<b>world</b>"]);
  validateChunks(stdNested2, 20);

  console.log("  Passed splitHTMLText tests.");

  // 6. Test log helper (DEBUG logging filtering)
  console.log("Testing log helper...");
  const originalConsoleLog = console.log;
  let loggedMessages: string[] = [];
  console.log = (...args: any[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    // With DEBUG disabled by default
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
    log("INFO", "Info message test");
    log("DEBUG", "Debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[INFO] Info message test")), "INFO message should be logged");
    assert.ok(!loggedMessages.some(msg => msg.includes("[DEBUG] Debug message test")), "DEBUG message should NOT be logged by default");

    // Clear buffer
    loggedMessages = [];

    // With DEBUG enabled
    process.env.DEBUG = "true";
    log("INFO", "Second info message test");
    log("DEBUG", "Second debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[INFO] Second info message test")), "INFO message should be logged when DEBUG is true");
    assert.ok(loggedMessages.some(msg => msg.includes("[DEBUG] Second debug message test")), "DEBUG message should be logged when DEBUG is true");

    // Clear buffer
    loggedMessages = [];

    // With LOG_LEVEL=debug
    delete process.env.DEBUG;
    process.env.LOG_LEVEL = "debug";
    log("DEBUG", "Third debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[DEBUG] Third debug message test")), "DEBUG message should be logged when LOG_LEVEL is debug");

  } finally {
    // Restore console.log and clean up env vars
    console.log = originalConsoleLog;
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
  }
  console.log("  Passed log helper tests.");

  // 7. Test convertMarkdownToHTML and sanitizeHTML integration
  console.log("Testing convertMarkdownToHTML...");
  assert.strictEqual(convertMarkdownToHTML("### Header"), "<b>Header</b>");
  assert.strictEqual(convertMarkdownToHTML("  ## SubHeader"), "<b>SubHeader</b>");
  assert.strictEqual(convertMarkdownToHTML("# Title"), "<b>Title</b>");
  assert.strictEqual(convertMarkdownToHTML("This is **bold** text."), "This is <b>bold</b> text.");
  assert.strictEqual(convertMarkdownToHTML("This is __bold__ text."), "This is <b>bold</b> text.");
  assert.strictEqual(convertMarkdownToHTML("This is *italic* text."), "This is <i>italic</i> text.");
  assert.strictEqual(convertMarkdownToHTML("This is _italic_ text."), "This is <i>italic</i> text.");
  assert.strictEqual(convertMarkdownToHTML("* List item 1"), "* List item 1");
  assert.strictEqual(convertMarkdownToHTML("- List item 2"), "- List item 2");
  assert.strictEqual(convertMarkdownToHTML("• List item 3"), "• List item 3");
  assert.strictEqual(convertMarkdownToHTML("Run `npm test` now."), "Run <code>npm test</code> now.");
  assert.strictEqual(convertMarkdownToHTML("```\nconst x = 5;\n```"), "<pre>\nconst x = 5;\n</pre>");

  const mdInput = "### Summary\n\n- The code uses `libmosey_daemon_ffi.so` for wonder.\n- Let's check **wonder** interface.\n- <script>alert(1)</script> was typed.";
  const expectedOutput = "<b>Summary</b>\n\n- The code uses <code>libmosey_daemon_ffi.so</code> for wonder.\n- Let's check <b>wonder</b> interface.\n- &lt;script&gt;alert(1)&lt;/script&gt; was typed.";
  assert.strictEqual(sanitizeHTML(mdInput), expectedOutput);
  console.log("  Passed convertMarkdownToHTML tests.");

  console.log("✅ All utility tests passed successfully!");
}

runTests();
